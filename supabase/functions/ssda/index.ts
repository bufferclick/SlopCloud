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

import { Conversion, Input, Output, BufferTarget, BufferSource, Mp3OutputFormat, Mp4OutputFormat, Mp4InputFormat, Mp3InputFormat, WaveInputFormat, OggInputFormat, AdtsInputFormat, FlacInputFormat } from "npm:mediabunny@1.66.2";
import { registerMp3Encoder } from "npm:@mediabunny/mp3-encoder@1.66.2";
import { registerAacEncoder } from "npm:@mediabunny/aac-encoder@1.66.2";
import decodeAacFile from "npm:@audio/decode-aac@1.6.0";
import decodeMp3File from "npm:@audio/decode-mp3@1.3.1";
import { WasmMediaEncoder } from "npm:wasm-media-encoders@0.7.0";
import oggWasm from "npm:wasm-media-encoders@0.7.0/wasm/ogg.wasm" with { type: "bytes" };

registerMp3Encoder();
registerAacEncoder();

const SERVICE_NAME = "SSDA";
const VERSION = "2.6.0";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const ALLOWED_HOSTS = new Set([
  "soundcloud.com",
  "www.soundcloud.com",
  "m.soundcloud.com",
  "on.soundcloud.com",
  "snd.sc",
]);

const FORMATS = ["auto", "m4a", "mp3", "opus"];

class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
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
    "Content-Length, Content-Disposition, X-SSDA-Extension, X-SSDA-Format-Note",
  );
  return h;
}

function jsonResponse(data: unknown, status = 200): Response {
  const h = corsHeaders();
  h.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { status, headers: h });
}

function errorResponse(err: ApiError): Response {
  return jsonResponse({ error: { code: err.code, message: err.message } }, err.status);
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
      "/api/audio": "GET - ?url=<soundcloud-link>&format=auto|m4a|mp3|opus audio bytes",
      "/api/download": "GET - same as /api/audio but saved as a file",
    },
  };
}

// ---------------------------------------------------------------- helpers

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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

function findClientId(text: string): string | null {
  for (const re of CLIENT_ID_PATTERNS) {
    const m = text.match(re);
    if (m) return m[1];
  }
  return null;
}

/** Fetch one page and look for the client_id inline and in its JS bundles. */
async function scanPageForClientId(page: string): Promise<string | null> {
  const res = await fetch(page, {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return null;
  const html = await res.text();

  const inline = findClientId(html);
  if (inline) return inline;

  const assets = [...new Set(
    [...html.matchAll(/(?:https?:)?\/\/(?:[a-z0-9-]+\.)?sndcdn\.com\/assets\/[A-Za-z0-9._-]+\.js/g)]
      .map((m) => (m[0].startsWith("//") ? "https:" + m[0] : m[0])),
  )];
  if (assets.length === 0) return null;
  assets.reverse(); // newest bundles first

  const queue = [...assets];
  let scanned = 0;
  while (queue.length > 0 && scanned < 20) {
    const batch = queue.splice(0, 5);
    scanned += batch.length;
    const results = await Promise.allSettled(
      batch.map(async (u) => {
        const r = await fetch(u, {
          headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" },
          signal: AbortSignal.timeout(15000),
        });
        return r.ok ? await r.text() : "";
      }),
    );
    for (const r of results) {
      if (r.status !== "fulfilled") continue;
      const cid = findClientId(r.value);
      if (cid) return cid;
    }
  }
  return null;
}

async function getClientId(): Promise<string> {
  if (clientIdCache && Date.now() - clientIdCache.at < CLIENT_ID_TTL) return clientIdCache.id;

  // SoundCloud intermittently serves bot-challenge pages (no asset bundles),
  // especially under concurrent requests: rotate entry pages with retries.
  for (const page of ENTRY_PAGES) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const cid = await scanPageForClientId(page);
        if (cid) {
          clientIdCache = { id: cid, at: Date.now() };
          return cid;
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
  );
}

// ---------------------------------------------------------------- resolve

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
    try {
      const hop = await fetch(target, {
        method: "HEAD",
        redirect: "manual",
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(15000),
      });
      const loc = hop.headers.get("location");
      if (loc) target = new URL(loc, target).href;
    } catch {
      // keep the short link; resolve may still accept it
    }
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
  for (let attempt = 0; attempt < 3; attempt++) {
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
      throw new ApiError(429, "rate_limited", "SoundCloud is rate-limiting requests. Try again shortly.");
    }
    if (!res.ok) continue;

    const body = await res.json();
    if (!body || (body.kind && body.kind !== "track")) {
      throw new ApiError(400, "not_a_track", "This link is not a single track (playlists and profiles are not supported).");
    }
    if (body.media?.transcodings?.length) {
      data = body;
      break;
    }
    data = data ?? body; // keep the (rendition-less) body as fallback
    if (body.policy === "BLOCK" || body.policy === "SNIP" || body.policy === "WAIT") {
      continue; // retry: sometimes the next answer has renditions
    }
  }

  if (!data) {
    throw new ApiError(502, "upstream", `SoundCloud resolve failed (HTTP ${lastStatus}).`);
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
}

/** DRM-wrapped renditions (cbcs/cenc) never play outside a licensed player. */
function isEncrypted(t: Transcoding): boolean {
  const proto = (t.format?.protocol || "").toLowerCase();
  return proto.includes("encrypted") || (t.url || "").includes("/cbcs/") || (t.url || "").includes("/cenc/");
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
    throw new ApiError(
      403,
      "not_streamable",
      "This track cannot be streamed (restricted, or only available with a Go+ subscription). If you just tried again shortly, the track may work on a retry.",
    );
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

  // Three passes: clear renditions first, then the official download file,
  // DRM-wrapped renditions last (they cannot play outside a licensed player).
  const clear: Candidate[] = [];
  const encrypted: Candidate[] = [];
  for (const key of order) {
    for (const t of buckets[key] ?? []) {
      const cand: Candidate = { transcoding: t, kind: key as Kind, encrypted: isEncrypted(t) };
      (cand.encrypted ? encrypted : clear).push(cand);
    }
  }
  const dlCands: Candidate[] = dl ? [{ transcoding: dl, kind: "other", download: true }] : [];
  return [...clear, ...dlCands, ...encrypted];
}

// ---------------------------------------------------------------- media url

async function getStreamUrl(transcoding: Transcoding, track?: ScTrack): Promise<string> {
  let lastStatus = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const cid = await getClientId();
    const u = new URL(transcoding.url);
    if (!u.searchParams.has("client_id")) u.searchParams.set("client_id", cid);
    const ta = track?.track_authorization;
    if (ta && !u.searchParams.has("track_authorization")) {
      u.searchParams.set("track_authorization", ta);
    }
    const res = await fetch(u.href, {
      headers: { Accept: "application/json", "User-Agent": UA },
      signal: AbortSignal.timeout(20000),
    });
    lastStatus = res.status;
    if (res.ok) {
      const data = await res.json();
      if (data?.url) return data.url;
    } else if (res.status !== 401 && res.status !== 403 && res.status !== 404) {
      break; // not a token problem; retrying will not help
    }
    clientIdCache = null;
  }
  throw new ApiError(502, "upstream", `Could not get the audio stream URL (HTTP ${lastStatus}).`);
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

function parseMediaPlaylist(text: string, baseUrl: string): { init: string | null; segments: string[]; key: string | null } {
  let init: string | null = null;
  let key: string | null = null;
  const segments: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#EXT-X-KEY:") || line.startsWith("#EXT-X-SESSION-KEY:")) {
      key = key ?? line;
    } else if (line.startsWith("#EXT-X-MAP:")) {
      const m = line.match(/URI="([^"]+)"/);
      if (m) init = new URL(m[1], baseUrl).href;
    } else if (!line.startsWith("#")) {
      segments.push(new URL(line, baseUrl).href);
    }
  }
  return { init, segments, key };
}

/** Download an HLS rendition: returns all parts and the sniffed container. */
async function assembleHls(playlistUrl: string): Promise<{ bytes: Uint8Array; container: string; key: string | null; debug: Record<string, unknown> }> {
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

  const { init, segments, key } = parseMediaPlaylist(text, baseUrl);
  if (segments.length === 0) throw new ApiError(502, "upstream", "HLS playlist has no segments.");
  if (key) {
    // fail fast: no point downloading segments we cannot play
    throw new ApiError(415, "drm_protected", `rendition is DRM-encrypted (${key.slice(0, 80)})`);
  }

  const urls = (init ? [init] : []).concat(segments);
  const parts: Uint8Array[] = [];
  const CONCURRENCY = 8;
  for (let i = 0; i < urls.length; i += CONCURRENCY) {
    const batch = urls.slice(i, i + CONCURRENCY);
    const got = await Promise.all(batch.map((u) => fetchBytes(u)));
    parts.push(...got);
  }
  return {
    bytes: concatBytes(parts),
    container: containerOf(parts[0]),
    key,
    debug: {
      playlist: text.slice(0, 2500),
      init_present: Boolean(init),
      segment_count: segments.length,
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
  const disposition = attachment ? "attachment" : "inline";
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

function pcmToWav(pcm: Pcm): Uint8Array {
  const { channelData, sampleRate } = pcm;
  const n = channelData[0].length;
  const ch = channelData.length;
  const data = new Int16Array(n * ch);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, channelData[c][i]));
      data[i * ch + c] = Math.round(v * 32767);
    }
  }
  const bytes = new Uint8Array(44 + data.byteLength);
  const dv = new DataView(bytes.buffer);
  const w = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) bytes[o + i] = s.charCodeAt(i);
  };
  w(0, "RIFF");
  dv.setUint32(4, 36 + data.byteLength, true);
  w(8, "WAVE");
  w(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, ch, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2 * ch, true);
  dv.setUint16(32, 2 * ch, true);
  dv.setUint16(34, 16, true);
  w(36, "data");
  dv.setUint32(40, data.byteLength, true);
  bytes.set(new Uint8Array(data.buffer), 44);
  return bytes;
}

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

async function decodeToPcm(bytes: Uint8Array, ext: string): Promise<Pcm> {
  if (ext === "mp3") return await decodeMp3File(bytes);
  if (ext === "m4a" || ext === "aac") return await decodeAacFile(bytes);
  if (ext === "wav") return wavToPcm(bytes);
  throw new ApiError(415, "unsupported_container", `cannot convert audio from '${ext}'`);
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

async function encodeOpus(pcm: Pcm): Promise<Uint8Array> {
  const OPUS_RATES = [8000, 12000, 16000, 24000, 48000];
  const rate = OPUS_RATES.includes(pcm.sampleRate) ? pcm.sampleRate : 48000;
  const channels = pcm.channelData.length >= 2 ? 2 : 1;
  const chs = pcm.channelData.slice(0, channels).map((c) => resample(c, pcm.sampleRate, rate));
  const enc = await WasmMediaEncoder.create("audio/ogg", oggWasm as unknown as Uint8Array);
  enc.configure({ channels: channels as 1 | 2, sampleRate: rate, vbrQuality: 8 });
  const parts: Uint8Array[] = [];
  const frame = Math.round(rate * 0.02); // 20 ms frames
  for (let off = 0; off < chs[0].length; off += frame) {
    const chunk = chs.map((c) => c.subarray(off, Math.min(off + frame, c.length)));
    if (chunk[0].length === 0) break;
    const b = enc.encode(chunk);
    if (b.length) parts.push(b);
  }
  const fin = enc.finalize();
  if (fin.length) parts.push(fin);
  const total = parts.reduce((a, b) => a + b.length, 0);
  const bytes = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    bytes.set(p, o);
    o += p.length;
  }
  return bytes;
}

async function convertAudio(bytes: Uint8Array, srcExt: string, fmt: string): Promise<Rendered> {
  const pcm = await decodeToPcm(bytes, srcExt);
  if (!pcm.channelData.length || !pcm.channelData[0]?.length) {
    throw new ApiError(415, "unsupported_container", "decoded audio is empty");
  }
  if (fmt === "opus") {
    const ogg = await encodeOpus(pcm);
    return { bytes: ogg, ext: "opus", mime: "audio/ogg", container: "ogg" };
  }
  const wav = pcmToWav(pcm);
  const input = new Input({
    source: new BufferSource(wav),
    formats: [new WaveInputFormat()],
  });
  const target = new BufferTarget();
  const output = new Output({
    format: fmt === "mp3" ? new Mp3OutputFormat() : new Mp4OutputFormat(),
    target,
  });
  const conversion = await Conversion.init({
    input,
    output,
    audio: {
      codec: fmt === "mp3" ? "mp3" : "aac",
      bitrate: fmt === "mp3" ? 320_000 : 256_000,
      forceTranscode: true,
    },
  });
  await conversion.execute();
  return {
    bytes: new Uint8Array(target.buffer as ArrayBuffer),
    ext: fmt === "mp3" ? "mp3" : "m4a",
    mime: fmt === "mp3" ? "audio/mpeg" : "audio/mp4",
    container: fmt === "mp3" ? "mp3" : "fmp4",
  };
}

async function serveAudio(url: string, fmt: string, attachment: boolean): Promise<Response> {
  const track = await resolveTrack(url);
  const meta = trackMeta(track, url);
  const candidates = buildCandidates(track, fmt);
  let lastErr: ApiError | null = null;
  let source: Rendered | null = null;

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
        return new Response(out.bytes, {
          status: 200,
          headers: audioHeaders(meta, out.ext, out.mime, note, attachment, out.bytes.length),
        });
      }
    } catch (err) {
      if (err instanceof ApiError && (err.code === "unsupported_container" || err.code === "upstream" || err.code === "drm_protected")) {
        lastErr = err;
        continue; // try the next rendition
      }
      throw err;
    }
  }

  // No rendition in the requested format: convert the best one we could render.
  if (fmt !== "auto" && source) {
    try {
      const out = await convertAudio(source.bytes, source.ext, fmt);
      return new Response(out.bytes, {
        status: 200,
        headers: audioHeaders(meta, out.ext, out.mime, `converted from ${source.ext} to ${out.ext}`, attachment, out.bytes.length),
      });
    } catch {
      // Conversion unsupported for this source: serve the rendition as-is.
      const note = `no ${fmt} rendition available; returning ${source.ext}`;
      return new Response(source.bytes, {
        status: 200,
        headers: audioHeaders(meta, source.ext, source.mime, note, attachment, source.bytes.length),
      });
    }
  }

  if (lastErr?.code === "drm_protected") {
    throw new ApiError(
      415,
      "drm_protected",
      "SoundCloud serves only DRM-encrypted audio for this track and offers no download file. SlopCloud will not serve encrypted bytes; if you have the audio file, the site can save it to the cache.",
    );
  }
  throw lastErr ??
    new ApiError(403, "not_streamable", "No usable audio rendition found for this track.");
}

// ---------------------------------------------------------------- diagnostics

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
      return jsonResponse({ ok: true, name: SERVICE_NAME, version: VERSION });
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
      return await serveAudio(link, fmt, path === "/api/download");
    }
    return errorResponse(new ApiError(404, "not_found", "No such endpoint."));
  } catch (err) {
    if (err instanceof ApiError) return errorResponse(err);
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse(new ApiError(500, "internal", message.slice(0, 300)));
  }
}

declare const Deno: { serve: (handler: (req: Request) => Response | Promise<Response>) => void } | undefined;
if (typeof Deno !== "undefined" && Deno && typeof Deno.serve === "function") {
  Deno.serve((req) => handleRequest(req));
}
