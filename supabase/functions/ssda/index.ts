// SSDA - SlopCloud Song Downloader API
// Supabase Edge Function. Single file, no dependencies.
//
//   GET /api/health                     status
//   GET /api/info?url=<soundcloud-link>  track metadata (JSON)
//   GET /api/audio?url=<link>&format=auto|m4a|mp3|opus   audio bytes
//   GET /api/download?url=<link>         audio bytes as a file download
//
// Audio is passed through without re-encoding: quality is exactly the source.
// format=auto keeps full source quality and prefers the most storage-efficient
// rendition (opus, then m4a, then mp3).

const SERVICE_NAME = "SSDA";
const VERSION = "2.3.0";
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

  // sometimes embedded directly in the page
  const inline = findClientId(html);
  if (inline) return inline;

  // JS asset bundles: full or protocol-relative URLs on sndcdn.com
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

  let cid = await getClientId();
  const resolveOnce = (id: string) =>
    fetch(
      `https://api-v2.soundcloud.com/resolve?url=${encodeURIComponent(target)}&client_id=${id}`,
      { headers: { Accept: "application/json", "User-Agent": UA }, signal: AbortSignal.timeout(20000) },
    );

  let res = await resolveOnce(cid);
  if (res.status === 401 || res.status === 403) {
    // stale client_id -> refresh once
    clientIdCache = null;
    cid = await getClientId();
    res = await resolveOnce(cid);
  }

  if (res.status === 404) {
    throw new ApiError(404, "track_not_found", "No SoundCloud track found at this link.");
  }
  if (res.status === 429) {
    throw new ApiError(429, "rate_limited", "SoundCloud is rate-limiting requests. Try again shortly.");
  }
  if (!res.ok) {
    throw new ApiError(502, "upstream", `SoundCloud resolve failed (HTTP ${res.status}).`);
  }

  const data = await res.json();
  if (!data || (data.kind && data.kind !== "track")) {
    throw new ApiError(400, "not_a_track", "This link is not a single track (playlists and profiles are not supported).");
  }
  // SoundCloud intermittently omits renditions in the resolve response;
  // one retry avoids falsely reporting a streamable track as restricted.
  if (!data.media?.transcodings?.length && data.policy !== "BLOCK" && data.policy !== "SNIP") {
    await sleep(500);
    const again = await resolveOnce(cid);
    if (again.ok) {
      const retry = await again.json();
      if (retry?.media?.transcodings?.length) return retry as ScTrack;
    }
  }
  return data as ScTrack;
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

// ---------------------------------------------------------------- formats

interface Picked {
  transcoding: Transcoding;
  ext: string;
  mime: string;
  note: string | null;
}

type Kind = "mp3" | "m4a" | "opus" | "other";

const KIND_INFO: Record<Kind, [string, string]> = {
  mp3: ["mp3", "audio/mpeg"],
  m4a: ["m4a", "audio/mp4"],
  opus: ["opus", "audio/ogg"],
  other: ["bin", "application/octet-stream"],
};

/** Classify a rendition by its stream URL first (most reliable), then mime. */
function classifyTranscoding(t: Transcoding): Kind {
  const u = t.url || "";
  const mime = (t.format?.mime_type || "").toLowerCase();
  const protocol = (t.format?.protocol || "").toLowerCase();
  if (u.includes("/stream/progressive") || (protocol === "progressive" && mime.includes("mpeg"))) return "mp3";
  if (u.includes("/stream/hls/aac") || mime.startsWith("audio/mp4") || mime.includes("mp4a")) return "m4a";
  if (u.includes("/stream/hls") || mime.startsWith("audio/ogg") || mime.includes("opus")) return "opus";
  return "other";
}

function pickedFrom(t: Transcoding, note: string | null): Picked {
  const [ext, mime] = KIND_INFO[classifyTranscoding(t)];
  return { transcoding: t, ext, mime, note };
}

function pickTranscoding(track: ScTrack, fmt: string): Picked {
  const list: Transcoding[] = track.media?.transcodings ?? [];
  if (list.length === 0) {
    throw new ApiError(
      403,
      "not_streamable",
      "This track cannot be streamed (restricted, or only available with a Go+ subscription).",
    );
  }
  const byKind = (kind: Kind) => list.find((t) => classifyTranscoding(t) === kind);
  const orNote = (t: Transcoding | undefined, note: string | null): Picked | null =>
    t ? pickedFrom(t, note) : null;

  const opus = byKind("opus");
  const aac = byKind("m4a");
  const mp3 = byKind("mp3");
  const any = list[0];

  let picked: Picked | null = null;
  if (fmt === "mp3") {
    picked = orNote(mp3, null) ||
      orNote(opus, "no mp3 rendition available; returning opus") ||
      orNote(aac, "no mp3 rendition available; returning m4a");
  } else if (fmt === "m4a") {
    picked = orNote(aac, null) ||
      orNote(mp3, "no m4a rendition available; returning mp3") ||
      orNote(opus, "no m4a rendition available; returning opus");
  } else if (fmt === "opus") {
    picked = orNote(opus, null) ||
      orNote(aac, "no opus rendition available; returning m4a") ||
      orNote(mp3, "no opus rendition available; returning mp3");
  } else {
    // auto: full source quality, most storage-efficient codec first
    picked = orNote(opus, null) ||
      orNote(aac, null) ||
      orNote(mp3, null) ||
      orNote(any, null);
  }

  if (!picked) {
    throw new ApiError(403, "not_streamable", "No usable audio rendition found for this track.");
  }
  return picked;
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

function parseMediaPlaylist(text: string, baseUrl: string): { init: string | null; segments: string[] } {
  let init: string | null = null;
  const segments: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#EXT-X-MAP:")) {
      const m = line.match(/URI="([^"]+)"/);
      if (m) init = new URL(m[1], baseUrl).href;
    } else if (!line.startsWith("#")) {
      segments.push(new URL(line, baseUrl).href);
    }
  }
  return { init, segments };
}

async function downloadHls(playlistUrl: string): Promise<Uint8Array> {
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

  const { init, segments } = parseMediaPlaylist(text, baseUrl);
  if (segments.length === 0) throw new ApiError(502, "upstream", "HLS playlist has no segments.");

  const urls = (init ? [init] : []).concat(segments);
  const parts: Uint8Array[] = [];
  const CONCURRENCY = 8;
  for (let i = 0; i < urls.length; i += CONCURRENCY) {
    const batch = urls.slice(i, i + CONCURRENCY);
    const got = await Promise.all(batch.map((u) => fetchBytes(u)));
    parts.push(...got);
  }
  return concatBytes(parts);
}

// ---------------------------------------------------------------- audio

async function getStreamUrl(transcoding: Transcoding): Promise<string> {
  const cid = await getClientId();
  const joiner = transcoding.url.includes("?") ? "&" : "?";
  const res = await fetch(`${transcoding.url}${joiner}client_id=${cid}`, {
    headers: { Accept: "application/json", "User-Agent": UA },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new ApiError(502, "upstream", `Could not get the audio stream URL (HTTP ${res.status}).`);
  const data = await res.json();
  if (!data?.url) throw new ApiError(502, "upstream", "SoundCloud returned no stream URL.");
  return data.url;
}

function audioHeaders(meta: ReturnType<typeof trackMeta>, ext: string, mime: string, note: string | null, attachment: boolean, size: number | null): Headers {
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
  if (size !== null) h.set("Content-Length", String(size));
  return h;
}

async function serveAudio(url: string, fmt: string, attachment: boolean): Promise<Response> {
  const track = await resolveTrack(url);
  const meta = trackMeta(track, url);
  const picked = pickTranscoding(track, fmt);
  const streamUrl = await getStreamUrl(picked.transcoding);
  const isProgressive = picked.transcoding.url.includes("/stream/progressive") ||
    (picked.transcoding.format?.protocol || "") === "progressive";

  if (isProgressive) {
    const res = await fetch(streamUrl, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok || !res.body) {
      throw new ApiError(502, "upstream", `Audio fetch failed (HTTP ${res.status}).`);
    }
    const len = res.headers.get("Content-Length");
    return new Response(res.body, {
      status: 200,
      headers: audioHeaders(meta, picked.ext, picked.mime, picked.note, attachment, len ? Number(len) : null),
    });
  }

  // hls -> fetch init + all segments, concatenate (ogg pages / fMP4 fragments
  // concatenate into a playable file)
  const bytes = await downloadHls(streamUrl);
  return new Response(bytes, {
    status: 200,
    headers: audioHeaders(meta, picked.ext, picked.mime, picked.note, attachment, bytes.length),
  });
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
