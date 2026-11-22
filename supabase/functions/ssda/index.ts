// SSDA - SlopCloud Song Downloader API
// Supabase Edge Function. Single file.
//
//   GET /api/health                     status
//   GET /api/info?url=<soundcloud-link>  track metadata (JSON)
//   GET /api/audio?url=<link>&format=auto|m4a|mp3|opus   audio bytes
//   GET /api/download?url=<link>         audio bytes as a file download
//
// Audio is passed through without re-encoding whenever possible: quality is
// exactly what the uploader provided. format=auto prefers the progressive mp3
// (smallest standard rendition, plays everywhere), then m4a (AAC/fMP4), then
// opus. HLS output is container-validated before serving: fMP4 and Ogg are
// assembled as-is; MPEG-TS streams are demuxed to ADTS AAC; anything else is
// skipped rather than served broken. DRM-wrapped renditions (cbcs/cenc) are
// skipped when possible; when the artist allows downloads, the official
// download file is served instead.
//
// When an explicit format is requested (mp3/m4a/opus) and SoundCloud has no
// rendition in that format, the best available rendition is decoded and
// re-encoded to the requested format (v2.6.0). Only the requested format
// changes; format=auto is never transcoded.

// The codec packages (several MB with embedded wasm) are imported lazily on
// first conversion, so ordinary requests keep a light, fast cold start.

// Core codecs: decode-aac/decode-mp3 (FAAD2/mpg123 wasm) and encode-mp3/
// encode-mp4 (LAME + FDK wasm). All run in-thread - the @mediabunny/*-encoder
// packages are not used: they encode inside a Web Worker / worker_threads,
// which the Supabase edge runtime stubs out ("Not implemented:
// Worker.prototype.constructor"). The opus encoder loads separately: its
// .wasm import is fragile in some runtimes and must never block mp3/m4a
// conversions.
type WmeMod = typeof import("npm:wasm-media-encoders@0.7.0");
type DecodeAacFn = (typeof import("npm:@audio/decode-aac@1.6.0"))["default"];
type DecodeMp3Fn = (typeof import("npm:@audio/decode-mp3@1.3.1"))["default"];
type EncodeM4aFn = (typeof import("npm:@audio/encode-mp4@1.2.1"))["default"];
type LameMod = typeof import("npm:@breezystack/lamejs@1.2.7");

let decodeAacPromise: Promise<DecodeAacFn> | null = null;
let decodeMp3Promise: Promise<DecodeMp3Fn> | null = null;
let encodeM4aPromise: Promise<EncodeM4aFn> | null = null;
let wmePromise: Promise<WmeMod> | null = null;
let mp3WasmPromise: Promise<Uint8Array> | null = null;
let lamePromise: Promise<LameMod> | null = null;
let opusPromise: Promise<{ Wme: WmeMod["WasmMediaEncoder"]; oggWasm: Uint8Array }> | null = null;

/**
 * Some runtimes define WebCodecs stubs whose methods throw "Not implemented"
 * or return promises that never settle (the request then hangs until the
 * platform kills the worker). The encoder packages prefer WebCodecs and would
 * die or hang on such a stub. We never need WebCodecs - the wasm paths are
 * complete - so simply remove any AudioEncoder before loading encoders.
 */
function stripBrokenWebCodecs(): void {
  const g = globalThis as Record<string, unknown>;
  if (typeof g.AudioEncoder !== "undefined") delete g.AudioEncoder;
}

// Per-target lazy loaders: a mp3 conversion must never compile the FDK/FLAC
// wasm graph that encode-mp4 drags in (memory ceiling), and vice versa.
function loadDecodeAac() {
  decodeAacPromise ??= import("npm:@audio/decode-aac@1.6.0")
    .then((m) => m.default)
    .catch((err) => {
      decodeAacPromise = null;
      throw err;
    });
  return decodeAacPromise;
}

function loadDecodeMp3() {
  decodeMp3Promise ??= import("npm:@audio/decode-mp3@1.3.1")
    .then((m) => m.default)
    .catch((err) => {
      decodeMp3Promise = null;
      throw err;
    });
  return decodeMp3Promise;
}

function loadWme() {
  wmePromise ??= import("npm:wasm-media-encoders@0.7.0").catch((err) => {
    wmePromise = null;
    throw err;
  });
  return wmePromise;
}

/**
 * wasm-media-encoders' mp3.wasm/ogg.wasm declare a 2 GB maximum linear
 * memory. Some edge runtimes count that reservation against the worker's
 * memory limit and kill the request before a single frame is encoded
 * (WORKER_RESOURCE_LIMIT). The encoders only need tens of MB, so rewrite the
 * declared maximum to 64 MB before instantiating.
 */
function patchWasmMemoryMax(bytes: Uint8Array, maxPages: number): Uint8Array {
  const leb = (v: number): number[] => {
    const out: number[] = [];
    do {
      let byte = v & 0x7f;
      v >>>= 7;
      if (v) byte |= 0x80;
      out.push(byte);
    } while (v);
    return out;
  };
  const parts: Uint8Array[] = [bytes.slice(0, 8)];
  let p = 8;
  while (p < bytes.length) {
    const id = bytes[p];
    p++;
    let size = 0;
    let shift = 0;
    let b = 0;
    do {
      b = bytes[p++];
      size |= (b & 0x7f) << shift;
      shift += 7;
    } while (b & 0x80);
    const body = bytes.subarray(p, p + size);
    if (id === 5 && body.length > 2) {
      // Memory section: rebuild the entry with a smaller max
      const q: number[] = [body[0]]; // memory count (LEB, single byte in practice)
      let i = 1;
      const flags = body[i];
      q.push(flags);
      i++;
      const readLebBytes = (): number[] => {
        const start = i;
        let bb = 0;
        do {
          bb = body[i++];
        } while (bb & 0x80);
        return Array.from(body.subarray(start, i));
      };
      q.push(...readLebBytes()); // min
      if (flags & 1) {
        readLebBytes(); // drop the old max
        q.push(...leb(maxPages));
      }
      const newBody = Uint8Array.from(q);
      parts.push(Uint8Array.of(id), Uint8Array.from(leb(newBody.length)), newBody);
    } else {
      parts.push(Uint8Array.of(id), Uint8Array.from(leb(size)), body);
    }
    p += size;
  }
  return concatBytes(parts);
}

/** wasm bytes: import attribute first, then public npm CDNs; patched memory. */
async function loadWasmFile(name: "mp3" | "ogg"): Promise<Uint8Array | null> {
  let bytes: Uint8Array | null = null;
  try {
    const m = await import(`npm:wasm-media-encoders@0.7.0/wasm/${name}.wasm`, { with: { type: "bytes" } });
    const b = (m as { default?: unknown }).default ?? m;
    if (b instanceof Uint8Array && b.length > 1000) bytes = b;
  } catch {
    // some runtimes ignore the bytes attribute and try to parse the wasm as
    // JS; fall back to fetching the file
  }
  if (!bytes) {
    for (const url of [
      `https://cdn.jsdelivr.net/npm/wasm-media-encoders@0.7.0/wasm/${name}.wasm`,
      `https://unpkg.com/wasm-media-encoders@0.7.0/wasm/${name}.wasm`,
    ]) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
        if (res.ok) {
          const b = new Uint8Array(await res.arrayBuffer());
          // \0asm magic
          if (b.length > 1000 && b[0] === 0x00 && b[1] === 0x61 && b[2] === 0x73 && b[3] === 0x6d) {
            bytes = b;
            break;
          }
        }
      } catch {
        // try the next source
      }
    }
  }
  return bytes ? patchWasmMemoryMax(bytes, 1024) : null; // 64 MB max
}

function loadMp3Wasm() {
  mp3WasmPromise ??= (async () => {
    const b = await loadWasmFile("mp3");
    if (!b) {
      throw new ApiError(503, "codec_unavailable", "The mp3 encoder could not be loaded right now. Try format=auto.");
    }
    return b;
  })().catch((err) => {
    mp3WasmPromise = null;
    throw err;
  });
  return mp3WasmPromise;
}

/** Pure-JS LAME (no wasm): mp3 encoding must stay wasm-free on this platform. */
function loadLame() {
  lamePromise ??= import("npm:@breezystack/lamejs@1.2.7").catch((err) => {
    lamePromise = null;
    throw err;
  });
  return lamePromise;
}

function loadEncodeM4a() {
  encodeM4aPromise ??= (async () => {
    await stripBrokenWebCodecs();
    return (await import("npm:@audio/encode-mp4@1.2.1")).default;
  })().catch((err) => {
    encodeM4aPromise = null;
    throw err;
  });
  return encodeM4aPromise;
}

/** ogg.wasm bytes: import attribute first, then public npm CDNs. */
async function loadOggWasm(): Promise<Uint8Array | null> {
  return await loadWasmFile("ogg");
}

function loadOpusEncoder() {
  opusPromise ??= (async () => {
    const wme = await import("npm:wasm-media-encoders@0.7.0");
    const oggWasm = await loadOggWasm();
    if (!oggWasm) {
      throw new ApiError(503, "codec_unavailable", "The opus encoder could not be loaded right now. Try format=mp3 or format=auto.");
    }
    return { Wme: wme.WasmMediaEncoder, oggWasm };
  })().catch((err) => {
    opusPromise = null; // allow a retry on the next request
    throw err;
  });
  return opusPromise;
}

const SERVICE_NAME = "SSDA";
const VERSION = "2.9.0";
// SoundCloud's anti-abuse hard-404s requests that impersonate desktop
// browsers from datacenter IPs; a plain self-identifying UA passes. Keep a
// browser-like UA only for fetching SoundCloud's own HTML/JS bundles.
const UA = "SlopCloud-SSDA/2.7";
const PAGE_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const ALLOWED_HOSTS = new Set([
  "soundcloud.com",
  "www.soundcloud.com",
  "m.soundcloud.com",
  "on.soundcloud.com",
  "snd.sc",
]);

const FORMATS = ["auto", "m4a", "mp3", "opus"];

// ---- chunked conversion ----------------------------------------------------
// This platform caps per-request compute: full-track conversions die with
// WORKER_RESOURCE_LIMIT (measured: even a 35 s track does not fit). Long
// tracks are therefore converted in time chunks that clients concatenate:
// GET ...&format=mp3&chunk=info  -> how many chunks (JSON)
// GET ...&format=mp3&chunk=N     -> chunk N (valid partial mp3/opus; append
//                                   them in order to get the full file)
// GET ...&format=mp3&chunk=all   -> the whole file in one response, assembled
//                                   from the server-side chunk cache (409 with
//                                   a missing[] list until the chunks exist)
// Single-request conversion stays available for tracks up to
// SINGLE_CONVERT_MAX_MS; format=auto is passthrough and never chunked.
const SINGLE_CONVERT_MAX_MS = 25000;
const CHUNK_SECONDS = 10;

class ApiError extends Error {
  status: number;
  code: string;
  /** Honored Retry-After hint in seconds, echoed to clients on 429/502. */
  retryAfter?: number;
  /** Extra machine-readable fields merged into the error JSON (e.g. missing[]). */
  details?: Record<string, unknown>;
  constructor(
    status: number,
    code: string,
    message: string,
    retryAfter?: number,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
    this.details = details;
  }
}

// ---------------------------------------------------------------- responses

function corsHeaders(): Headers {
  const h = new Headers();
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  h.set("Access-Control-Allow-Headers", "Range, Content-Type");
  h.set(
    "Access-Control-Expose-Headers",
    "Content-Length, Content-Disposition, X-SSDA-Extension, X-SSDA-Format-Note, " +
    "X-SSDA-Chunk-Index, X-SSDA-Chunk-Count, X-SSDA-Cache, Retry-After",
  );
  return h;
}

function jsonResponse(data: unknown, status = 200): Response {
  const h = corsHeaders();
  h.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { status, headers: h });
}

function errorResponse(err: ApiError): Response {
  const body: Record<string, unknown> = { code: err.code, message: err.message };
  if (err.retryAfter && err.retryAfter > 0) body.retry_after_seconds = Math.ceil(err.retryAfter);
  if (err.details) Object.assign(body, err.details);
  const res = jsonResponse({ error: body }, err.status);
  if (err.retryAfter && err.retryAfter > 0) {
    res.headers.set("Retry-After", String(Math.ceil(err.retryAfter)));
  }
  return res;
}

function serviceIndex() {
  return {
    name: SERVICE_NAME,
    description:
      "SoundCloud song downloader API. Pass a track link to /api/audio and get the audio bytes back.",
    version: VERSION,
    endpoints: {
      "/api/health": "GET - status",
      "/api/info": "GET - ?url=<soundcloud-link> track metadata",
      "/api/audio": "GET - ?url=<soundcloud-link>&format=auto|m4a|mp3|opus audio bytes (add &chunk=info|N|all for long-track chunked conversion)",
      "/api/download": "GET - same as /api/audio but saved as a file",
    },
  };
}

// ---------------------------------------------------------------- helpers

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** One clean line, no internal file paths — safe to show API clients. */
function cleanMessage(msg: string): string {
  return msg
    .replace(/file:\/\/\/\S+/g, "an internal file")
    .replace(/\/var\/tmp\/\S+/g, "an internal file")
    .split("\n")[0]
    .slice(0, 160);
}

function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  return (cleaned || "track").slice(0, 120);
}

function validateSoundcloudUrl(raw: string): string {
  const url = (raw || "").trim();
  if (!url) {
    throw new ApiError(400, "missing_url", "Pass a SoundCloud track link in the url= parameter.");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ApiError(400, "invalid_url", "url must be a valid http(s) URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ApiError(400, "invalid_url", "url must start with http:// or https://");
  }
  if (!ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new ApiError(
      400,
      "invalid_url",
      "url host must be a SoundCloud domain (soundcloud.com, on.soundcloud.com, snd.sc).",
    );
  }
  if (parsed.username || parsed.password || (parsed.port && parsed.port !== "80" && parsed.port !== "443")) {
    throw new ApiError(400, "invalid_url", "url must not contain credentials or a custom port.");
  }
  return url;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

async function fetchBytes(url: string, tries = 3): Promise<Uint8Array> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      lastErr = err;
      if (i < tries - 1) await sleep(250 * (i + 1));
    }
  }
  throw lastErr;
}

function ascii(b: Uint8Array, from: number, to: number): string {
  return String.fromCharCode(...b.slice(from, to));
}

function hexPreview(bytes: Uint8Array, n = 24): string {
  return Array.from(bytes.slice(0, n)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Resolved media URL for a candidate (used by diagnostics only). */
async function streamUrlOf(track: ScTrack, cand: Candidate): Promise<string | null> {
  try {
    return await getStreamUrl(cand.transcoding, track);
  } catch {
    return null;
  }
}

/** Container sniffing from leading bytes of a segment / file. */
function containerOf(bytes: Uint8Array): "fmp4" | "ogg" | "ts" | "mp3" | "wav" | "flac" | "unknown" {
  if (bytes.length >= 12 && ascii(bytes, 4, 8) === "ftyp") return "fmp4";
  // HLS fMP4 segments start with styp/sidx/moof instead of ftyp
  if (bytes.length >= 8 && (ascii(bytes, 4, 8) === "styp" || ascii(bytes, 4, 8) === "sidx" || ascii(bytes, 4, 8) === "moof")) return "fmp4";
  if (bytes.length >= 4 && ascii(bytes, 0, 4) === "OggS") return "ogg";
  if (bytes.length >= 189 && bytes[0] === 0x47 && bytes[188] === 0x47) return "ts";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WAVE") return "wav";
  if (bytes.length >= 4 && ascii(bytes, 0, 4) === "fLaC") return "flac";
  if (bytes.length >= 3 && (ascii(bytes, 0, 3) === "ID3" || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0))) return "mp3";
  return "unknown";
}

const CONTAINER_OUT: Record<string, { ext: string; mime: string }> = {
  mp3: { ext: "mp3", mime: "audio/mpeg" },
  fmp4: { ext: "m4a", mime: "audio/mp4" },
  ogg: { ext: "opus", mime: "audio/ogg" },
  wav: { ext: "wav", mime: "audio/wav" },
  flac: { ext: "flac", mime: "audio/flac" },
};

// ---------------------------------------------------------------- client_id

// ---------------------------------------------------------- response cache
// Server-side cache (Postgres table ssda_cache via PostgREST) so repeat
// requests never hit SoundCloud twice: converted chunks, whole files, and tiny
// JSON meta rows (chunk counts, response headers). This is how the big
// downloader sites feel instant: convert once, serve from storage after that.
// Disabled (pure pass-through) when SUPABASE_URL / SERVICE_ROLE_KEY are absent
// - e.g. local tests unless a test opts in.
const CACHE_VER = "c1";

function envOf(name: string): string | undefined {
  try {
    const d = (globalThis as { Deno?: { env?: { get?: (n: string) => string | undefined } } }).Deno;
    const v = d?.env?.get?.(name);
    if (v) return v;
  } catch { /* not Deno */ }
  try {
    const p = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    return p?.env?.[name];
  } catch { /* no process */ }
  return undefined;
}

function cacheBase(): { url: string; key: string } | null {
  const url = envOf("SUPABASE_URL");
  const key = envOf("SUPABASE_SERVICE_ROLE_KEY");
  return url && key ? { url: url.replace(/\/$/, ""), key } : null;
}

function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Accept bytea as base64 (aeson default) or as PostgreSQL hex ('\x...'). */
function decodeCacheBlob(s: string): Uint8Array {
  if (s.startsWith("\\x") || s.startsWith("0x")) {
    const hex = s.slice(2);
    const out = new Uint8Array(hex.length >> 1);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  return b64decode(s);
}

function chunkMetaKey(trackId: string | number, fmt: string): string {
  return `${CACHE_VER}:cm:${trackId}:${fmt}`;
}
function chunkKey(trackId: string | number, fmt: string, idx: number): string {
  return `${CACHE_VER}:ck:${trackId}:${fmt}:${idx}`;
}
function fullMetaKey(trackId: string | number, fmt: string): string {
  return `${CACHE_VER}:fm:${trackId}:${fmt}`;
}
function fullKey(trackId: string | number, fmt: string): string {
  return `${CACHE_VER}:f:${trackId}:${fmt}`;
}

function metaJsonBytes(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

function parseMetaJson(raw: Uint8Array | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(new TextDecoder().decode(raw));
    return v && typeof v === "object" ? v as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function cacheGetMany(keys: string[]): Promise<Map<string, Uint8Array>> {
  const base = cacheBase();
  const out = new Map<string, Uint8Array>();
  if (!base || keys.length === 0) return out;
  try {
    // One eq. lookup per key. Keys are URL-safe by construction (letters,
    // digits, ':', '-'), so the value is sent raw: PostgREST filter parsing is
    // unreliable with percent-encoded values in some deployments.
    const results = await Promise.all(keys.map(async (key) => {
      try {
        const res = await fetch(
          `${base.url}/rest/v1/ssda_cache?select=cache_key,data&cache_key=eq.${key}`,
          {
            headers: { apikey: base.key, Authorization: `Bearer ${base.key}` },
            signal: AbortSignal.timeout(10000),
          },
        );
        if (!res.ok) {
          cacheNoteError("cache-get", `HTTP ${res.status}`);
          return null;
        }
        const rows = await res.json();
        const row = Array.isArray(rows) ? rows[0] : null;
        return row && typeof row.data === "string" ? [key, decodeCacheBlob(row.data)] as const : null;
      } catch (err) {
        cacheNoteError("cache-get", err instanceof Error ? err.message : String(err));
        return null;
      }
    }));
    for (const r of results) {
      if (r) out.set(r[0], r[1]);
    }
  } catch {
    // cache trouble must never break serving
  }
  return out;
}

let cacheSets = 0;
let cacheLastError: string | null = null;
function cacheNoteError(where: string, detail: string): void {
  cacheLastError = `${where}: ${detail}`.slice(0, 120);
}
async function cacheSet(key: string, data: Uint8Array): Promise<void> {
  const base = cacheBase();
  if (!base) return;
  try {
    // bytea travels through PostgREST as a text value; the '\\x' hex input
    // form makes Postgres store the RAW bytes (a base64 string would land as
    // its literal text via the escape-format cast - reads then see garbage).
    let hex = "";
    for (let i = 0; i < data.length; i++) hex += data[i].toString(16).padStart(2, "0");
    await fetch(`${base.url}/rest/v1/ssda_cache`, {
      method: "POST",
      headers: {
        apikey: base.key,
        Authorization: `Bearer ${base.key}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify([{ cache_key: key, data: "\\x" + hex, bytes: data.length }]),
      signal: AbortSignal.timeout(15000),
    });
    // best-effort eviction of week-old rows, occasionally
    if (++cacheSets % 20 === 1) {
      const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
      await fetch(`${base.url}/rest/v1/ssda_cache?created_at=lt.${cutoff}`, {
        method: "DELETE",
        headers: { apikey: base.key, Authorization: `Bearer ${base.key}` },
        signal: AbortSignal.timeout(8000),
      });
    }
  } catch {
    // cache trouble must never break serving
  }
}

function fmtExtMime(fmt: string): { ext: string; mime: string } {
  return fmt === "opus" ? { ext: "opus", mime: "audio/ogg" } : { ext: "mp3", mime: "audio/mpeg" };
}

let clientIdCache: { id: string; at: number } | null = null;
const CLIENT_ID_TTL = 30 * 60 * 1000;

const CLIENT_ID_PATTERNS = [
  /client_id\s*:\s*"([A-Za-z0-9_-]{20,})"/,
  /"client_id"\s*:\s*"([A-Za-z0-9_-]{20,})"/,
  /clientId\s*:\s*"([A-Za-z0-9_-]{20,})"/,
  /client_id=([A-Za-z0-9_-]{20,})/,
];

const ENTRY_PAGES = [
  "https://soundcloud.com/",
  "https://soundcloud.com/discover",
  "https://m.soundcloud.com/",
];

function findAllClientIds(text: string): string[] {
  const out: string[] = [];
  for (const re of CLIENT_ID_PATTERNS) {
    for (const m of text.matchAll(new RegExp(re.source, "g"))) {
      if (m[1] && !out.includes(m[1])) out.push(m[1]);
    }
  }
  return out;
}

/** Fetch one page and collect the client_ids inline and in its JS bundles. */
async function scanPageForClientIds(page: string, want = 8): Promise<string[]> {
  const res = await fetch(page, {
    headers: {
      "User-Agent": PAGE_UA,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return [];
  const html = await res.text();
  const found = findAllClientIds(html);
  if (found.length >= want) return found.slice(0, want);

  const assets = [...new Set(
    [...html.matchAll(/(?:https?:)?\/\/(?:[a-z0-9-]+\.)?sndcdn\.com\/assets\/[A-Za-z0-9._-]+\.js/g)]
      .map((m) => (m[0].startsWith("//") ? "https:" + m[0] : m[0])),
  )];
  if (assets.length === 0) return found;
  assets.reverse(); // newest bundles first

  const queue = [...assets];
  let scanned = 0;
  while (queue.length > 0 && scanned < 20 && found.length < want) {
    const batch = queue.splice(0, 5);
    scanned += batch.length;
    const results = await Promise.allSettled(
      batch.map(async (u) => {
        const r = await fetch(u, {
          headers: { "User-Agent": PAGE_UA, "Accept-Language": "en-US,en;q=0.9" },
          signal: AbortSignal.timeout(15000),
        });
        return r.ok ? await r.text() : "";
      }),
    );
    for (const r of results) {
      if (r.status !== "fulfilled") continue;
      for (const cid of findAllClientIds(r.value)) {
        if (!found.includes(cid)) found.push(cid);
        if (found.length >= want) break;
      }
    }
  }
  return found;
}

// Pool of working client_ids: one scrape fills several, so a poisoned id is
// survived by rotating to the next instead of scraping under pressure (the
// scrape itself is what bot-challenges).
let clientIdPool: { ids: string[]; next: number; at: number } | null = null;

async function getClientId(): Promise<string> {
  if (clientIdCache && Date.now() - clientIdCache.at < CLIENT_ID_TTL) return clientIdCache.id;

  const poolFresh = clientIdPool !== null && Date.now() - clientIdPool.at < CLIENT_ID_TTL;
  if (poolFresh && clientIdPool!.next < clientIdPool!.ids.length) {
    clientIdCache = { id: clientIdPool!.ids[clientIdPool!.next++], at: Date.now() };
    return clientIdCache.id;
  }

  // SoundCloud intermittently serves bot-challenge pages (no asset bundles),
  // especially under concurrent requests: rotate entry pages with retries.
  for (const page of ENTRY_PAGES) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const ids = await scanPageForClientIds(page);
        if (ids.length > 0) {
          clientIdPool = { ids, next: 1, at: Date.now() };
          clientIdCache = { id: ids[0], at: Date.now() };
          return clientIdCache.id;
        }
      } catch {
        // try the next page / attempt
      }
      await sleep(350 * (attempt + 1));
    }
  }
  throw new ApiError(
    502,
    "upstream",
    "Could not obtain a SoundCloud client_id (SoundCloud served a blocked or changed page). Try again in a few seconds.",
    15,
  );
}

// ---------------------------------------------------------------- resolve

/**
 * Expand on.soundcloud.com / snd.sc short links to the full track URL.
 * SoundCloud's /resolve endpoint rejects unexpanded short links, so this hop
 * matters: try HEAD with manual redirects, then GET (some short-link CDNs
 * reject HEAD), then a followed GET whose final URL carries the target.
 */
async function expandShortLink(url: string): Promise<string> {
  for (const method of ["HEAD", "GET"] as const) {
    try {
      const hop = await fetch(url, {
        method,
        redirect: "manual",
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(15000),
      });
      const loc = hop.headers.get("location");
      if (loc) return new URL(loc, url).href;
    } catch {
      // try the next strategy
    }
  }
  try {
    const hop = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(15000),
    });
    if (hop.url && hop.url !== url) return hop.url;
  } catch {
    // give up; the caller falls back to the original link
  }
  return url;
}

interface ScTrack {
  id: number | string;
  title?: string;
  duration?: number;
  permalink_url?: string;
  artwork_url?: string | null;
  policy?: string;
  track_authorization?: string | null;
  downloadable?: boolean;
  has_downloads_left?: number;
  user?: { username?: string };
  publisher_metadata?: { artist?: string | null };
  media?: { transcodings?: Transcoding[] };
}

interface Transcoding {
  url: string;
  format?: { protocol?: string; mime_type?: string };
  quality?: string;
}

async function resolveTrack(inputUrl: string): Promise<ScTrack> {
  let target = inputUrl;

  const host = new URL(target).hostname.toLowerCase();
  if (host === "on.soundcloud.com" || host === "snd.sc") {
    target = await expandShortLink(target);
  }

  const resolveOnce = async (id: string) => {
    const res = await fetch(
      `https://api-v2.soundcloud.com/resolve?url=${encodeURIComponent(target)}&client_id=${id}`,
      { headers: { Accept: "application/json", "User-Agent": UA }, signal: AbortSignal.timeout(20000) },
    );
    return res;
  };

  // SoundCloud's answer varies between requests (region/entitlement roulette:
  // the same track can come back with policy=BLOCK and no renditions, or fully
  // playable). Try a few times before believing a negative answer.
  let data: Record<string, unknown> | null = null;
  let lastStatus = 0;
  let lastBodyErr: string | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) {
      clientIdCache = null;
      await sleep(400 * attempt);
    }
    let cid = await getClientId();
    let res = await resolveOnce(cid);
    lastStatus = res.status;
    if (res.status === 401 || res.status === 403) {
      clientIdCache = null;
      cid = await getClientId();
      res = await resolveOnce(cid);
      lastStatus = res.status;
    }
    if (res.status === 404) {
      throw new ApiError(404, "track_not_found", "No SoundCloud track found at this link.");
    }
    if (res.status === 429) {
      const ra = Number(res.headers.get("retry-after"));
      throw new ApiError(
        429,
        "rate_limited",
        "SoundCloud is rate-limiting requests. Try again shortly.",
        Number.isFinite(ra) && ra > 0 ? ra : 30,
      );
    }
    if (!res.ok) continue;

    const body = (await res.json()) as Record<string, unknown> | null;
    // SoundCloud answers HTTP 200 with {"code":"not_a_track",...} or
    // {"errors":[...]} for links it cannot resolve (unexpanded short links,
    // deleted tracks). Only accept bodies that look like a real track.
    const looksLikeTrack = Boolean(
      body && (body.kind === "track" || (body.id && (body.title || body.permalink_url))),
    );
    if (!looksLikeTrack) {
      const msg = typeof body?.message === "string" ? body.message : null;
      lastBodyErr = msg ?? (typeof body?.code === "string" ? body.code : null);
      if (body?.code === "not_a_track") {
        throw new ApiError(
          400,
          "not_a_track",
          "This link is not a single track (playlists and profiles are not supported). Short links must point at one track; a full soundcloud.com/artist/track link always works.",
        );
      }
      continue; // maybe a flaky answer; retry before believing it
    }
    const list = (body.media?.transcodings ?? []) as Transcoding[];
    const hasClear = list.some((t) => !isEncrypted(t));
    if (hasClear) {
      data = body;
      break;
    }
    // Rendition-poor answer: no renditions at all, or only DRM-wrapped ones.
    // SoundCloud's profile roulette often serves a playable profile on the
    // next attempt (the same track flips between clear renditions and
    // DRM-only), so retry before believing it. Keep the richest body seen as
    // fallback (encrypted renditions still enable the download-file path and
    // a proper drm_protected error).
    const prevList = ((data as { media?: { transcodings?: unknown[] } } | null)?.media?.transcodings ?? []) as unknown[];
    if (!data || list.length > prevList.length) data = body;
    continue;
  }

  if (!data) {
    throw new ApiError(
      502,
      "upstream",
      lastBodyErr
        ? `SoundCloud did not return a track for this link (${lastBodyErr}).`
        : `SoundCloud did not return a track for this link (HTTP ${lastStatus}).`,
    );
  }
  return data as unknown as ScTrack;
}

function trackMeta(track: ScTrack, sourceUrl: string) {
  return {
    id: String(track.id),
    title: track.title || "Untitled",
    artist:
      track.publisher_metadata?.artist ||
      track.user?.username ||
      "Unknown artist",
    duration: track.duration ? Math.round(track.duration / 1000) : null,
    artwork_url: track.artwork_url || null,
    permalink_url: track.permalink_url || sourceUrl,
    source_url: sourceUrl,
    policy: track.policy ?? null,
    snip: track.policy === "SNIP",
  };
}

/** Last-resort metadata via SoundCloud oEmbed (no client_id needed). */
async function infoFallback(link: string) {
  try {
    const res = await fetch(
      `https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(link)}`,
      { headers: { Accept: "application/json", "User-Agent": UA }, signal: AbortSignal.timeout(15000) },
    );
    if (!res.ok) return null;
    const d = await res.json();
    if (!d?.title) return null;
    return {
      id: link,
      title: String(d.title),
      artist: d.author_name ? String(d.author_name) : "Unknown artist",
      duration: null,
      artwork_url: d.thumbnail_url ? String(d.thumbnail_url) : null,
      permalink_url: link,
      source_url: link,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- renditions

type Kind = "mp3" | "m4a" | "opus" | "hls" | "other";

interface Candidate {
  transcoding: Transcoding;
  kind: Kind;
  encrypted?: boolean;
  download?: boolean;
  legacy?: boolean;
}

/**
 * The old public stream endpoint. It still serves a plain MP3 for most
 * tracks — including ones whose api-v2 renditions are HLS-only or
 * DRM-wrapped — which is exactly what long-lived downloader tools use.
 * Tried as a normal rendition; nothing is decrypted here.
 */
function legacyStreamCandidate(track: ScTrack): Candidate {
  return {
    transcoding: {
      url: `https://api.soundcloud.com/tracks/${track.id}/stream`,
      format: { protocol: "legacy", mime_type: "audio/mpeg" },
      quality: "sq",
    },
    kind: "mp3",
    legacy: true,
  };
}

/**
 * DRM-wrapped renditions (Widevine/FairPlay: cbc-/ctr-encrypted-hls, cbcs/cenc
 * URLs) never play outside a licensed player. Plain `encrypted-hls` is NOT
 * DRM: it is ordinary HLS AES-128 whose key URI is served to any client that
 * can read the playlist (hls.js and ffmpeg decrypt it transparently), so the
 * pipeline handles it like any HLS rendition.
 */
function isEncrypted(t: Transcoding): boolean {
  const proto = (t.format?.protocol || "").toLowerCase();
  const u = t.url || "";
  if (proto.startsWith("ctr-") || proto.startsWith("cbc-")) return true;
  if (u.includes("/cbcs/") || u.includes("/cenc/")) return true;
  if (proto === "encrypted-hls" || proto === "hls-aes") return false;
  return proto.includes("encrypted");
}

/** The official download button's file (original upload), when the artist allows it. */
function downloadTranscoding(track: ScTrack): Transcoding | null {
  if (!track.downloadable) return null;
  if (typeof track.has_downloads_left === "number" && track.has_downloads_left <= 0) return null;
  return {
    url: `https://api-v2.soundcloud.com/tracks/${track.id}/download`,
    format: { protocol: "download", mime_type: "" },
    quality: "sq",
  };
}

/**
 * Classify a rendition. Real audio mimes are reliable; the stream URL breaks
 * ties; 'audio/mpegurl' renditions are playlist-ish and only used as a last
 * resort (they are ordered as generic 'hls').
 */
function classifyTranscoding(t: Transcoding): Kind {
  const mime = (t.format?.mime_type || "").toLowerCase();
  const u = t.url || "";
  if (mime.startsWith("audio/mpeg/") || (mime.startsWith("audio/mpeg") && !mime.startsWith("audio/mpegurl"))) return "mp3";
  if (mime.startsWith("audio/mp4") || mime.includes("mp4a")) return "m4a";
  if (mime.startsWith("audio/ogg") || mime.includes("opus")) return "opus";
  if (u.includes("/stream/progressive")) return "mp3";
  if (u.includes("/stream/hls/aac")) return "m4a";
  if (u.includes("/stream/hls")) return "hls";
  return "other";
}

function buildCandidates(track: ScTrack, fmt: string): Candidate[] {
  const list = track.media?.transcodings ?? [];
  const dl = downloadTranscoding(track);
  if (list.length === 0 && !dl) {
    // No api-v2 renditions at all: the legacy stream may still have audio.
    return [legacyStreamCandidate(track)];
  }
  const by = (kind: Kind) => list.filter((t) => classifyTranscoding(t) === kind);
  const buckets: Record<string, Transcoding[]> = {
    mp3: by("mp3"),
    m4a: by("m4a"),
    opus: by("opus"),
    hls: by("hls").concat(by("other")),
  };

  const order: string[] =
    fmt === "mp3" ? ["mp3", "m4a", "opus", "hls"]
    : fmt === "m4a" ? ["m4a", "mp3", "opus", "hls"]
    : fmt === "opus" ? ["opus", "m4a", "mp3", "hls"]
    : ["mp3", "m4a", "opus", "hls"]; // auto: smallest + most compatible first

  // Passes: clear renditions first (with the legacy stream at the end of the
  // mp3 class), then the official download file, DRM-wrapped renditions last
  // (they cannot play outside a licensed player).
  const clear: Candidate[] = [];
  const encrypted: Candidate[] = [];
  for (const key of order) {
    for (const t of buckets[key] ?? []) {
      const cand: Candidate = { transcoding: t, kind: key as Kind, encrypted: isEncrypted(t) };
      (cand.encrypted ? encrypted : clear).push(cand);
    }
    if (key === "mp3") clear.push(legacyStreamCandidate(track));
  }
  const dlCands: Candidate[] = dl ? [{ transcoding: dl, kind: "other", download: true }] : [];
  return [...clear, ...dlCands, ...encrypted];
}

// ---------------------------------------------------------------- media url

async function getStreamUrl(transcoding: Transcoding, track?: ScTrack): Promise<string> {
  let lastStatus = 0;
  let lastRetryAfter: number | undefined;
  let ta = track?.track_authorization ?? null;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) {
      clientIdCache = null;
      await sleep(500 * attempt);
    }
    const cid = await getClientId();
    const u = new URL(transcoding.url);
    if (!u.searchParams.has("client_id")) u.searchParams.set("client_id", cid);
    if (ta && !u.searchParams.has("track_authorization")) {
      u.searchParams.set("track_authorization", ta);
    }
    let res: Response;
    try {
      res = await fetch(u.href, {
        headers: { Accept: "application/json", "User-Agent": UA },
        signal: AbortSignal.timeout(20000),
      });
      lastStatus = res.status;
      if (res.ok) {
        const data = await res.json();
        if (data?.url) return data.url;
      } else if (res.status === 429) {
        // Honor the server's Retry-After (bounded: stay inside the worker
        // budget), then retry - possibly with the next client_id from the pool.
        const ra = Number(res.headers.get("retry-after"));
        if (Number.isFinite(ra) && ra > 0) lastRetryAfter = ra;
        await sleep(Math.min(4000, (Number.isFinite(ra) && ra > 0 ? ra : 1) * 1000));
      } else if (res.status !== 401 && res.status !== 403 && res.status !== 404) {
        break; // not a token problem; retrying will not help
      }
    } catch {
      // network hiccup or a non-JSON body (anti-abuse page): count as a failed
      // attempt and retry with a fresh client_id
    }
    // token/authorization problem: fetch a fresh track_authorization even if
    // resolve gave us one (they expire and go stale)
    if (track) {
      ta = (await fetchTrackAuthorization(track)) ?? ta;
    }
  }
  throw new ApiError(
    502,
    "upstream",
    `Could not get the audio stream URL (HTTP ${lastStatus}).`,
    lastRetryAfter,
  );
}

/** Some media URLs need a track_authorization that resolve didn't include. */
async function fetchTrackAuthorization(track: ScTrack): Promise<string | null> {
  for (let i = 0; i < 3; i++) {
    try {
      const cid = await getClientId();
      const res = await fetch(`https://api-v2.soundcloud.com/tracks/${track.id}?client_id=${cid}`, {
        headers: { Accept: "application/json", "User-Agent": UA },
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) {
        const d = await res.json();
        if (typeof d?.track_authorization === "string") return d.track_authorization;
      }
    } catch {
      // retry below
    }
    clientIdCache = null;
    await sleep(300 * (i + 1));
  }
  return null;
}

// ---------------------------------------------------------------- hls

function isMasterPlaylist(text: string): boolean {
  return text.includes("#EXT-X-STREAM-INF");
}

function firstVariant(text: string, baseUrl: string): string | null {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith("#EXT-X-STREAM-INF")) {
      for (let j = i + 1; j < lines.length; j++) {
        const t = lines[j].trim();
        if (t && !t.startsWith("#")) return new URL(t, baseUrl).href;
      }
    }
  }
  return null;
}

type HlsKey = {
  line: string;
  method: string;
  /** absolute URI (resolved against the playlist URL) */
  uri: string | null;
  iv: Uint8Array | null;
};

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.length % 2 ? "0" + hex : hex;
  const out = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Per HLS spec: when EXT-X-KEY carries no IV, the segment's media sequence number is the IV (128-bit big-endian). */
function seqIv(seq: number): Uint8Array {
  const iv = new Uint8Array(16);
  let n = Math.max(0, Math.floor(seq));
  for (let i = 15; i >= 0 && n > 0; i--) {
    iv[i] = n & 0xff;
    n = Math.floor(n / 256);
  }
  return iv;
}

/**
 * Real DRM (Widevine/FairPlay: SAMPLE-AES, skd:// or data: key URIs such as
 * PSSH blobs) vs plain HLS AES-128, whose key URI is handed to every client
 * that can read the playlist - hls.js and ffmpeg decrypt that transparently,
 * so we do too.
 */
function isDrmKey(key: HlsKey | null): boolean {
  if (!key) return false;
  const m = key.method.toUpperCase();
  if (m === "NONE") return false;
  if (m === "AES-128" && key.uri && /^https?:/i.test(key.uri)) return false;
  return true;
}

function parseMediaPlaylist(text: string, baseUrl: string): {
  init: string | null;
  segments: string[];
  key: HlsKey | null;
  mediaSequence: number;
} {
  let init: string | null = null;
  let key: HlsKey | null = null;
  let mediaSequence = 0;
  const segments: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      const n = Number(line.slice("#EXT-X-MEDIA-SEQUENCE:".length));
      if (Number.isInteger(n)) mediaSequence = n;
    } else if (line.startsWith("#EXT-X-KEY:") || line.startsWith("#EXT-X-SESSION-KEY:")) {
      if (!key) {
        const method = (line.match(/METHOD=([^,\s]+)/i)?.[1] ?? "").toUpperCase();
        const uriRaw = line.match(/URI="([^"]+)"/i)?.[1] ?? null;
        const ivHex = line.match(/IV=0x([0-9a-fA-F]+)/i)?.[1] ?? null;
        key = {
          line,
          method,
          uri: uriRaw ? new URL(uriRaw, baseUrl).href : null,
          iv: ivHex ? hexToBytes(ivHex) : null,
        };
        if (method === "NONE") key = null;
      }
    } else if (line.startsWith("#EXT-X-MAP:")) {
      const m = line.match(/URI="([^"]+)"/);
      if (m) init = new URL(m[1], baseUrl).href;
    } else if (!line.startsWith("#")) {
      segments.push(new URL(line, baseUrl).href);
    }
  }
  return { init, segments, key, mediaSequence };
}

/** Fetch the AES-128 key of a plain-encrypted HLS rendition (16 bytes). */
async function fetchHlsAesKey(key: HlsKey): Promise<Uint8Array | null> {
  if (isDrmKey(key) || !key.uri) return null;
  try {
    const res = await fetch(key.uri, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length >= 16) return bytes.slice(0, 16);
    return null;
  } catch {
    return null;
  }
}

async function aesCbcDecrypt(seg: Uint8Array, key: Uint8Array, iv: Uint8Array): Promise<Uint8Array | null> {
  try {
    const k = await crypto.subtle.importKey("raw", key as unknown as BufferSource, "AES-CBC", false, ["decrypt"]);
    const out = await crypto.subtle.decrypt(
      { name: "AES-CBC", iv: iv as unknown as BufferSource },
      k,
      seg as unknown as BufferSource,
    );
    return new Uint8Array(out);
  } catch {
    return null;
  }
}

/**
 * Decrypt one fetched HLS part when it actually is encrypted. Packagers differ
 * on whether the init segment is encrypted, so trust the container sniff: a
 * part that already parses as a known container is clear, anything else gets
 * the AES-128-CBC treatment and is kept only if it then parses.
 */
async function hlsDecryptPart(
  part: Uint8Array,
  key: HlsKey | null,
  keyBytes: Uint8Array | null,
  iv: Uint8Array,
): Promise<Uint8Array> {
  if (!key || isDrmKey(key) || !keyBytes) return part;
  if (containerOf(part) !== "unknown") return part; // already clear
  const dec = await aesCbcDecrypt(part, keyBytes, iv);
  return dec && containerOf(dec) !== "unknown" ? dec : part;
}

/** Download an HLS rendition: returns all parts and the sniffed container. */
async function assembleHls(playlistUrl: string): Promise<{ bytes: Uint8Array; container: string; key: HlsKey | null; debug: Record<string, unknown> }> {
  const head = await fetch(playlistUrl, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(20000),
  });
  if (!head.ok) throw new ApiError(502, "upstream", `HLS playlist fetch failed (HTTP ${head.status}).`);
  let text = await head.text();
  let baseUrl = playlistUrl;

  if (isMasterPlaylist(text)) {
    const variant = firstVariant(text, playlistUrl);
    if (!variant) throw new ApiError(502, "upstream", "HLS master playlist has no variants.");
    const vres = await fetch(variant, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(20000),
    });
    if (!vres.ok) throw new ApiError(502, "upstream", `HLS variant fetch failed (HTTP ${vres.status}).`);
    text = await vres.text();
    baseUrl = variant;
  }

  const { init, segments, key, mediaSequence } = parseMediaPlaylist(text, baseUrl);
  if (segments.length === 0) throw new ApiError(502, "upstream", "HLS playlist has no segments.");
  if (isDrmKey(key)) {
    // fail fast: no point downloading segments we cannot play
    throw new ApiError(415, "drm_protected", `rendition is DRM-encrypted (${key!.line.slice(0, 80)})`);
  }
  const keyBytes = key ? await fetchHlsAesKey(key) : null;
  if (key && !keyBytes) {
    throw new ApiError(502, "upstream", "HLS AES-128 key fetch failed.");
  }

  const items: { url: string; seq: number }[] = [];
  if (init) items.push({ url: init, seq: mediaSequence });
  segments.forEach((u, j) => items.push({ url: u, seq: mediaSequence + j }));
  const parts: Uint8Array[] = [];
  const CONCURRENCY = 8;
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    const batch = items.slice(i, i + CONCURRENCY);
    const got = await Promise.all(batch.map((it) => fetchBytes(it.url)));
    const dec: Uint8Array[] = [];
    for (let j = 0; j < got.length; j++) {
      const iv = key?.iv ?? seqIv(batch[j].seq);
      dec.push(await hlsDecryptPart(got[j], key, keyBytes, iv));
    }
    parts.push(...dec);
  }
  return {
    bytes: concatBytes(parts),
    container: containerOf(parts[0]),
    key,
    debug: {
      playlist: text.slice(0, 2500),
      init_present: Boolean(init),
      segment_count: segments.length,
      key_method: key?.method ?? "NONE",
    },
  };
}

// ---------------------------------------------------------------- ts -> adts

/** Demux MPEG-TS carrying AAC into a raw ADTS stream (playable as .aac). */
function tsToAdts(ts: Uint8Array): Uint8Array | null {
  const payloads = new Map<number, number[]>();
  let audioPid = -1;

  for (let off = 0; off + 188 <= ts.length; off += 188) {
    if (ts[off] !== 0x47) continue;
    const pid = ((ts[off + 1] & 0x1f) << 8) | ts[off + 2];
    const pusi = (ts[off + 1] & 0x40) !== 0;
    const afc = (ts[off + 3] >> 4) & 0x03;
    if (afc === 0 || afc === 1) {
      var payloadOff = off + 4;
    } else {
      const afl = ts[off + 4];
      payloadOff = off + 5 + afl;
    }
    if (payloadOff >= off + 188) continue;
    const payload = ts.slice(payloadOff, off + 188);

    if (pusi && payload.length >= 4 && payload[0] === 0x00 && payload[1] === 0x00 && payload[2] === 0x01) {
      const streamId = payload[3];
      if (streamId >= 0xc0 && streamId <= 0xdf) audioPid = pid; // MPEG audio / AAC
      if (audioPid === -1 && streamId === 0xbd) audioPid = pid; // private stream (AC3/AAC)
    }
    if (pid !== audioPid || audioPid === -1) continue;

    if (pusi && payload.length >= 9) {
      const headerLen = 9 + payload[8];
      const chunk = payload.slice(headerLen);
      (payloads.get(pid) ?? payloads.set(pid, []).get(pid)!).push(...chunk);
    } else {
      (payloads.get(pid) ?? payloads.set(pid, []).get(pid)!).push(...payload);
    }
  }

  const pes = payloads.get(audioPid);
  if (!pes || pes.length < 7) return null;

  // extract ADTS frames from the PES payload stream
  const frames: Uint8Array[] = [];
  let i = 0;
  while (i + 7 <= pes.length) {
    if (pes[i] === 0xff && (pes[i + 1] & 0xf0) === 0xf0) {
      const frameLen = ((pes[i + 3] & 0x03) << 11) | (pes[i + 4] << 3) | ((pes[i + 5] & 0xe0) >> 5);
      if (frameLen >= 7 && i + frameLen <= pes.length) {
        frames.push(Uint8Array.from(pes.slice(i, i + frameLen)));
        i += frameLen;
        continue;
      }
    }
    i++;
  }
  return frames.length ? concatBytes(frames) : null;
}

// ---------------------------------------------------------------- audio output

function audioHeaders(meta: ReturnType<typeof trackMeta>, ext: string, mime: string, note: string | null, attachment: boolean, size: number): Headers {
  const h = corsHeaders();
  h.set("Content-Type", mime);
  const filename = sanitizeFilename(`${meta.artist} - ${meta.title}`) + "." + ext;
  let disposition = "inline";
  if (attachment === true) {
    disposition = "attachment";
  }
  h.set(
    "Content-Disposition",
    `${disposition}; filename="${filename.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
  );
  h.set("X-SSDA-Extension", ext);
  if (note) h.set("X-SSDA-Format-Note", note.slice(0, 200));
  h.set("Content-Length", String(size));
  return h;
}

interface Rendered {
  bytes: Uint8Array;
  ext: string;
  mime: string;
  container: string;
  debug?: Record<string, unknown>;
}

/**
 * Turn one candidate into playable bytes, validating the container. Throws
 * ApiError('unsupported_container') when the rendition cannot be served as a
 * playable file, and ApiError('drm_protected') for DRM-wrapped streams, so the
 * caller can try the next candidate.
 */
async function renderCandidate(track: ScTrack, cand: Candidate): Promise<Rendered> {
  if (cand.encrypted) {
    // Fail fast: DRM-wrapped renditions never play outside a licensed player;
    // do not even resolve their media URLs.
    throw new ApiError(
      415,
      "drm_protected",
      `rendition is DRM-encrypted (protocol ${cand.transcoding.format?.protocol || "unknown"})`,
    );
  }
  if (cand.legacy) {
    // Legacy public stream endpoint: a plain mp3 redirect, no media URL JSON.
    // SoundCloud intermittently bot-challenges or rate-limits it, so retry
    // with real backoff (the endpoint throttles per IP).
    let bytes: Uint8Array | null = null;
    let lastStatus = 0;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) {
        clientIdCache = null;
        await sleep(lastStatus === 429 ? 1500 * attempt : 350 * attempt);
      }
      const cid = await getClientId();
      const res = await fetch(`${cand.transcoding.url}?client_id=${cid}`, {
        headers: { "User-Agent": UA },
        redirect: "follow",
        signal: AbortSignal.timeout(30000),
      });
      lastStatus = res.status;
      if (res.ok) {
        const got = new Uint8Array(await res.arrayBuffer());
        if (containerOf(got) !== "unknown" || attempt === 4) {
          bytes = got;
          break;
        }
        // 200 with junk bytes = challenge page; retry
      }
    }
    if (!bytes) {
      throw new ApiError(502, "upstream", `legacy stream endpoint did not return audio (HTTP ${lastStatus})`);
    }
    const container = containerOf(bytes);
    const out = CONTAINER_OUT[container];
    if (!out) throw new ApiError(415, "unsupported_container", `legacy stream is not playable audio (${container})`);
    return { bytes, ext: out.ext, mime: out.mime, container };
  }
  const streamUrl = await getStreamUrl(cand.transcoding, track);
  const proto = cand.transcoding.format?.protocol || "";
  const direct = cand.transcoding.url.includes("/stream/progressive") ||
    proto === "progressive" || proto === "download";

  if (direct) {
    const bytes = await fetchBytes(streamUrl, 2);
    const container = containerOf(bytes);
    const out = CONTAINER_OUT[container];
    if (!out) {
      throw new ApiError(415, "unsupported_container", `download stream is not playable audio (${container})`);
    }
    return { bytes, ext: out.ext, mime: out.mime, container };
  }

  const { bytes, container, debug } = await assembleHls(streamUrl);
  if (container === "fmp4") {
    return { bytes, ext: "m4a", mime: "audio/mp4", container, debug };
  }
  if (container === "ogg") {
    return { bytes, ext: "opus", mime: "audio/ogg", container, debug };
  }
  if (container === "ts") {
    const adts = tsToAdts(bytes);
    if (adts) {
      return { bytes: adts, ext: "aac", mime: "audio/aac", container, debug };
    }
  }
  throw new ApiError(415, "unsupported_container", `rendition container '${container}' cannot be served as a playable file`);
}

// ---------------------------------------------------------------- conversion
// When an explicit format is requested and no rendition exists in that format,
// decode the best available rendition and re-encode it to the requested format.
// Only used for explicit format requests; format=auto is never transcoded.

type Pcm = { channelData: Float32Array[]; sampleRate: number };

function wavToPcm(bytes: Uint8Array): Pcm {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, false) !== 0x52494646) {
    throw new ApiError(415, "unsupported_container", "not a wav file");
  }
  let pos = 12;
  let sampleRate = 44100;
  let channels = 1;
  let bits = 16;
  let dataPos = -1;
  let dataLen = 0;
  while (pos + 8 <= bytes.length) {
    const id = dv.getUint32(pos, false);
    const size = dv.getUint32(pos + 4, true);
    if (id === 0x666d7420) { // "fmt "
      channels = dv.getUint16(pos + 10, true);
      sampleRate = dv.getUint32(pos + 12, true);
      bits = dv.getUint16(pos + 22, true);
    } else if (id === 0x64617461) { // "data"
      dataPos = pos + 8;
      dataLen = Math.min(size, bytes.length - dataPos);
    }
    pos += 8 + size + (size % 2);
  }
  if (dataPos < 0 || bits !== 16) {
    throw new ApiError(415, "unsupported_container", `unsupported wav layout (bits=${bits})`);
  }
  const samples = Math.floor(dataLen / (2 * channels));
  const channelData: Float32Array[] = [];
  for (let c = 0; c < channels; c++) channelData.push(new Float32Array(samples));
  for (let i = 0; i < samples; i++) {
    for (let c = 0; c < channels; c++) {
      channelData[c][i] = dv.getInt16(dataPos + (i * channels + c) * 2, true) / 32768;
    }
  }
  return { channelData, sampleRate };
}

// ---- fMP4 (ISO-BMFF) -> ADTS AAC extraction -------------------------------
// SoundCloud's HLS assemblies are fragmented MP4 whose segments start with
// styp/moof boxes; decode-aac wants ADTS or raw frames. Demux the AAC frames
// out (fragmented via trun, or progressive via stsz/stsc/stco) and re-wrap
// them with ADTS headers.

function mp4Boxes(bytes: Uint8Array, from: number, to: number): { type: string; start: number; end: number }[] {
  const out: { type: string; start: number; end: number }[] = [];
  let p = from;
  while (p + 8 <= to) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset + p, 16);
    let size = dv.getUint32(0);
    const type = ascii(bytes, p + 4, p + 8);
    let header = 8;
    if (size === 1) {
      if (p + 16 > to) break;
      size = dv.getUint32(8) * 4294967296 + dv.getUint32(12);
      header = 16;
    } else if (size === 0) {
      size = to - p;
    }
    if (size < header || p + size > to) break;
    out.push({ type, start: p + header, end: p + size });
    p += size;
  }
  return out;
}

function mp4Desc(buf: Uint8Array, pos: number): { tag: number; body: Uint8Array; next: number } {
  const tag = buf[pos];
  let len = 0;
  let p = pos + 1;
  let b = 0;
  do {
    b = buf[p++];
    len = (len << 7) | (b & 0x7f);
  } while ((b & 0x80) !== 0 && p < pos + 5);
  return { tag, body: buf.subarray(p, p + len), next: p + len };
}

/** AudioSpecificConfig from an esds box body (skip 4-byte fullbox header). */
function ascFromEsds(esds: Uint8Array): Uint8Array | null {
  try {
    const es = mp4Desc(esds, 4); // ES_Descriptor (0x03)
    const dcfg = mp4Desc(es.body, 3); // skip ES_ID(2)+flags(1) -> DecoderConfig (0x04)
    if (dcfg.tag !== 0x04) return null;
    const dsi = mp4Desc(dcfg.body, 13); // skip 13 fixed bytes -> DecoderSpecificInfo (0x05)
    return dsi.tag === 0x05 && dsi.body.length >= 2 ? dsi.body : null;
  } catch {
    return null;
  }
}

function adtsHeader(frameLen: number, profile: number, sfi: number, ch: number): Uint8Array {
  const h = new Uint8Array(7);
  h[0] = 0xff;
  h[1] = 0xf1;
  h[2] = ((profile & 3) << 6) | ((sfi & 0x0f) << 2) | ((ch >> 2) & 1);
  h[3] = ((ch & 3) << 6) | ((frameLen >> 11) & 3);
  h[4] = (frameLen >> 3) & 0xff;
  h[5] = ((frameLen & 7) << 5) | 0x1f;
  h[6] = 0xfc;
  return h;
}

function fmp4ToAdts(bytes: Uint8Array): Uint8Array {
  const top = mp4Boxes(bytes, 0, bytes.length);

  // ---- 1. AudioSpecificConfig from moov (stsd entry must be AAC) ----
  let asc: Uint8Array | null = null;
  const walk = (from: number, to: number) => {
    for (const b of mp4Boxes(bytes, from, to)) {
      if (["moov", "trak", "mdia", "minf", "stbl"].includes(b.type)) {
        walk(b.start, b.end);
      } else if (b.type === "stsd") {
        for (const entry of mp4Boxes(bytes, b.start + 8, b.end)) {
          if (entry.type !== "mp4a" && entry.type !== "enca") continue;
          walk(entry.start + 28, entry.end); // sound sample entry body = 28 bytes
        }
      } else if (b.type === "esds") {
        asc = asc ?? ascFromEsds(bytes.subarray(b.start, b.end));
      }
    }
  };
  for (const b of top) if (b.type === "moov") walk(b.start, b.end);
  if (!asc) throw new ApiError(415, "unsupported_container", "fMP4 has no AAC decoder config");

  const aot = (asc![0] >> 3) & 0x1f;
  const sfi = ((asc![0] & 0x07) << 1) | (asc![1] >> 7);
  const ch = (asc![1] >> 3) & 0x0f;
  const profile = aot >= 1 && aot <= 4 ? aot - 1 : 1; // ADTS profile; HE-AAC streams as LC

  // ---- 2. sample (offset, size) locations ----
  const frames: Uint8Array[] = [];
  const emit = (off: number, size: number) => {
    if (size >= 1 && off + size <= bytes.length) {
      frames.push(adtsHeader(size + 7, profile, sfi, ch), bytes.subarray(off, off + size));
    }
  };

  // fragmented: each moof's trun sample sizes run through the following mdat
  let pending: number[] = [];
  for (const b of top) {
    if (b.type === "moof") {
      pending = [];
      for (const traf of mp4Boxes(bytes, b.start, b.end)) {
        if (traf.type !== "traf") continue;
        let defaultSize = 0;
        for (const t of mp4Boxes(bytes, traf.start, traf.end)) {
          if (t.type === "tfhd") {
            const flags = ((bytes[t.start + 1] << 16) | (bytes[t.start + 2] << 8) | bytes[t.start + 3]) >>> 0;
            let p = t.start + 8; // version/flags(4) + track_ID(4)
            if (flags & 0x01) p += 8; // base_data_offset
            if (flags & 0x02) p += 4; // sample_description_index
            if (flags & 0x08) p += 4; // default_sample_duration
            if (flags & 0x10) p += 4; // default_sample_size
            if (flags & 0x10) defaultSize = new DataView(bytes.buffer, bytes.byteOffset + p - 4, 4).getUint32(0);
          } else if (t.type === "trun") {
            const flags = ((bytes[t.start + 1] << 16) | (bytes[t.start + 2] << 8) | bytes[t.start + 3]) >>> 0;
            const count = new DataView(bytes.buffer, bytes.byteOffset + t.start + 4, 4).getUint32(0);
            let p = t.start + 8;
            if (flags & 0x01) p += 4; // data_offset
            if (flags & 0x04) p += 4; // first_sample_flags
            for (let i = 0; i < count; i++) {
              if (flags & 0x100) p += 4; // sample_duration
              if (flags & 0x200) {
                pending.push(new DataView(bytes.buffer, bytes.byteOffset + p, 4).getUint32(0));
                p += 4;
              } else {
                pending.push(defaultSize);
              }
              if (flags & 0x400) p += 4; // sample_flags
              if (flags & 0x800) p += 4; // composition_offset
            }
          }
        }
      }
    } else if (b.type === "mdat" && pending.length) {
      let payload = b.start; // box walk already skipped the size/type header
      for (const size of pending) {
        emit(payload, size);
        payload += size;
      }
      pending = [];
    }
  }

  // progressive mp4 (original m4a uploads): stsz sizes + stsc/stco chunk map
  if (frames.length === 0) {
    for (const b of top) {
      if (b.type !== "moov") continue;
      const walkProg = (from: number, to: number) => {
        for (const box of mp4Boxes(bytes, from, to)) {
          if (["moov", "trak", "mdia", "minf"].includes(box.type)) {
            walkProg(box.start, box.end);
          } else if (box.type === "stbl") {
            const s: { sizes: number[]; chunkOffs: number[]; stscRuns: { firstChunk: number; samplesPerChunk: number }[] } = { sizes: [], chunkOffs: [], stscRuns: [] };
            for (const t of mp4Boxes(bytes, box.start, box.end)) {
              const tlen = t.end - t.start;
              const dv = tlen >= 8 ? new DataView(bytes.buffer, bytes.byteOffset + t.start, tlen) : null;
              if (!dv) continue;
              if (t.type === "stsz" && tlen >= 12) {
                const fixed = dv.getUint32(4);
                const count = dv.getUint32(8);
                if (fixed !== 0) {
                  for (let i = 0; i < count; i++) s.sizes.push(fixed);
                } else {
                  for (let i = 0; i < count; i++) s.sizes.push(new DataView(bytes.buffer, bytes.byteOffset + t.start + 12 + i * 4, 4).getUint32(0));
                }
              } else if ((t.type === "stco" || t.type === "co64") && tlen >= 8) {
                const count = dv.getUint32(4);
                for (let i = 0; i < count; i++) {
                  if (t.type === "stco") s.chunkOffs.push(new DataView(bytes.buffer, bytes.byteOffset + t.start + 8 + i * 4, 4).getUint32(0));
                  else {
                    const dv2 = new DataView(bytes.buffer, bytes.byteOffset + t.start + 8 + i * 8, 8);
                    s.chunkOffs.push(dv2.getUint32(0) * 4294967296 + dv2.getUint32(4));
                  }
                }
              } else if (t.type === "stsc" && tlen >= 8) {
                const count = dv.getUint32(4);
                for (let i = 0; i < count; i++) {
                  const firstChunk = new DataView(bytes.buffer, bytes.byteOffset + t.start + 8 + i * 12, 4).getUint32(0);
                  const samplesPerChunk = new DataView(bytes.buffer, bytes.byteOffset + t.start + 8 + i * 12 + 4, 4).getUint32(0);
                  s.stscRuns.push({ firstChunk, samplesPerChunk });
                }
              }
            }
            // stsc: runs of (first_chunk, samples_per_chunk); expand to per-chunk counts
            if (s.sizes.length && s.chunkOffs.length) {
              let sample = 0;
              for (let c = 0; c < s.chunkOffs.length && sample < s.sizes.length; c++) {
                const chunkNumber = c + 1; // stsc first_chunk is 1-based
                let n = s.stscRuns.length ? s.stscRuns[0].samplesPerChunk : 1;
                for (const run of s.stscRuns) if (chunkNumber >= run.firstChunk) n = run.samplesPerChunk;
                let off = s.chunkOffs[c];
                for (let k = 0; k < n && sample < s.sizes.length; k++) {
                  emit(off, s.sizes[sample]);
                  off += s.sizes[sample];
                  sample++;
                }
              }
            }
          }
        }
      };
      walkProg(b.start, b.end);
    }
  }

  if (!frames.length) throw new ApiError(415, "unsupported_container", "fMP4 demux found no AAC frames");
  return concatBytes(frames);
}

// ---- streaming conversion plumbing ---------------------------------------
// The edge worker's memory ceiling is tight: compressed sources are split at
// codec frame boundaries, decoded one short segment at a time, and fed
// straight into the encoder. Peak memory stays at one segment of PCM plus the
// encoder's wasm heap instead of the whole track.

const SEGMENT_TARGET = 120000; // compressed bytes per segment (~6-10 s)

function groupSegments(frames: Uint8Array[]): Uint8Array[] {
  const segs: Uint8Array[] = [];
  let cur: Uint8Array[] = [];
  let size = 0;
  for (const f of frames) {
    cur.push(f);
    size += f.length;
    if (size >= SEGMENT_TARGET) {
      segs.push(concatBytes(cur));
      cur = [];
      size = 0;
    }
  }
  if (cur.length) segs.push(concatBytes(cur));
  return segs;
}

function splitAdtsFrames(bytes: Uint8Array): Uint8Array[] {
  const frames: Uint8Array[] = [];
  let i = 0;
  while (i + 7 <= bytes.length) {
    if (bytes[i] === 0xff && (bytes[i + 1] & 0xf0) === 0xf0) {
      const len = ((bytes[i + 3] & 0x03) << 11) | (bytes[i + 4] << 3) | ((bytes[i + 5] & 0xe0) >> 5);
      if (len >= 7 && i + len <= bytes.length) {
        frames.push(bytes.subarray(i, i + len));
        i += len;
        continue;
      }
    }
    i++;
  }
  return frames;
}

function splitMp3Frames(bytes: Uint8Array): Uint8Array[] {
  const BITR1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
  const BITR2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
  const RATES: Record<number, number[]> = {
    3: [44100, 48000, 32000], // MPEG-1
    2: [22050, 24000, 16000], // MPEG-2
    0: [11025, 12000, 8000], // MPEG-2.5
  };
  let start = 0;
  if (bytes.length > 10 && ascii(bytes, 0, 3) === "ID3") {
    start = 10 + (((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f));
  }
  const frames: Uint8Array[] = [];
  let i = start;
  while (i + 4 <= bytes.length) {
    if (bytes[i] === 0xff && (bytes[i + 1] & 0xe0) === 0xe0) {
      const ver = (bytes[i + 1] >> 3) & 0x03;
      const layer = (bytes[i + 1] >> 1) & 0x03;
      const bi = (bytes[i + 2] >> 4) & 0x0f;
      const sfi = (bytes[i + 2] >> 2) & 0x03;
      const table = ver === 3 ? BITR1 : BITR2;
      if (ver !== 1 && layer === 1 && sfi !== 3 && bi !== 0 && bi !== 15 && RATES[ver]) {
        const br = table[bi] * 1000;
        const rate = RATES[ver][sfi];
        const pad = (bytes[i + 2] >> 1) & 0x01;
        const len = Math.floor((ver === 3 ? 144 : 72) * br / rate) + pad;
        if (len >= 4 && i + len <= bytes.length) {
          frames.push(bytes.subarray(i, i + len));
          i += len;
          continue;
        }
      }
    }
    i++;
  }
  return frames;
}

async function decodeSegment(seg: Uint8Array, srcExt: string): Promise<Pcm> {
  if (srcExt === "mp3") return await (await loadDecodeMp3())(seg);
  if (srcExt === "m4a" || srcExt === "aac") return await (await loadDecodeAac())(seg);
  if (srcExt === "wav") return wavToPcm(seg);
  throw new ApiError(415, "unsupported_container", `cannot convert audio from '${srcExt}'`);
}

function floatTo16(ch: Float32Array, from: number, to: number): Int16Array {
  const out = new Int16Array(to - from);
  for (let i = from; i < to; i++) {
    const s = Math.max(-1, Math.min(1, ch[i]));
    out[i - from] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function resample(ch: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return ch;
  const n = Math.round(ch.length * to / from);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const srcPos = i * from / to;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, ch.length - 1);
    const frac = srcPos - i0;
    out[i] = ch[i0] * (1 - frac) + ch[i1] * frac;
  }
  return out;
}

type Sink = {
  ext: string;
  mime: string;
  container: string;
  push(pcm: Pcm): Promise<void>;
  finish(): Promise<Uint8Array>;
};

async function makeSink(fmt: string, first: Pcm): Promise<Sink> {
  const channels = Math.min(2, first.channelData.length);
  const sampleRate = first.sampleRate;
  const parts: Uint8Array[] = [];
  const take = (b: Uint8Array | undefined | null) => {
    if (b && b.length) parts.push(b);
  };

  if (fmt === "mp3") {
    // Pure-JS LAME encoder. The wasm encoder modules (wasm-media-encoders,
    // @audio/encode-mp3) get this platform's worker killed with
    // WORKER_RESOURCE_LIMIT before a frame is out, even with a patched memory
    // maximum - so mp3 encoding stays wasm-free.
    const lame = await loadLame();
    const enc = new lame.Mp3Encoder(channels, sampleRate, 320);
    return {
      ext: "mp3", mime: "audio/mpeg", container: "mp3",
      async push(pcm: Pcm) {
        const CHUNK = 8192;
        const n = pcm.channelData[0].length;
        for (let off = 0; off < n; off += CHUNK) {
          const end = Math.min(off + CHUNK, n);
          const l = floatTo16(pcm.channelData[0], off, end);
          take(channels === 2 ? enc.encodeBuffer(l, floatTo16(pcm.channelData[1], off, end)) : enc.encodeBuffer(l));
        }
      },
      async finish() {
        take(enc.flush());
        return concatBytes(parts);
      },
    };
  }

  if (fmt === "m4a") {
    const enc = await (await loadEncodeM4a())({ sampleRate, channels, codec: "aac", profile: "lc", bitrate: 256 });
    return {
      ext: "m4a", mime: "audio/mp4", container: "fmp4",
      async push(pcm: Pcm) {
        const CHUNK = 8192;
        const n = pcm.channelData[0].length;
        for (let off = 0; off < n; off += CHUNK) {
          await enc.encode(pcm.channelData.slice(0, channels).map((c) => c.subarray(off, Math.min(off + CHUNK, n))));
        }
      },
      async finish() {
        take(await enc.flush()); // whole-file mode: the complete m4a
        enc.free();
        return concatBytes(parts);
      },
    };
  }

  // opus
  const { Wme, oggWasm } = await loadOpusEncoder();
  const OPUS_RATES = [8000, 12000, 16000, 24000, 48000];
  const rate = OPUS_RATES.includes(sampleRate) ? sampleRate : 48000;
  const enc = await Wme.create("audio/ogg", oggWasm);
  enc.configure({ channels: channels as 1 | 2, sampleRate: rate, vbrQuality: 8 });
  const frame = Math.round(rate * 0.02); // 20 ms frames
  const bufs: Float32Array[] = [];
  for (let i = 0; i < channels; i++) bufs.push(new Float32Array(0));
  const drain = (all: boolean) => {
    const n = bufs[0].length;
    const whole = all ? n : Math.floor(n / frame) * frame;
    if (whole > 0) take(enc.encode(bufs.map((b) => b.subarray(0, whole))));
    for (let i = 0; i < channels; i++) bufs[i] = bufs[i].slice(whole);
  };
  return {
    ext: "opus", mime: "audio/ogg", container: "ogg",
    async push(pcm: Pcm) {
      const chs = pcm.channelData.slice(0, channels).map((c) => resample(c, pcm.sampleRate, rate));
      for (let i = 0; i < channels; i++) {
        const joined = new Float32Array(bufs[i].length + chs[i].length);
        joined.set(bufs[i], 0);
        joined.set(chs[i], bufs[i].length);
        bufs[i] = joined;
      }
      drain(false);
    },
    async finish() {
      drain(true);
      take(enc.finalize());
      return concatBytes(parts);
    },
  };
}

async function convertAudio(bytes: Uint8Array, srcExt: string, fmt: string): Promise<Rendered> {
  // Split the compressed source at frame boundaries and process segment by
  // segment so the whole track never sits in memory as PCM.
  let segments: Uint8Array[] | null = null;  if (srcExt === "m4a" || srcExt === "aac") {
    try {
      const adts = srcExt === "aac" ? bytes : fmp4ToAdts(bytes);
      const frames = splitAdtsFrames(adts);
      if (frames.length) segments = groupSegments(frames);
    } catch {
      // ALAC and layouts the demuxer cannot read: decode-aac handles the
      // whole file itself as one segment
      segments = null;
    }
  } else if (srcExt === "mp3") {
    const frames = splitMp3Frames(bytes);
    if (frames.length) segments = groupSegments(frames);
  }
  segments ??= [bytes];

  let sink: Sink | null = null;
  for (const seg of segments) {
    const pcm = await decodeSegment(seg, srcExt);
    if (!pcm.channelData.length || !pcm.channelData[0]?.length) continue;
    if (!sink) sink = await makeSink(fmt, pcm);
    await sink.push(pcm);
  }
  if (!sink) throw new ApiError(415, "unsupported_container", "decoded audio is empty");
  const outBytes = await sink.finish();
  return { bytes: outBytes, ext: sink.ext, mime: sink.mime, container: sink.container };
}

/**
 * Compressed-frame windowing for chunked conversion: keep only the codec
 * frames covering [fromSec, toSec). Frame positions are computed from the
 * codec's samples-per-frame, so chunk boundaries are exact and seamless.
 */
function windowFrames(bytes: Uint8Array, srcExt: string, fromSec: number, toSec: number): Uint8Array {
  type Fr = { start: number; end: number; samples: number };
  let frames: Fr[] = [];
  let sampleRate = 44100;
  if (srcExt === "mp3") {
    const RATES: Record<number, number[]> = {
      3: [44100, 48000, 32000],
      2: [22050, 24000, 16000],
      0: [11025, 12000, 8000],
    };
    let offset = 0;
    if (bytes.length > 10 && ascii(bytes, 0, 3) === "ID3") {
      offset = 10 + (((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f));
    }
    const parts = splitMp3Frames(bytes);
    for (const f of parts) {
      const ver = (f[1] >> 3) & 0x03;
      const sfi = (f[2] >> 2) & 0x03;
      const samples = ver === 3 ? 1152 : 576;
      if (RATES[ver] && sfi !== 3) sampleRate = RATES[ver][sfi];
      frames.push({ start: f.byteOffset - bytes.byteOffset, end: f.byteOffset - bytes.byteOffset + f.length, samples });
    }
    void offset;
  } else {
    const adts = srcExt === "aac" ? bytes : fmp4ToAdts(bytes);
    const sfi = adts.length > 2 ? (adts[2] >> 2) & 0x0f : 4;
    const SR = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
    if (sfi < SR.length) sampleRate = SR[sfi];
    const parts = splitAdtsFrames(adts);
    for (const f of parts) {
      frames.push({ start: f.byteOffset - adts.byteOffset, end: f.byteOffset - adts.byteOffset + f.length, samples: 1024 });
    }
    // re-base onto `bytes` when we demuxed from an fMP4 container
    if (srcExt !== "aac") {
      return windowFrames(frames.length ? concatBytes(frames.map((f) => adts.subarray(f.start, f.end))) : new Uint8Array(0), "aac", fromSec, toSec);
    }
  }
  const s0 = Math.round(fromSec * sampleRate);
  const s1 = Math.round(toSec * sampleRate);
  let at = 0;
  const keep: Uint8Array[] = [];
  for (const f of frames) {
    const end = at + f.samples;
    if (end > s0 && at < s1) keep.push(bytes.subarray(f.start, f.end));
    at = end;
  }
  return concatBytes(keep);
}

/** Response body assembly for chunk=all from the server-side chunk cache. */
async function assembleFromCache(
  track: ScTrack,
  meta: ReturnType<typeof trackMeta>,
  fmt: string,
  count: number,
): Promise<Response> {
  const trackKey = String(track.id);
  const keys = Array.from({ length: count }, (_, i) => chunkKey(trackKey, fmt, i));
  const rows = await cacheGetMany(keys);
  const missing: number[] = [];
  for (let i = 0; i < count; i++) if (!rows.has(keys[i])) missing.push(i);
  if (missing.length > 0) {
    throw new ApiError(
      409,
      "chunks_not_cached",
      `${missing.length} of ${count} ${fmt} chunks for this track are not in the server cache yet. ` +
      `Fetch them first (&chunk=${missing[0]}${missing.length > 1 ? " .. &chunk=" + missing[missing.length - 1] : ""}; ` +
      `each request converts one chunk), then repeat this request.`,
      undefined,
      { missing, chunk_count: count, chunk_seconds: CHUNK_SECONDS, format: fmt },
    );
  }
  const bytes = concatBytes(keys.map((k) => rows.get(k)!));
  const { ext, mime } = fmtExtMime(fmt);
  const h = audioHeaders(meta, ext, mime, `assembled from ${count} cached chunks`, false, bytes.length);
  h.set("X-SSDA-Chunk-Count", String(count));
  h.set("X-SSDA-Cache", "hit");
  return new Response(bytes, { status: 200, headers: h });
}

/**
 * Serve one conversion chunk (or the chunk plan for chunk=info, or the whole
 * file from cache for chunk=all). Chunk requests convert at most one
 * ~CHUNK_SECONDS window of audio, staying well inside the per-request compute
 * budget; converted chunks and whole files land in the server-side cache so
 * repeat requests never touch SoundCloud again.
 */
async function serveChunk(
  track: ScTrack,
  meta: ReturnType<typeof trackMeta>,
  cand: Candidate,
  fmt: string,
  sel: number | "info" | "all",
): Promise<Response> {
  if (fmt === "m4a") {
    throw new ApiError(
      400,
      "chunking_not_supported_for_format",
      "m4a files cannot be assembled from chunks. Use format=mp3 (or format=opus) for long tracks, or a track shorter than 25 s.",
    );
  }
  const trackKey = String(track.id);
  const cMetaKey = chunkMetaKey(trackKey, fmt);
  const numKey = typeof sel === "number" ? chunkKey(trackKey, fmt, sel) : null;
  const early = await cacheGetMany(numKey ? [cMetaKey, numKey] : [cMetaKey]);
  const metaParsed = parseMetaJson(early.get(cMetaKey));
  const cachedCount = metaParsed && metaParsed.cs === CHUNK_SECONDS && Number.isInteger(metaParsed.count)
    ? metaParsed.count as number
    : null;
  const cachedChunkSeconds = metaParsed && Number.isInteger(metaParsed.chunk_seconds)
    ? metaParsed.chunk_seconds as number
    : 0;

  const planResponse = (count: number, chunkSeconds: number, cache: string): Response => {
    const res = jsonResponse({ chunk_count: count, chunk_seconds: chunkSeconds, format: fmt });
    res.headers.set("X-SSDA-Cache", cache);
    return res;
  };
  const chunkResponse = (bytes: Uint8Array, idx: number, count: number, cache: string): Response => {
    const { ext, mime } = fmtExtMime(fmt);
    const h = audioHeaders(meta, ext, mime, `${cache === "hit" ? "cached" : "converted"} chunk ${idx}/${count}`, false, bytes.length);
    h.set("X-SSDA-Chunk-Index", String(idx));
    h.set("X-SSDA-Chunk-Count", String(count));
    h.set("X-SSDA-Cache", cache);
    return new Response(bytes, { status: 200, headers: h });
  };

  // Cache fast paths: serve without touching SoundCloud at all.
  if (cachedCount !== null && sel === "info") return planResponse(cachedCount, cachedChunkSeconds, "hit");
  if (cachedCount !== null && sel === "all") return await assembleFromCache(track, meta, fmt, cachedCount);
  if (cachedCount !== null && numKey && early.get(numKey)) {
    return chunkResponse(early.get(numKey)!, sel as number, cachedCount, "hit");
  }

  let streamUrl: string;
  try {
    streamUrl = await getStreamUrl(cand.transcoding, track);
  } catch (err) {
    if (err instanceof ApiError) throw new ApiError(err.status, err.code, `streamurl: ${err.message}`, err.retryAfter);
    throw err;
  }
  const proto = cand.transcoding.format?.protocol || "";
  const isDirect = cand.legacy ||
    cand.transcoding.url.includes("/stream/progressive") ||
    proto === "progressive" || proto === "download";

  let count = 0;
  let window: Uint8Array = new Uint8Array(0);
  let srcExt = "mp3";

  if (isDirect) {
    const durSec = (track.duration ?? 0) / 1000;
    count = Math.max(1, Math.ceil(durSec / CHUNK_SECONDS));
    if (sel === "info") {
      await cacheSet(cMetaKey, metaJsonBytes({ count, cs: CHUNK_SECONDS, chunk_seconds: CHUNK_SECONDS }));
      return planResponse(count, CHUNK_SECONDS, "miss");
    }
    if (sel === "all") return await assembleFromCache(track, meta, fmt, count);
    if (!(sel >= 0) || sel >= count) {
      throw new ApiError(404, "invalid_chunk", `chunk must be between 0 and ${count - 1} (or 'info' / 'all').`);
    }
    const bytes = await fetchBytes(streamUrl, 2);
    const container = containerOf(bytes);
    if (container === "mp3") srcExt = "mp3";
    else if (container === "fmp4") srcExt = "m4a";
    else if (container === "ts") {
      const adts = tsToAdts(bytes);
      if (!adts) throw new ApiError(415, "unsupported_container", "stream has no AAC frames");
      window = windowFrames(adts, "aac", sel * CHUNK_SECONDS, (sel + 1) * CHUNK_SECONDS);
    } else {
      throw new ApiError(415, "unsupported_container", `cannot convert audio from '${container}'`);
    }
    if (container !== "ts") {
      window = windowFrames(bytes, srcExt, sel * CHUNK_SECONDS, (sel + 1) * CHUNK_SECONDS);
    }
    srcExt = container === "ts" ? "aac" : srcExt;
  } else {
    // HLS: fetch only this chunk's segments (plus the init segment).
    const head = await fetch(streamUrl, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
    if (!head.ok) throw new ApiError(502, "upstream", `HLS playlist fetch failed (HTTP ${head.status}).`);
    let text = await head.text();
    let baseUrl = streamUrl;
    if (isMasterPlaylist(text)) {
      const variant = firstVariant(text, streamUrl);
      if (!variant) throw new ApiError(502, "upstream", "HLS master playlist has no variants.");
      const vres = await fetch(variant, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
      if (!vres.ok) throw new ApiError(502, "upstream", `HLS variant fetch failed (HTTP ${vres.status}).`);
      text = await vres.text();
      baseUrl = variant;
    }
    const { init, segments, key, mediaSequence } = parseMediaPlaylist(text, baseUrl);
    if (isDrmKey(key)) {
      throw new ApiError(415, "drm_protected", `rendition is DRM-encrypted (${key!.line.slice(0, 80)})`);
    }
    if (!segments.length) throw new ApiError(502, "upstream", "HLS playlist has no segments.");
    count = segments.length;
    if (sel === "info") {
      await cacheSet(cMetaKey, metaJsonBytes({ count, cs: CHUNK_SECONDS, chunk_seconds: 0 }));
      return planResponse(count, 0, "miss");
    }
    if (sel === "all") return await assembleFromCache(track, meta, fmt, count);
    if (!(sel >= 0) || sel >= count) {
      throw new ApiError(404, "invalid_chunk", `chunk must be between 0 and ${count - 1} (or 'info' / 'all').`);
    }
    const keyBytes = key ? await fetchHlsAesKey(key) : null;
    if (key && !keyBytes) throw new ApiError(502, "upstream", "HLS AES-128 key fetch failed.");
    const items = (init ? [{ url: init, seq: mediaSequence }] : [])
      .concat([{ url: segments[sel], seq: mediaSequence + sel }]);
    const got = await Promise.all(items.map((it) => fetchBytes(it.url)));
    const dec: Uint8Array[] = [];
    for (let j = 0; j < got.length; j++) {
      const iv = key?.iv ?? seqIv(items[j].seq);
      dec.push(await hlsDecryptPart(got[j], key, keyBytes, iv));
    }
    const raw = concatBytes(dec);
    const container = containerOf(raw);
    if (container === "ts") {
      const adts = tsToAdts(raw);
      if (!adts) throw new ApiError(415, "unsupported_container", "stream has no AAC frames");
      window = adts;
      srcExt = "aac";
    } else if (container === "fmp4") {
      // demux the init+segment fMP4 down to raw ADTS frames (one segment is
      // already one time chunk, so no further windowing is needed)
      const adts = fmp4ToAdts(raw);
      if (!adts || adts.length === 0) throw new ApiError(415, "unsupported_container", "fMP4 segment has no AAC frames");
      window = adts;
      srcExt = "aac";
    } else if (container === "ogg") {
      throw new ApiError(415, "conversion_failed", "this track's source is opus and cannot be converted to " + fmt);
    } else {
      throw new ApiError(415, "unsupported_container", `rendition container '${container}' cannot be converted`);
    }
  }

  let out: Rendered;
  try {
    // windowFrames already demuxed m4a/aac sources down to raw ADTS frames
    out = await convertAudio(window, srcExt === "mp3" ? "mp3" : "aac", fmt);
  } catch (err) {
    if (window.length === 0) {
      // chunk past the end of the audio: an empty tail is fine to concatenate
      const m = fmtExtMime(fmt);
      out = { bytes: new Uint8Array(0), ...m, container: m.ext };
    } else if (err instanceof ApiError) {
      throw err;
    } else {
      throw new ApiError(415, "conversion_failed", cleanMessage(err instanceof Error ? err.message : String(err)));
    }
  }
  if (numKey && out.bytes.length > 0) {
    await Promise.all([
      cacheSet(cMetaKey, metaJsonBytes({ count, cs: CHUNK_SECONDS, chunk_seconds: isDirect ? CHUNK_SECONDS : 0 })),
      cacheSet(numKey, out.bytes),
    ]);
  }
  return chunkResponse(out.bytes, sel as number, count, "miss");
}

/**
 * Serve audio with one full retry pass on transient upstream failures:
 * SoundCloud's anti-abuse/region roulette occasionally fails every source at
 * once (legacy stream + media URLs together); a fresh pass with a new
 * client_id usually recovers within a second or two.
 */
async function serveAudio(url: string, fmt: string, attachment: boolean, chunkSel: number | "info" | "all" | null): Promise<Response> {
  let lastErr: unknown = null;
  for (let pass = 0; pass < 3; pass++) {
    if (pass > 0) {
      clientIdCache = null;
      await sleep(1000 * pass);
    }
    try {
      return await serveAudioPass(url, fmt, attachment, chunkSel);
    } catch (err) {
      const transient = err instanceof ApiError && err.code === "upstream" && err.status === 502;
      if (!transient) throw err;
      lastErr = err;
    }
  }
  if (lastErr instanceof ApiError && lastErr.code === "upstream" && lastErr.status === 502) {
    throw new ApiError(
      502,
      "upstream",
      `${lastErr.message} This is often transient - try again in a few seconds.`,
      lastErr.retryAfter ?? 30,
    );
  }
  throw lastErr;
}

async function serveAudioPass(url: string, fmt: string, attachment: boolean, chunkSel: number | "info" | "all" | null): Promise<Response> {
  const track = await resolveTrack(url);
  const meta = trackMeta(track, url);

  // Whole-file cache: a repeat request for this track+format serves straight
  // from storage - no stream URLs, no downloads, no conversion.
  const fKey = fullKey(track.id, fmt);
  const fmKey = fullMetaKey(track.id, fmt);
  const cached = await cacheGetMany([fmKey, fKey]);
  const fmParsed = parseMetaJson(cached.get(fmKey));
  const fRaw = cached.get(fKey);
  if (fmParsed && fRaw && typeof fmParsed.ext === "string" && typeof fmParsed.mime === "string") {
    const h = audioHeaders(
      meta,
      fmParsed.ext as string,
      fmParsed.mime as string,
      typeof fmParsed.note === "string" ? fmParsed.note : "cached",
      attachment,
      fRaw.length,
    );
    h.set("X-SSDA-Cache", "hit");
    return new Response(fRaw, { status: 200, headers: h });
  }

  const candidates = buildCandidates(track, fmt);

  // Chunked conversion: serve the chunk plan or exactly one chunk window.
  if (chunkSel !== null && fmt !== "auto") {
    let lastErr: ApiError | null = null;
    let legacyStatus = 0;
    let drmSeen = false;
    for (const cand of candidates) {
      if (cand.encrypted) {
        drmSeen = true;
        break;
      }
      try {
        return await serveChunk(track, meta, cand, fmt, chunkSel);
      } catch (err) {
        if (err instanceof ApiError && (err.code === "invalid_chunk" || err.code === "chunking_not_supported_for_format" || err.code === "chunks_not_cached")) throw err;
        if (err instanceof ApiError) {
          if (cand.legacy) legacyStatus = Number((err.message.match(/HTTP (\d+)/) ?? [])[1] ?? 0);
          const tag = `[cand=${cand.kind}${cand.legacy ? ",legacy" : ""}${cand.download ? ",dl" : ""}]`;
          lastErr = new ApiError(err.status, err.code, `${err.message} ${tag}`, err.retryAfter, err.details);
          continue;
        }
        const msg = err instanceof Error ? err.message : String(err);
        throw new ApiError(500, "internal", cleanMessage(`${msg} [cand=${cand.kind}${cand.legacy ? ",legacy" : ""}]`));
      }
    }
    // Same end-of-loop priority as the whole-track path: transient legacy
    // throttling first, then the honest DRM answer, then the last real error.
    if (legacyStatus === 429) {
      throw new ApiError(
        502,
        "upstream",
        `SoundCloud's free stream endpoint is rate-limiting us right now (HTTP 429)${drmSeen ? " and this track's other renditions are DRM-protected" : ""}. This is usually temporary - try again in a minute or two.`,
        90,
      );
    }
    if (drmSeen) {
      throw new ApiError(
        415,
        "drm_protected",
        "SoundCloud serves only DRM-encrypted audio for this track (Widevine/FairPlay-protected renditions) and offers no plain download file. SlopCloud does not fetch DRM license keys or use subscriber sessions; if you have the audio file, the site can save it to the cache.",
      );
    }
    throw lastErr ?? new ApiError(403, "not_streamable", "No usable audio rendition found for this track.");
  }

  let lastErr: ApiError | null = null;
  let source: Rendered | null = null;
  let legacyStatus = 0;

  for (const cand of candidates) {
    try {
      const out = await renderCandidate(track, cand);
      // Remember the first (highest-preference) rendition as conversion source.
      source ??= out;
      if (fmt === "auto" || out.ext === fmt) {
        const note = cand.download && fmt === "auto"
          ? "original download file"
          : out.container === "ts"
          ? "stream container converted to adts aac"
          : null;
        if (out.bytes.length > 0) {
          await Promise.all([
            cacheSet(fmKey, metaJsonBytes({ ext: out.ext, mime: out.mime, note })),
            cacheSet(fKey, out.bytes),
          ]);
        }
        const h = audioHeaders(meta, out.ext, out.mime, note, attachment, out.bytes.length);
        h.set("X-SSDA-Cache", "miss");
        return new Response(out.bytes, { status: 200, headers: h });
      }
    } catch (err) {
      if (cand.legacy && err instanceof ApiError) {
        legacyStatus = Number((err.message.match(/HTTP (\d+)/) ?? [])[1] ?? 0);
      }
      if (err instanceof ApiError && (err.code === "unsupported_container" || err.code === "upstream" || err.code === "drm_protected")) {
        lastErr = err;
        continue; // try the next rendition
      }
      throw err;
    }
  }

  // No rendition in the requested format: convert the best one we could render.
  if (fmt !== "auto" && source) {
    const durMs = track.duration ?? 0;
    if (durMs > SINGLE_CONVERT_MAX_MS) {
      // Converting the whole track in one request exceeds this platform's
      // per-request compute budget. Serve the honest chunked recipe instead.
      throw new ApiError(
        413,
        "chunked_conversion_required",
        `Converting a ${Math.round(durMs / 1000)} s track to ${fmt} in one request exceeds this platform's compute budget. ` +
        `Request the audio in chunks instead: add &chunk=info for the chunk count, then fetch &chunk=0 .. &chunk=N-1 ` +
        `(each response is a valid partial ${fmt === "m4a" ? "mp3" : fmt} file) and concatenate them in order.`,
      );
    }
    try {
      const out = await convertAudio(source.bytes, source.ext, fmt);
      const note = `converted from ${source.ext} to ${out.ext}`;
      if (out.bytes.length > 0) {
        await Promise.all([
          cacheSet(fmKey, metaJsonBytes({ ext: out.ext, mime: out.mime, note })),
          cacheSet(fKey, out.bytes),
        ]);
      }
      const h = audioHeaders(meta, out.ext, out.mime, note, attachment, out.bytes.length);
      h.set("X-SSDA-Cache", "miss");
      return new Response(out.bytes, { status: 200, headers: h });
    } catch (err) {
      if (err instanceof ApiError && err.code === "codec_unavailable") throw err;
      // Never silently hand back the wrong format when one was requested,
      // and never leak internal paths/stacks to API clients.
      const why = cleanMessage(err instanceof Error ? err.message : String(err));
      throw new ApiError(
        415,
        "conversion_failed",
        `This track has no ${fmt} rendition and conversion from ${source.ext} failed (${why}). Try format=auto to get the file as-is.`,
      );
    }
  }

  if (legacyStatus === 429) {
    // The free stream endpoint is throttling this datacenter right now. That
    // is temporary by nature; say so honestly instead of blaming the track.
    const drmOnly = (track.media?.transcodings ?? []).every((t) => isEncrypted(t));
    throw new ApiError(
      502,
      "upstream",
      `SoundCloud's free stream endpoint is rate-limiting us right now (HTTP 429)${drmOnly ? " and this track's other renditions are DRM-protected" : ""}. This is usually temporary - try again in a minute or two.`,
      90,
    );
  }
  if (lastErr?.code === "drm_protected") {
    throw new ApiError(
      415,
      "drm_protected",
      "SoundCloud serves only DRM-encrypted audio for this track (Widevine/FairPlay-protected renditions) and offers no plain download file. SlopCloud does not fetch DRM license keys or use subscriber sessions; if you have the audio file, the site can save it to the cache.",
    );
  }
  if (
    lastErr && lastErr.code === "upstream" &&
    (track.media?.transcodings ?? []).length === 0 && !downloadTranscoding(track)
  ) {
    throw new ApiError(
      403,
      "not_streamable",
      "This track cannot be streamed (restricted, or only available with a Go+ subscription). If you just tried again shortly, the track may work on a retry.",
    );
  }
  throw lastErr ??
    new ApiError(403, "not_streamable", "No usable audio rendition found for this track.");
}


// ---------------------------------------------------------------- diagnostics

/**
 * GET /api/audio?...&debug=stage&step=wasm|decode|combo|convert -> run one
 * conversion stage in isolation and report timing/size. Each stage is a
 * separate worker run so a resource kill pinpoints the exact step.
 */
async function runStage(link: string, step: string): Promise<Response> {
  const t0 = Date.now();
  const at = (label: string, extra: Record<string, unknown> = {}) => ({ step, label, ms: Date.now() - t0, ...extra });
  try {
    if (step === "wasm") {
      const wme = await loadWme();
      const wasm = await loadMp3Wasm();
      const enc = await wme.WasmMediaEncoder.create("audio/mpeg", wasm);
      enc.configure({ channels: 2, sampleRate: 44100, bitrate: 320 });
      const n = 44100;
      const sine = new Float32Array(n);
      for (let i = 0; i < n; i++) sine[i] = Math.sin(2 * Math.PI * 440 * i / 44100) * 0.3;
      let size = 0;
      for (let off = 0; off < n; off += 8192) {
        const chunk = sine.subarray(off, Math.min(off + 8192, n));
        size += enc.encode([chunk, chunk]).length;
      }
      size += enc.finalize().length;
      enc.free?.();
      return jsonResponse(at("done", { wasm: wasm.length, mp3: size }));
    }
    if (step === "wasmogg") {
      const { Wme, oggWasm } = await loadOpusEncoder();
      const enc = await Wme.create("audio/ogg", oggWasm);
      enc.configure({ channels: 2, sampleRate: 48000, vbrQuality: 8 });
      const n = 48000;
      const sine = new Float32Array(n);
      for (let i = 0; i < n; i++) sine[i] = Math.sin(2 * Math.PI * 440 * i / 48000) * 0.3;
      let size = 0;
      for (let off = 0; off < n; off += 960) {
        const chunk = sine.subarray(off, Math.min(off + 960, n));
        size += enc.encode([chunk, chunk]).length;
      }
      size += enc.finalize().length;
      enc.free?.();
      return jsonResponse(at("done", { oggWasm: oggWasm.length, out: size }));
    }
    if (step === "lame") {
      const lame = await loadLame();
      const enc = new lame.Mp3Encoder(2, 44100, 320);
      const n = 44100;
      const sine = new Int16Array(n);
      for (let i = 0; i < n; i++) sine[i] = Math.sin(2 * Math.PI * 440 * i / 44100) * 12000;
      let size = 0;
      for (let off = 0; off < n; off += 8192) {
        size += enc.encodeBuffer(sine.subarray(off, Math.min(off + 8192, n)), sine.subarray(off, Math.min(off + 8192, n))).length;
      }
      size += enc.flush().length;
      return jsonResponse(at("done", { mp3: size }));
    }
    if (step === "decode" || step === "combo" || step === "convert") {
      const track = await resolveTrack(link);
      let bytes: Uint8Array | null = null;
      let srcExt = "mp3";
      for (const cand of buildCandidates(track, "auto")) {
        try {
          const out = await renderCandidate(track, cand);
          bytes = out.bytes;
          srcExt = out.ext;
          break;
        } catch {
          // next candidate
        }
      }
      if (!bytes) return jsonResponse(at("no-source"));
      const info: Record<string, unknown> = { srcExt, srcSize: bytes.length, gotSource: Date.now() - t0 };
      if (step === "decode") {
        const pcm = await decodeSegment(bytes, srcExt);
        info.pcmSamples = pcm.channelData.map((c) => c.length);
        return jsonResponse(at("done", info));
      }
      if (step === "combo") {
        const pcm = await decodeSegment(bytes, srcExt);
        info.decoded = Date.now() - t0;
        const wme = await loadWme();
        const wasm = await loadMp3Wasm();
        info.wasmLoaded = Date.now() - t0;
        const enc = await wme.WasmMediaEncoder.create("audio/mpeg", wasm);
        enc.configure({ channels: 2, sampleRate: pcm.sampleRate, bitrate: 320 });
        info.configured = Date.now() - t0;
        let size = 0;
        const n = pcm.channelData[0].length;
        for (let off = 0; off < n; off += 8192) {
          size += enc.encode(pcm.channelData.slice(0, 2).map((c) => c.subarray(off, Math.min(off + 8192, n)))).length;
        }
        info.encoded = Date.now() - t0;
        size += enc.finalize().length;
        enc.free?.();
        return jsonResponse(at("done", { ...info, mp3: size }));
      }
      const out = await convertAudio(bytes, srcExt, "mp3");
      return jsonResponse(at("done", { ...info, mp3: out.bytes.length }));
    }
    return jsonResponse(at("unknown-step"));
  } catch (err) {
    return jsonResponse({ step, ms: Date.now() - t0, error: err instanceof ApiError ? err.code : String((err as Error)?.message || err) });
  }
}

/** GET /api/audio?...&debug=probe -> JSON diagnostics instead of audio bytes. */
async function probeAudio(url: string, fmt: string): Promise<Response> {
  const diag: Record<string, unknown> = { url, requested_format: fmt };
  try {
    const track = await resolveTrack(url);
    diag.track_id = String(track.id);
    diag.policy = track.policy ?? null;
    diag.has_track_authorization = Boolean(track.track_authorization);
    diag.downloadable = track.downloadable ?? null;
    diag.has_downloads_left = track.has_downloads_left ?? null;
    diag.transcodings = (track.media?.transcodings ?? []).map((t) => ({
      url: t.url,
      class: classifyTranscoding(t),
      format: t.format,
    }));
    const candidates = buildCandidates(track, fmt);
    const attempts: unknown[] = [];
    let served: Record<string, unknown> | null = null;
    for (const cand of candidates) {
      const entry: Record<string, unknown> = {
        class: cand.kind,
        transcoding_url: cand.transcoding.url,
        encrypted: cand.encrypted ?? false,
        download: cand.download ?? false,
      };
      try {
        const out = await renderCandidate(track, cand);
        entry.container = out.container;
        entry.ext = out.ext;
        entry.size = out.bytes.length;
        entry.first_bytes_hex = hexPreview(out.bytes);
        entry.stream_url = await streamUrlOf(track, cand);
        entry.debug = out.debug ?? null;
        attempts.push(entry);
        served = served ?? entry;
      } catch (err) {
        entry.error = err instanceof ApiError ? { code: err.code, message: err.message } : String((err as Error)?.message || err);
        attempts.push(entry);
      }
    }
    return jsonResponse({ ...diag, attempts, served });
  } catch (err) {
    diag.error = err instanceof ApiError
      ? { code: err.code, message: err.message }
      : String((err as Error)?.message || err);
    return jsonResponse(diag);
  }
}

// ---------------------------------------------------------------- router

function stripPrefix(pathname: string): string {
  const idx = pathname.lastIndexOf("/ssda");
  const path = idx >= 0 ? pathname.slice(idx + "/ssda".length) : pathname;
  return path === "" ? "/" : path;
}

export async function handleRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    return errorResponse(new ApiError(405, "method_not_allowed", "Only GET is supported."));
  }

  try {
    const url = new URL(req.url);
    const path = stripPrefix(url.pathname);

    if (path === "/" || path === "/api") {
      return jsonResponse(serviceIndex());
    }
    if (path === "/api/health") {
      return jsonResponse({
        ok: true,
        name: SERVICE_NAME,
        version: VERSION,
        cache: cacheBase() ? "on" : "off",
        cache_error: cacheLastError,
      });
    }
    if (path === "/api/info") {
      const link = validateSoundcloudUrl(url.searchParams.get("url") || "");
      try {
        const track = await resolveTrack(link);
        const meta = trackMeta(track, link);
        if (url.searchParams.get("debug")) {
          return jsonResponse({
            ...meta,
            policy: track.policy ?? null,
            transcodings: (track.media?.transcodings ?? []).map((t) => ({
              url: t.url,
              format: t.format,
              quality: t.quality,
              class: classifyTranscoding(t),
            })),
          });
        }
        return jsonResponse(meta);
      } catch (err) {
        // graceful degradation: metadata-only oEmbed fallback
        const fallback = await infoFallback(link);
        if (fallback) return jsonResponse(fallback);
        throw err;
      }
    }
    if (path === "/api/audio" || path === "/api/download") {
      const link = validateSoundcloudUrl(url.searchParams.get("url") || "");
      const fmt = (url.searchParams.get("format") || "auto").toLowerCase();
      if (!FORMATS.includes(fmt)) {
        throw new ApiError(400, "invalid_format", `format must be one of: ${FORMATS.join(", ")}`);
      }
      if (url.searchParams.get("debug") === "probe") {
        return await probeAudio(link, fmt);
      }
      if (url.searchParams.get("debug") === "stage") {
        return await runStage(link, url.searchParams.get("step") || "wasm");
      }
      const chunkRaw = url.searchParams.get("chunk");
      const chunkSel: number | "info" | "all" | null =
        chunkRaw === "info" ? "info"
        : chunkRaw === "all" ? "all"
        : chunkRaw !== null ? Number(chunkRaw)
        : null;
      if (chunkRaw !== null && chunkSel !== "info" && chunkSel !== "all" && !(Number.isInteger(chunkSel) && (chunkSel as number) >= 0)) {
        throw new ApiError(400, "invalid_chunk", "chunk must be a non-negative integer, 'info', or 'all'.");
      }
      return await serveAudio(link, fmt, path === "/api/download", chunkSel);
    }
    return errorResponse(new ApiError(404, "not_found", "No such endpoint."));
  } catch (err) {
    if (err instanceof ApiError) return errorResponse(err);
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse(new ApiError(500, "internal", cleanMessage(message)));
  }
}

declare const Deno: { serve: (handler: (req: Request) => Response | Promise<Response>) => void } | undefined;
if (typeof Deno !== "undefined" && Deno && typeof Deno.serve === "function") {
  Deno.serve((req) => handleRequest(req));
}
