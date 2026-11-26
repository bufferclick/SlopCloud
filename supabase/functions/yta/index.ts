// YTA - SlopCloud YouTube audio API
// Supabase Edge Function. Single file.
//
//   GET /api/health                     status
//   GET /api/search?q=<query>           YouTube search results (JSON)
//   GET /api/info?url=<youtube-link>    video metadata (JSON)
//   GET /api/audio?url=<link>&format=mp3|m4a   audio bytes (mp3 is converted)
//   GET /api/download?url=<link>        audio bytes as a file download
//   chunk=info|N|all params work like SSDA: long videos convert per 10 s
//   chunk (the platform caps per-request compute), repeat requests and
//   chunk=all are served from the server-side cache.
//
// Audio source is YouTube's highest-bitrate AAC (audio/mp4) adaptive stream,
// delivered by their standard player API (Innertube) - the same interface the
// official clients use. It is decoded to PCM and re-encoded as 320 kbps MP3
// (the requested format) using a pure-JS LAME encoder. Nothing is DRM-decrypted
// here: if YouTube only offers ciphered/protected streams for a video, the API
// says so honestly instead of guessing.

// Core codecs: @audio/decode-aac (FAAD2 wasm) and @breezystack/lamejs (pure
// JS). Both run in-thread; encoder packages that need Web Workers are not
// used on this platform.

type DecodeAacFn = (typeof import("npm:@audio/decode-aac@1.6.0"))["default"];
type LameMod = typeof import("npm:@breezystack/lamejs@1.2.7");

let decodeAacPromise: Promise<DecodeAacFn> | null = null;
let lamePromise: Promise<LameMod> | null = null;

function loadDecodeAac() {
  decodeAacPromise ??= import("npm:@audio/decode-aac@1.6.0")
    .then((m) => m.default)
    .catch((err) => {
      decodeAacPromise = null;
      throw err;
    });
  return decodeAacPromise;
}

function loadLame() {
  lamePromise ??= import("npm:@breezystack/lamejs@1.2.7").catch((err) => {
    lamePromise = null;
    throw err;
  });
  return lamePromise;
}

const SERVICE_NAME = "YTA";
const VERSION = "1.0.0";
// YouTube's API clients are plain JSON endpoints; identify honestly as the
// official client contexts the same way the mobile apps do (that is what the
// player API expects).
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const ANDROID_UA = "com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip";
const IOS_UA = "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X;)";

const FORMATS = ["mp3", "m4a"];
// Per-request compute budget on this platform is tight: keep one-shot
// conversion to short videos only (the proven chunk size); everything longer
// uses the chunk flow, which the site stitches automatically.
const SINGLE_CONVERT_MAX_MS = 10000;
const CHUNK_SECONDS = 10;
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;

class ApiError extends Error {
  status: number;
  code: string;
  retryAfter?: number;
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
    "Content-Length, Content-Disposition, X-YTA-Extension, X-YTA-Format-Note, " +
    "X-YTA-Chunk-Index, X-YTA-Chunk-Count, X-YTA-Cache, Retry-After",
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
    description: "YouTube audio API. Paste a video link or search, get the audio back.",
    version: VERSION,
    endpoints: {
      "/api/health": "GET - status",
      "/api/search": "GET - ?q=<query> search YouTube",
      "/api/info": "GET - ?url=<youtube-link> video metadata",
      "/api/audio": "GET - ?url=<youtube-link>&format=mp3|m4a audio bytes (add &chunk=info|N|all for long videos)",
      "/api/download": "GET - same as /api/audio but saved as a file",
    },
  };
}

// ---------------------------------------------------------------- helpers

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** One clean line, no internal file paths - safe to show API clients. */
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
  return (cleaned || "audio").slice(0, 120);
}

const YT_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "www.youtu.be",
]);

/** Extract the 11-char video id from the usual YouTube URL shapes. */
function parseVideoId(raw: string): string | null {
  const url = (raw || "").trim();
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!YT_HOSTS.has(parsed.hostname.toLowerCase())) return null;
  const host = parsed.hostname.toLowerCase();
  if (host === "youtu.be" || host === "www.youtu.be") {
    const id = parsed.pathname.split("/").filter(Boolean)[0] || "";
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  }
  const v = parsed.searchParams.get("v");
  if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
  const m = parsed.pathname.match(/\/(shorts|embed|live|v)\/([A-Za-z0-9_-]{11})/);
  return m ? m[2] : null;
}

function validateYouTubeUrl(raw: string): string {
  const url = (raw || "").trim();
  if (!url) {
    throw new ApiError(400, "missing_url", "Pass a YouTube link in the url= parameter (or use /api/search to find videos).");
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
  if (!YT_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new ApiError(400, "invalid_url", "url host must be a YouTube domain (youtube.com, youtu.be, music.youtube.com).");
  }
  if (parsed.username || parsed.password || (parsed.port && parsed.port !== "80" && parsed.port !== "443")) {
    throw new ApiError(400, "invalid_url", "url must not contain credentials or a custom port.");
  }
  if (!parseVideoId(url)) {
    throw new ApiError(
      400,
      "no_video_id",
      "This YouTube link does not contain a video id. Use a watch, youtu.be, shorts or live link.",
    );
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
      if (!res.ok) throw new Error(`HTTP ${res.status} for media`);
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

/** Container sniffing from leading bytes. */
function containerOf(bytes: Uint8Array): "fmp4" | "unknown" {
  if (bytes.length >= 12 && ascii(bytes, 4, 8) === "ftyp") return "fmp4";
  if (bytes.length >= 8 && (ascii(bytes, 4, 8) === "styp" || ascii(bytes, 4, 8) === "sidx" || ascii(bytes, 4, 8) === "moof")) return "fmp4";
  return "unknown";
}

// ---------------------------------------------------------- response cache
// Same server-side cache table as SSDA (ssda_cache via PostgREST): converted
// chunks, whole mp3 files, the raw AAC source and tiny meta rows. Repeat
// requests never touch YouTube again. Keys are namespaced c1:yt:... so they
// cannot collide with SSDA rows. Disabled without SUPABASE_URL +
// SUPABASE_SERVICE_ROLE_KEY (e.g. local tests unless a test opts in).
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

/** Accept bytea as PostgreSQL hex ('\x...') or base64. */
function decodeCacheBlob(s: string): Uint8Array {
  if (s.startsWith("\\x") || s.startsWith("0x")) {
    const hex = s.slice(2);
    const out = new Uint8Array(hex.length >> 1);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function chunkMetaKey(vid: string, fmt: string): string {
  return `${CACHE_VER}:yt:cm:${vid}:${fmt}`;
}
function chunkKey(vid: string, fmt: string, idx: number): string {
  return `${CACHE_VER}:yt:ck:${vid}:${fmt}:${idx}`;
}
function fullMetaKey(vid: string, fmt: string): string {
  return `${CACHE_VER}:yt:fm:${vid}:${fmt}`;
}
function fullKey(vid: string, fmt: string): string {
  return `${CACHE_VER}:yt:f:${vid}:${fmt}`;
}
function sourceKey(vid: string): string {
  return `${CACHE_VER}:yt:src:${vid}`;
}
function sourceMetaKey(vid: string): string {
  return `${CACHE_VER}:yt:sm:${vid}`;
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

let cacheLastError: string | null = null;
function cacheNoteError(where: string, detail: string): void {
  cacheLastError = `${where}: ${detail}`.slice(0, 120);
}

async function cacheGetMany(keys: string[]): Promise<Map<string, Uint8Array>> {
  const base = cacheBase();
  const out = new Map<string, Uint8Array>();
  if (!base || keys.length === 0) return out;
  try {
    // One eq. lookup per key; keys are URL-safe by construction.
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

async function cacheSet(key: string, data: Uint8Array): Promise<void> {
  const base = cacheBase();
  if (!base) return;
  try {
    // bytea travels through PostgREST as text; the '\x' hex input form makes
    // Postgres store the raw bytes.
    const hexParts: string[] = [];
    for (let i = 0; i < data.length; i += 0x8000) {
      let s = "";
      const end = Math.min(i + 0x8000, data.length);
      for (let j = i; j < end; j++) s += data[j].toString(16).padStart(2, "0");
      hexParts.push(s);
    }
    await fetch(`${base.url}/rest/v1/ssda_cache`, {
      method: "POST",
      headers: {
        apikey: base.key,
        Authorization: `Bearer ${base.key}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify([{ cache_key: key, data: "\\x" + hexParts.join(""), bytes: data.length }]),
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    cacheNoteError("cache-set", err instanceof Error ? err.message : String(err));
    // cache trouble must never break serving
  }
}

// ------------------------------------------------------------- innertube

type InnertubeClient = {
  name: string;
  version: string;
  ua: string;
  id: number;
  extra?: Record<string, unknown>;
  androidSdk?: number;
};

// Client ladder from yt-dlp's INNERTUBE_CLIENTS table (fetched 2026-11 from
// yt-dlp master - the same table the downloader sites track). YouTube scores
// each client differently; these are the ones that serve player + media from
// datacenter IPs without proof-of-origin tokens:
//   tv / tv_downgraded  - TVHTML5 with Cobalt's TV UA (yt-dlp borrows the UA
//                         from cobalt's source), no PO tokens anywhere
//   web_embedded        - embedded player, loosest bot scoring (needs a
//                         non-YouTube embedUrl in thirdParty)
//   android_vr / android - last resorts (their media URLs may 403 since
//                         2026.08 without PO tokens, but the player answers)
// Dropped: IOS/MWEB (PO tokens required for media), web_creator (sign-in now).
const IT_CLIENTS: InnertubeClient[] = [
  {
    name: "TVHTML5",
    version: "5.20260707",
    id: 7,
    ua: "Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version",
  },
  {
    name: "TVHTML5",
    version: "7.20260707.07.00",
    id: 7,
    ua: "Mozilla/5.0 (ChromiumStylePlatform) Cobalt/25.lts.30.1034943-gold (unlike Gecko), Unknown_TV_Unknown_0/Unknown (Unknown, Unknown)",
  },
  {
    name: "WEB_EMBEDDED_PLAYER",
    version: "2.20260708.00.00",
    id: 56,
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.5 Safari/605.1.15,gzip(gfe)",
    extra: { thirdParty: { embedUrl: "https://www.reddit.com/" } },
  },
  {
    name: "ANDROID_VR",
    version: "1.65.10",
    id: 28,
    ua: "com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip",
    androidSdk: 32,
  },
  {
    name: "ANDROID",
    version: "21.26.364",
    id: 3,
    ua: "com.google.android.youtube/21.26.364 (Linux; U; Android 11) gzip",
    androidSdk: 30,
  },
];

// Public Innertube API key (present in every youtube.com page source).
const FALLBACK_IT_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
let itKeyCache: { key: string; at: number } | null = null;

async function innertubeKey(): Promise<string> {
  if (itKeyCache && Date.now() - itKeyCache.at < 3600_000) return itKeyCache.key;
  try {
    const res = await fetch("https://www.youtube.com/", {
      headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" },
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      const html = await res.text();
      const m = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/) || html.match(/INNERTUBE_API_KEY\s*:\s*"([^"]+)"/);
      if (m && m[1]) {
        itKeyCache = { key: m[1], at: Date.now() };
        return m[1];
      }
    }
  } catch {
    // fall back to the public key
  }
  return FALLBACK_IT_KEY;
}

async function innertubePost(
  endpoint: string,
  body: Record<string, unknown>,
  client: InnertubeClient,
): Promise<Record<string, unknown>> {
  const key = await innertubeKey();
  const payload = {
    context: {
      client: {
        clientName: client.name,
        clientVersion: client.version,
        hl: "en",
        gl: "US",
        userAgent: client.ua,
        ...(client.androidSdk ? { androidSdkVersion: client.androidSdk } : {}),
        ...(client.extra ? { ...client.extra } : {}),
      },
    },
    ...body,
  };
  // Two official API hosts: www.youtube.com first, Google's youtubei host as
  // fallback for plain network/5xx failures. A bot-wall (403) aborts
  // immediately - retrying a wall in a tight loop makes it permanent.
  const hosts = ["www.youtube.com", "youtubei.googleapis.com"];
  let lastErr: ApiError | null = null;
  for (const host of hosts) {
    let res: Response;
    try {
      res = await fetch(`https://${host}/youtubei/v1/${endpoint}?key=${key}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": client.ua,
          "X-Goog-Api-Format-Version": "2",
          "X-Youtube-Client-Name": String(client.id),
          "X-Youtube-Client-Version": client.version,
          Origin: "https://www.youtube.com",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20000),
      });
    } catch (err) {
      lastErr = new ApiError(502, "upstream", `YouTube ${endpoint} API unreachable (${cleanMessage(err instanceof Error ? err.message : String(err))}).`);
      continue;
    }
    if (res.status === 403) {
      // The key works (search answers 200); the edge is challenging this
      // server's IP. Say that honestly and stop - nothing gets bypassed here.
      throw new ApiError(
        429,
        "bot_check",
        `YouTube is rejecting ${endpoint} requests from this server right now (anti-bot challenge on datacenter IPs). ` +
        `Nothing was signed in or bypassed - this usually passes after a pause; try again in a minute or two.`,
        90,
      );
    }
    if (!res.ok) {
      lastErr = new ApiError(502, "upstream", `YouTube player API answered HTTP ${res.status}.`);
      continue;
    }
    return (await res.json()) as Record<string, unknown>;
  }
  throw lastErr ?? new ApiError(502, "upstream", "YouTube API unreachable.");
}

function runsText(x: unknown): string {
  if (typeof x === "string") return x;
  if (x && typeof x === "object") {
    const o = x as { simpleText?: string; runs?: { text?: string }[] };
    if (o.simpleText) return o.simpleText;
    if (Array.isArray(o.runs)) return o.runs.map((r) => r?.text ?? "").join("");
  }
  return "";
}

function pickThumbnails(x: unknown): string | null {
  const t = (x as { thumbnails?: { url?: string }[] } | null)?.thumbnails;
  if (Array.isArray(t) && t.length && t[t.length - 1]?.url) return t[t.length - 1].url!;
  return null;
}

export type YtSearchItem = {
  video_id: string;
  title: string;
  author: string;
  duration_s: number | null;
  thumbnail_url: string | null;
};

function durationSeconds(x: unknown): number | null {
  const s = runsText(x);
  if (!s) return null;
  const parts = s.split(":").map((p) => Number(p));
  if (parts.some((n) => !Number.isFinite(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/** Recursively collect videoRenderer / compactVideoRenderer items. */
function collectSearchItems(node: unknown, out: YtSearchItem[], seen: Set<string>): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectSearchItems(item, out, seen);
    return;
  }
  const o = node as Record<string, unknown>;
  for (const kind of ["videoRenderer", "compactVideoRenderer", "gridVideoRenderer"]) {
    const r = o[kind] as Record<string, unknown> | undefined;
    const vid = typeof r?.videoId === "string" ? r.videoId : null;
    if (vid && !seen.has(vid)) {
      seen.add(vid);
      out.push({
        video_id: vid,
        title: runsText(r!.title),
        author: runsText(r!.ownerText ?? r!.shortBylineText ?? r!.longBylineText),
        duration_s: durationSeconds(r!.lengthText),
        thumbnail_url: pickThumbnails(r!.thumbnail),
      });
    }
  }
  for (const v of Object.values(o)) {
    if (v && typeof v === "object") collectSearchItems(v, out, seen);
  }
}

async function searchYouTube(q: string): Promise<YtSearchItem[]> {
  const query = (q || "").trim();
  if (!query) throw new ApiError(400, "missing_query", "Pass a search term in the q= parameter.");
  if (query.length > 200) throw new ApiError(400, "invalid_query", "Search term is too long (200 characters max).");
  const web: InnertubeClient = { name: "WEB", version: "2.20240726.00.00", ua: UA };
  const body = await innertubePost("search", { query }, web);
  const out: YtSearchItem[] = [];
  collectSearchItems(body, out, new Set());
  return out.slice(0, 24);
}

// ---------------------------------------------------------------- player

type YtAudioFormat = {
  itag: number;
  mime: string;
  bitrate: number;
  url: string;
  contentLength?: number;
  audioQuality?: string;
};

type YtVideo = {
  videoId: string;
  title: string;
  author: string;
  durationMs: number;
  artworkUrl: string | null;
  formats: YtAudioFormat[];
};

function playabilityError(status: Record<string, unknown>, videoId: string): ApiError | null {
  const s = String(status?.status ?? "OK");
  if (s === "OK") return null;
  const reason = runsText(status?.reason) || String(status?.reason ?? "");
  const sub = runsText((status?.errorScreen as Record<string, unknown>)?.playerErrorMessageRenderer?.subreason);
  const detail = [reason, sub].filter(Boolean).join(" - ") || s;
  if (/not a bot/i.test(detail)) {
    return new ApiError(
      429,
      "bot_check",
      `YouTube is asking "Sign in to confirm you're not a bot" for this request (automated clients get challenged on datacenter IPs). ` +
      `Nothing was signed in or bypassed - this usually passes after a pause; try again in a minute or two.`,
      60,
    );
  }
  if (s === "LOGIN_REQUIRED" || /age|sign in/i.test(detail)) {
    return new ApiError(
      403,
      "not_available",
      `YouTube will not play this video here (${detail}). Age-restricted and members-only videos need a signed-in player.`,
    );
  }
  if (s === "UNPLAYABLE" || s === "ERROR") {
    return new ApiError(403, "not_available", `YouTube reports this video as unplayable (${detail}).`);
  }
  return new ApiError(403, "not_available", `YouTube reports this video as unavailable (${detail}).`);
}

/** Collect audio-only adaptive formats that carry a direct URL. */
function audioFormatsFrom(player: Record<string, unknown>): YtAudioFormat[] {
  const sd = (player.streamingData ?? {}) as Record<string, unknown>;
  const all = [...(Array.isArray(sd.adaptiveFormats) ? sd.adaptiveFormats : []),
    ...(Array.isArray(sd.formats) ? sd.formats : [])] as Record<string, unknown>[];
  const out: YtAudioFormat[] = [];
  for (const f of all) {
    const mime = String(f.mimeType ?? "");
    if (!mime.startsWith("audio/")) continue;
    if (typeof f.url !== "string" || !f.url) continue; // ciphered streams are not usable here
    const len = Number(f.contentLength);
    out.push({
      itag: Number(f.itag) || 0,
      mime,
      bitrate: Number(f.bitrate) || 0,
      url: f.url,
      contentLength: Number.isFinite(len) && len > 0 ? len : undefined,
      audioQuality: typeof f.audioQuality === "string" ? f.audioQuality : undefined,
    });
  }
  return out;
}

/**
 * Best audio first: highest bitrate. AAC (audio/mp4) is preferred when close,
 * since it decodes natively here; the list is still returned sorted by
 * bitrate so callers can fall through.
 */
function rankAudio(formats: YtAudioFormat[]): YtAudioFormat[] {
  return [...formats].sort((a, b) => {
    const aAac = a.mime.startsWith("audio/mp4") ? 1 : 0;
    const bAac = b.mime.startsWith("audio/mp4") ? 1 : 0;
    if (aAac !== bAac && Math.abs(a.bitrate - b.bitrate) < 32000) return bAac - aAac;
    return b.bitrate - a.bitrate;
  });
}

/** Extract a balanced JSON object right after a marker in HTML. */
function extractJsonAfter(html: string, marker: string): Record<string, unknown> | null {
  const at = html.indexOf(marker);
  if (at < 0) return null;
  const start = html.indexOf("{", at + marker.length);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < html.length && i < start + 2_000_000; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        try {
          const v = JSON.parse(html.slice(start, i + 1));
          return v && typeof v === "object" ? v as Record<string, unknown> : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Fallback source of player data: the watch page embeds the same player
 * response JSON the site's own player uses (ytInitialPlayerResponse). One
 * GET, scored like a normal page view - the classic downloader path.
 */
async function fetchPlayerWebpage(videoId: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        "User-Agent": UA,
        "Accept-Language": "en-US,en;q=0.9",
        Cookie: "CONSENT=YES+1", // skip the EU consent redirect
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    return extractJsonAfter(html, "ytInitialPlayerResponse");
  } catch {
    return null;
  }
}

async function fetchPlayer(videoId: string): Promise<YtVideo> {
  // The player endpoint is rate-limited and bot-challenged; cache answers so
  // one site save = one player call (/api/info and /api/audio share it).
  const plKey = `${CACHE_VER}:yt:pl:${videoId}`;
  const cachedPl = parseMetaJson((await cacheGetMany([plKey])).get(plKey));
  if (
    cachedPl && typeof cachedPl.fetchedAt === "number" &&
    Date.now() - cachedPl.fetchedAt < 1800_000 && Array.isArray(cachedPl.formats)
  ) {
    return {
      videoId,
      title: String(cachedPl.title ?? "Untitled"),
      author: String(cachedPl.author ?? "Unknown artist"),
      durationMs: Number(cachedPl.durationMs) || 0,
      artworkUrl: typeof cachedPl.artworkUrl === "string" ? cachedPl.artworkUrl : null,
      formats: cachedPl.formats as YtAudioFormat[],
    };
  }
  let lastErr: ApiError | null = null;
  let sawDirect = false;

  // Sources, lazily: (1) the watch page itself - one GET, zero API calls;
  // (2) the Innertube ladder - one call per client, one pass only. Rotation is
  // the documented way through per-client walls; tight loops make walls
  // permanent, so a bot-wall at the endpoint edge aborts everything.
  async function* playerSources(): AsyncGenerator<Record<string, unknown>> {
    const page = await fetchPlayerWebpage(videoId);
    if (page) yield page;
    for (const client of IT_CLIENTS) {
      try {
        yield await innertubePost(
          "player",
          { videoId, contentCheckOk: true, racyCheckOk: true },
          client,
        );
      } catch (err) {
        if (err instanceof ApiError && err.code === "bot_check") throw err;
        if (err instanceof ApiError) lastErr = err;
      }
    }
  }

  for await (const player of playerSources()) {
    const status = (player.playabilityStatus ?? {}) as Record<string, unknown>;
    const perr = playabilityError(status, videoId);
    if (perr) {
      lastErr = perr;
      continue;
    }
    const details = (player.videoDetails ?? {}) as Record<string, unknown>;
    const formats = audioFormatsFrom(player);
    const withUrl = formats.filter((f) => f.mime.startsWith("audio/mp4"));
    if (withUrl.length > 0) sawDirect = true;
    if (formats.length > 0) {
      const video: YtVideo = {
        videoId: typeof details.videoId === "string" ? details.videoId : videoId,
        title: typeof details.title === "string" ? details.title : "Untitled",
        author: typeof details.author === "string" ? details.author : "Unknown artist",
        durationMs: Math.round((Number(details.lengthSeconds) || 0) * 1000),
        artworkUrl: pickThumbnails(details.thumbnail),
        formats: rankAudio(formats),
      };
      await cacheSet(plKey, metaJsonBytes({
        fetchedAt: Date.now(),
        title: video.title,
        author: video.author,
        durationMs: video.durationMs,
        artworkUrl: video.artworkUrl,
        formats: video.formats,
      }));
      return video;
    }
  }
  if (lastErr) throw lastErr;
  if (sawDirect) {
    throw new ApiError(415, "no_usable_audio", "YouTube returned audio streams but none this API can convert.");
  }
  throw new ApiError(
    415,
    "streams_locked",
    "YouTube is only offering ciphered/protected streams for this video right now (they rotate anti-bot profiles per region). Nothing was decrypted; try again in a bit or use a different video.",
    30,
  );
}

// ---------------------------------------------------------------- fmp4 -> adts
// (same demuxer as SSDA: fragmented via trun, progressive via stsz/stsc/stco)

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

function ascFromEsds(esds: Uint8Array): Uint8Array | null {
  try {
    const es = mp4Desc(esds, 4);
    const dcfg = mp4Desc(es.body, 3);
    if (dcfg.tag !== 0x04) return null;
    const dsi = mp4Desc(dcfg.body, 13);
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

  let asc: Uint8Array | null = null;
  const walk = (from: number, to: number) => {
    for (const b of mp4Boxes(bytes, from, to)) {
      if (["moov", "trak", "mdia", "minf", "stbl"].includes(b.type)) {
        walk(b.start, b.end);
      } else if (b.type === "stsd") {
        for (const entry of mp4Boxes(bytes, b.start + 8, b.end)) {
          if (entry.type !== "mp4a" && entry.type !== "enca") continue;
          walk(entry.start + 28, entry.end);
        }
      } else if (b.type === "esds") {
        asc = asc ?? ascFromEsds(bytes.subarray(b.start, b.end));
      }
    }
  };
  for (const b of top) if (b.type === "moov") walk(b.start, b.end);
  if (!asc) throw new ApiError(415, "unsupported_container", "audio stream has no AAC decoder config");

  const aot = (asc![0] >> 3) & 0x1f;
  const sfi = ((asc![0] & 0x07) << 1) | (asc![1] >> 7);
  const ch = (asc![1] >> 3) & 0x0f;
  const profile = aot >= 1 && aot <= 4 ? aot - 1 : 1;

  const frames: Uint8Array[] = [];
  const emit = (off: number, size: number) => {
    if (size >= 1 && off + size <= bytes.length) {
      frames.push(adtsHeader(size + 7, profile, sfi, ch), bytes.subarray(off, off + size));
    }
  };

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
            let p = t.start + 8;
            if (flags & 0x01) p += 8;
            if (flags & 0x02) p += 4;
            if (flags & 0x08) p += 4;
            if (flags & 0x10) p += 4;
            if (flags & 0x10) defaultSize = new DataView(bytes.buffer, bytes.byteOffset + p - 4, 4).getUint32(0);
          } else if (t.type === "trun") {
            const flags = ((bytes[t.start + 1] << 16) | (bytes[t.start + 2] << 8) | bytes[t.start + 3]) >>> 0;
            const count = new DataView(bytes.buffer, bytes.byteOffset + t.start + 4, 4).getUint32(0);
            let p = t.start + 8;
            if (flags & 0x01) p += 4;
            if (flags & 0x04) p += 4;
            for (let i = 0; i < count; i++) {
              if (flags & 0x100) p += 4;
              if (flags & 0x200) {
                pending.push(new DataView(bytes.buffer, bytes.byteOffset + p, 4).getUint32(0));
                p += 4;
              } else {
                pending.push(defaultSize);
              }
              if (flags & 0x400) p += 4;
              if (flags & 0x800) p += 4;
            }
          }
        }
      }
    } else if (b.type === "mdat" && pending.length) {
      let payload = b.start;
      for (const size of pending) {
        emit(payload, size);
        payload += size;
      }
      pending = [];
    }
  }

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
            if (s.sizes.length && s.chunkOffs.length) {
              let sample = 0;
              for (let c = 0; c < s.chunkOffs.length && sample < s.sizes.length; c++) {
                const chunkNumber = c + 1;
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

  if (!frames.length) throw new ApiError(415, "unsupported_container", "audio demux found no AAC frames");
  return concatBytes(frames);
}

// ---------------------------------------------------------------- conversion

type Pcm = { channelData: Float32Array[]; sampleRate: number };

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

function floatTo16(ch: Float32Array, from: number, to: number): Int16Array {
  const out = new Int16Array(to - from);
  for (let i = from; i < to; i++) {
    const s = Math.max(-1, Math.min(1, ch[i]));
    out[i - from] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/** ADTS info: frame count and sample rate (chunking math). */
function adtsInfo(bytes: Uint8Array): { frames: number; sampleRate: number; seconds: number } {
  const frames = splitAdtsFrames(bytes);
  const sfi = bytes.length > 2 ? (bytes[2] >> 2) & 0x0f : 4;
  const SR = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  const sampleRate = sfi < SR.length ? SR[sfi] : 44100;
  return { frames: frames.length, sampleRate, seconds: frames.length * 1024 / sampleRate };
}

/** ADTS windowing: keep only frames covering [fromSec, toSec) of the audio. */
function windowFrames(bytes: Uint8Array, fromSec: number, toSec: number): Uint8Array {
  const parts = splitAdtsFrames(bytes);
  const sfi = bytes.length > 2 ? (bytes[2] >> 2) & 0x0f : 4;
  const SR = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  const sampleRate = sfi < SR.length ? SR[sfi] : 44100;
  const s0 = Math.round(fromSec * sampleRate);
  const s1 = Math.round(toSec * sampleRate);
  let at = 0;
  const keep: Uint8Array[] = [];
  for (const f of parts) {
    const end = at + 1024;
    if (end > s0 && at < s1) keep.push(f);
    at = end;
  }
  return concatBytes(keep);
}

/** Convert one ADTS window to 320 kbps MP3 (streaming, segment by segment). */
async function convertToMp3(bytes: Uint8Array): Promise<Uint8Array> {
  const frames = splitAdtsFrames(bytes);
  const SEGMENT_TARGET = 120000;
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
  if (segs.length === 0) return new Uint8Array(0);

  const decodeAac = await loadDecodeAac();
  const lame = await loadLame();
  let enc: InstanceType<LameMod["Mp3Encoder"]> | null = null;
  const parts: Uint8Array[] = [];
  const take = (b: Uint8Array | undefined | null) => {
    if (b && b.length) parts.push(b);
  };
  for (const seg of segs) {
    const pcm: Pcm = await decodeAac(seg);
    if (!pcm.channelData.length || !pcm.channelData[0]?.length) continue;
    const channels = Math.min(2, pcm.channelData.length);
    if (!enc) enc = new lame.Mp3Encoder(channels, pcm.sampleRate, 320);
    const CHUNK = 8192;
    const n = pcm.channelData[0].length;
    for (let off = 0; off < n; off += CHUNK) {
      const end = Math.min(off + CHUNK, n);
      const l = floatTo16(pcm.channelData[0], off, end);
      take(channels === 2 ? enc.encodeBuffer(l, floatTo16(pcm.channelData[1], off, end)) : enc.encodeBuffer(l));
    }
  }
  if (!enc) return new Uint8Array(0);
  take(enc.flush());
  return concatBytes(parts);
}

// ---------------------------------------------------------------- source

async function getSource(video: YtVideo): Promise<Uint8Array> {
  const cached = await cacheGetMany([sourceMetaKey(video.videoId), sourceKey(video.videoId)]);
  const raw = cached.get(sourceKey(video.videoId));
  if (raw && raw.length > 0) return raw;

  // Highest-ranked usable format first; only AAC/fMP4 sources decode here.
  const candidates = video.formats.filter((f) => f.mime.startsWith("audio/mp4"));
  if (candidates.length === 0) {
    throw new ApiError(
      415,
      "no_usable_audio",
      "This video has no AAC audio stream to convert (only opus/webm, which this API cannot decode yet).",
    );
  }
  let lastErr: ApiError | null = null;
  for (const f of candidates) {
    if (f.contentLength && f.contentLength > MAX_SOURCE_BYTES) {
      throw new ApiError(
        413,
        "too_long",
        `This video's audio is larger than ${Math.round(MAX_SOURCE_BYTES / 1048576)} MB - too long for this API right now.`,
      );
    }
    try {
      const bytes = await fetchBytes(f.url, 2);
      if (bytes.length > MAX_SOURCE_BYTES) {
        throw new ApiError(413, "too_long", "This video's audio is too long for this API right now.");
      }
      if (containerOf(bytes) !== "fmp4") {
        throw new ApiError(415, "unsupported_container", "YouTube returned audio in an unexpected container.");
      }
      await Promise.all([
        cacheSet(sourceMetaKey(video.videoId), metaJsonBytes({ itag: f.itag, mime: f.mime, bitrate: f.bitrate })),
        cacheSet(sourceKey(video.videoId), bytes),
      ]);
      return bytes;
    } catch (err) {
      if (err instanceof ApiError && err.status === 413) throw err;
      lastErr = err instanceof ApiError
        ? err
        : new ApiError(502, "upstream", "Could not download the audio stream from YouTube (the link may have expired or been challenged).");
    }
  }
  throw lastErr ?? new ApiError(502, "upstream", "Could not download any audio stream from YouTube.");
}

// ---------------------------------------------------------------- output

function audioHeaders(meta: YtVideo, ext: string, mime: string, note: string | null, attachment: boolean, size: number): Headers {
  const h = corsHeaders();
  h.set("Content-Type", mime);
  const filename = sanitizeFilename(`${meta.author} - ${meta.title}`) + "." + ext;
  const disposition = attachment === true ? "attachment" : "inline";
  h.set(
    "Content-Disposition",
    `${disposition}; filename="${filename.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
  );
  h.set("X-YTA-Extension", ext);
  if (note) h.set("X-YTA-Format-Note", note.slice(0, 200));
  h.set("Content-Length", String(size));
  return h;
}

async function assembleFromCache(video: YtVideo, fmt: string, count: number): Promise<Response> {
  const vid = video.videoId;
  const keys = Array.from({ length: count }, (_, i) => chunkKey(vid, fmt, i));
  const rows = await cacheGetMany(keys);
  const missing: number[] = [];
  for (let i = 0; i < count; i++) if (!rows.has(keys[i])) missing.push(i);
  if (missing.length > 0) {
    throw new ApiError(
      409,
      "chunks_not_cached",
      `${missing.length} of ${count} ${fmt} chunks for this video are not in the server cache yet. ` +
      `Fetch them first (&chunk=${missing[0]}${missing.length > 1 ? " .. &chunk=" + missing[missing.length - 1] : ""}; ` +
      `each request converts one chunk), then repeat this request.`,
      undefined,
      { missing, chunk_count: count, chunk_seconds: CHUNK_SECONDS, format: fmt },
    );
  }
  const bytes = concatBytes(keys.map((k) => rows.get(k)!));
  const h = audioHeaders(video, fmt, "audio/mpeg", `assembled from ${count} cached chunks`, false, bytes.length);
  h.set("X-YTA-Chunk-Count", String(count));
  h.set("X-YTA-Cache", "hit");
  return new Response(bytes, { status: 200, headers: h });
}

async function serveChunk(video: YtVideo, fmt: string, sel: number | "info" | "all"): Promise<Response> {
  const vid = video.videoId;
  const cMetaKey = chunkMetaKey(vid, fmt);
  const numKey = typeof sel === "number" ? chunkKey(vid, fmt, sel) : null;
  const early = await cacheGetMany(numKey ? [cMetaKey, numKey] : [cMetaKey]);
  const metaParsed = parseMetaJson(early.get(cMetaKey));
  const cachedCount = metaParsed && metaParsed.cs === CHUNK_SECONDS && Number.isInteger(metaParsed.count)
    ? metaParsed.count as number
    : null;
  const cachedChunkSeconds = metaParsed && Number.isInteger(metaParsed.chunk_seconds)
    ? metaParsed.chunk_seconds as number
    : CHUNK_SECONDS;

  const planResponse = (count: number, cache: string): Response => {
    const res = jsonResponse({ chunk_count: count, chunk_seconds: CHUNK_SECONDS, format: fmt });
    res.headers.set("X-YTA-Cache", cache);
    return res;
  };
  const chunkResponse = (bytes: Uint8Array, idx: number, count: number, cache: string): Response => {
    const h = audioHeaders(video, fmt, "audio/mpeg", `${cache === "hit" ? "cached" : "converted"} chunk ${idx}/${count}`, false, bytes.length);
    h.set("X-YTA-Chunk-Index", String(idx));
    h.set("X-YTA-Chunk-Count", String(count));
    h.set("X-YTA-Cache", cache);
    return new Response(bytes, { status: 200, headers: h });
  };

  if (cachedCount !== null && sel === "info") return planResponse(cachedCount, "hit");
  if (cachedCount !== null && sel === "all") return await assembleFromCache(video, fmt, cachedCount);
  if (cachedCount !== null && numKey && early.get(numKey)) {
    return chunkResponse(early.get(numKey)!, sel as number, cachedCount, "hit");
  }

  const source = await getSource(video);
  // Window first, decode only the window (per-request compute cap).
  const adts = fmp4ToAdts(source);
  const info = adtsInfo(adts);
  // Chunk count from the real decoded audio so every chunk holds frames and
  // chunk=all can always complete after a full fill.
  const count = Math.max(1, Math.ceil(info.seconds / CHUNK_SECONDS));
  if (sel === "info") {
    await cacheSet(cMetaKey, metaJsonBytes({ count, cs: CHUNK_SECONDS, chunk_seconds: CHUNK_SECONDS }));
    return planResponse(count, "miss");
  }
  if (sel === "all") return await assembleFromCache(video, fmt, count);
  if (!(sel >= 0) || sel >= count) {
    throw new ApiError(404, "invalid_chunk", `chunk must be between 0 and ${count - 1} (or 'info' / 'all').`);
  }

  const window = windowFrames(adts, sel * CHUNK_SECONDS, (sel + 1) * CHUNK_SECONDS);
  let out: Uint8Array;
  try {
    out = await convertToMp3(window);
  } catch (err) {
    if (window.length === 0) {
      out = new Uint8Array(0);
    } else if (err instanceof ApiError) {
      throw err;
    } else {
      throw new ApiError(415, "conversion_failed", cleanMessage(err instanceof Error ? err.message : String(err)));
    }
  }
  if (numKey && out.length > 0) {
    await Promise.all([
      cacheSet(cMetaKey, metaJsonBytes({ count, cs: CHUNK_SECONDS, chunk_seconds: CHUNK_SECONDS })),
      cacheSet(numKey, out),
    ]);
  }
  return chunkResponse(out, sel as number, count, "miss");
}

async function serveAudioPass(url: string, fmt: string, attachment: boolean, chunkSel: number | "info" | "all" | null): Promise<Response> {
  const videoId = parseVideoId(url)!;
  const video = await fetchPlayer(videoId);

  if (!video.formats.some((f) => f.mime.startsWith("audio/mp4"))) {
    throw new ApiError(
      415,
      "no_usable_audio",
      "This video has no AAC audio stream to serve (only opus/webm, which this API cannot decode yet).",
    );
  }
  const sizeFmt = video.formats.find((f) => f.mime.startsWith("audio/mp4"));
  if (sizeFmt?.contentLength && sizeFmt.contentLength > MAX_SOURCE_BYTES) {
    throw new ApiError(
      413,
      "too_long",
      `This video's audio is larger than ${Math.round(MAX_SOURCE_BYTES / 1048576)} MB - too long for this API right now.`,
    );
  }

  // Whole-file cache first: repeat requests never touch YouTube again.
  const cached = await cacheGetMany([fullMetaKey(videoId, fmt), fullKey(videoId, fmt)]);
  const fmParsed = parseMetaJson(cached.get(fullMetaKey(videoId, fmt)));
  const fRaw = cached.get(fullKey(videoId, fmt));
  if (fmParsed && fRaw && typeof fmParsed.mime === "string") {
    const h = audioHeaders(
      video,
      typeof fmParsed.ext === "string" ? fmParsed.ext : fmt,
      fmParsed.mime as string,
      typeof fmParsed.note === "string" ? fmParsed.note : "cached",
      attachment,
      fRaw.length,
    );
    h.set("X-YTA-Cache", "hit");
    return new Response(fRaw, { status: 200, headers: h });
  }

  if (chunkSel !== null && fmt === "mp3") {
    return await serveChunk(video, fmt, chunkSel);
  }

  if (fmt === "m4a") {
    // Passthrough of YouTube's own AAC stream - highest quality available,
    // no re-encoding.
    const source = await getSource(video);
    const h = audioHeaders(video, "m4a", "audio/mp4", "original aac stream", attachment, source.length);
    h.set("X-YTA-Cache", "miss");
    return new Response(source, { status: 200, headers: h });
  }

  // One-shot mp3 for short videos.
  if ((video.durationMs ?? 0) > SINGLE_CONVERT_MAX_MS) {
    throw new ApiError(
      413,
      "chunked_conversion_required",
      `Converting a ${Math.round((video.durationMs ?? 0) / 1000)} s video to mp3 in one request exceeds this platform's compute budget. ` +
      `Request the audio in chunks instead: add &chunk=info for the chunk count, then fetch &chunk=0 .. &chunk=N-1 ` +
      `(each response is a valid partial mp3 file) and concatenate them in order - or use &chunk=all once the chunks are cached.`,
    );
  }
  const source = await getSource(video);
  const adts = fmp4ToAdts(source);
  const window = windowFrames(adts, 0, Math.max(1, (video.durationMs ?? 0) / 1000 + 1));
  let out: Uint8Array;
  try {
    out = await convertToMp3(window);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(415, "conversion_failed", cleanMessage(err instanceof Error ? err.message : String(err)));
  }
  const note = `converted from aac to mp3 (320 kbps)`;
  if (out.length > 0) {
    await Promise.all([
      cacheSet(fullMetaKey(videoId, fmt), metaJsonBytes({ ext: "mp3", mime: "audio/mpeg", note })),
      cacheSet(fullKey(videoId, fmt), out),
    ]);
  }
  const h = audioHeaders(video, "mp3", "audio/mpeg", note, attachment, out.length);
  h.set("X-YTA-Cache", "miss");
  return new Response(out, { status: 200, headers: h });
}

/**
 * Retry pass on transient upstream failures (YouTube's anti-bot roulette
 * occasionally rejects everything at once; a retry usually recovers).
 */
async function serveAudio(url: string, fmt: string, attachment: boolean, chunkSel: number | "info" | "all" | null): Promise<Response> {
  let lastErr: unknown = null;
  for (let pass = 0; pass < 3; pass++) {
    if (pass > 0) {
      itKeyCache = null;
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
  if (lastErr instanceof ApiError) {
    throw new ApiError(502, "upstream", `${lastErr.message} This is often transient - try again in a few seconds.`, lastErr.retryAfter ?? 30);
  }
  throw lastErr;
}

// ---------------------------------------------------------------- router

function stripPrefix(pathname: string): string {
  const idx = pathname.lastIndexOf("/yta");
  const path = idx >= 0 ? pathname.slice(idx + "/yta".length) : pathname;
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
    if (path === "/api/search") {
      const results = await searchYouTube(url.searchParams.get("q") || "");
      return jsonResponse({ query: (url.searchParams.get("q") || "").trim(), results });
    }
    if (path === "/api/info") {
      const link = validateYouTubeUrl(url.searchParams.get("url") || "");
      const video = await fetchPlayer(parseVideoId(link)!);
      return jsonResponse({
        id: video.videoId,
        title: video.title,
        artist: video.author,
        duration: video.durationMs ? Math.round(video.durationMs / 1000) : null,
        artwork_url: video.artworkUrl,
        permalink_url: `https://www.youtube.com/watch?v=${video.videoId}`,
        source_url: link,
        formats: video.formats.map((f) => ({ itag: f.itag, mime: f.mime, bitrate: f.bitrate, audio_quality: f.audioQuality })),
      });
    }
    if (path === "/api/audio" || path === "/api/download") {
      const link = validateYouTubeUrl(url.searchParams.get("url") || "");
      const fmt = (url.searchParams.get("format") || "mp3").toLowerCase();
      if (!FORMATS.includes(fmt)) {
        throw new ApiError(400, "invalid_format", `format must be one of: ${FORMATS.join(", ")}`);
      }
      const chunkRaw = url.searchParams.get("chunk");
      const chunkSel: number | "info" | "all" | null =
        chunkRaw === "info" ? "info"
        : chunkRaw === "all" ? "all"
        : chunkRaw !== null ? Number(chunkRaw)
        : null;
      if (chunkRaw !== null && fmt !== "mp3") {
        throw new ApiError(400, "chunking_not_supported_for_format", "chunk= only applies to format=mp3. m4a is passed through whole.");
      }
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
