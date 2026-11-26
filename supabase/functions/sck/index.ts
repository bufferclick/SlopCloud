/*
 * SCK - SlopCloud KlickAud API: an API OF klickaud.org, the SoundCloud
 * downloader website. Single-file Supabase Edge Function.
 *
 * The API automates the website exactly like a user does:
 *   1. paste the SoundCloud URL  -> POST klickaud's download.php (with CSRF)
 *   2. press Convert             -> klickaud prepares the track
 *   3. press "DOWNLOAD THE SONG" -> follow the direct link, or the site's
 *                                   worker SSE stream, to the mp3 bytes
 *
 *   GET /api/health             status
 *   GET /api/info?url=SCURL     run the flow, return the track title + mode
 *   GET /api/audio?url=SCURL    the song: mp3 bytes
 *   GET /api/download?url=...   same, as a file download
 *   GET /api/debug?url=SCURL    what each site step answered (maintenance)
 *
 * Everything happens on klickaud.org's servers - this function is the honest
 * automation layer in front of it. Every response says so: X-SCK-Source is
 * always "klickaud.org (third-party converter)". Klickaud's availability and
 * output quality are theirs, not ours; failures are reported by name.
 *
 * TRANSPORT NOTE: this file contains ZERO backslash characters and ZERO
 * line comments, and builds every RegExp at runtime from character codes,
 * so it survives JSON transport unscathed regardless of escaping layers.
 */

const SERVICE_NAME = `SCK`;
const VERSION = `1.0.1`;
const UA =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36`;
const BASE = `https://www.klickaud.org`;
const SOURCE_LABEL = `klickaud.org (third-party converter)`;

const BS = String.fromCharCode(92);
const DQ = String.fromCharCode(34);
const SQ = String.fromCharCode(39);
const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const TAB = String.fromCharCode(9);
const FF = String.fromCharCode(12);
const VT = String.fromCharCode(11);

function rx(pattern: string, flags?: string): RegExp {
  return new RegExp(pattern, flags);
}

const RE_WS = rx(`[ ${TAB}${CR}${NL}${FF}${VT}]+`, `g`);
const RE_KLICKAUD_SUFFIX = rx(`_KLICKAUD${BS}.mp3$`, `i`);
const RE_FORHUB_SUFFIX = rx(`_forhub_soundcloud_to_mp3${BS}.mp3$`, `i`);
const RE_MP3_SUFFIX = rx(`${BS}.mp3$`, `i`);
const RE_UNDERSCORE = rx(`_`, `g`);

function qClass(): string {
  return `[${DQ}${SQ}]`;
}

function constRegex(name: string): RegExp {
  return rx(`${name}${BS}s*=${BS}s*${qClass()}([^${DQ}${SQ}]+)${qClass()}`);
}

const RE_DOWNLOAD_MODE = constRegex(`downloadMode`);
const RE_DIRECT_URL = constRegex(`directDownloadUrl`);
const RE_FILE_NAME = constRegex(`defaultFileName`);
const RE_SSE_GRANT = constRegex(`sseGrant`);
const RE_HAS_CONSTANTS = rx(`downloadMode${BS}s*=`);
const RE_VERIFY_FORM = rx(`<form[^>]*download${BS}.php`, `i`);
const RE_HIDDEN_INPUT = rx(`<input[^>]*type=${qClass()}hidden${qClass()}[^>]*>`, `gi`);
const RE_INPUT_NAME = rx(`name=${qClass()}([^${DQ}${SQ}]+)${qClass()}`);
const RE_INPUT_VALUE = rx(`value=${qClass()}([^${DQ}${SQ}]*)${qClass()}`);
const RE_CSRF_JSON = rx(`${DQ}csrf_token${DQ}${BS}s*:${BS}s*${DQ}([^${DQ}]+)${DQ}`);
const RE_CSRF_INPUT_A = rx(`name=${qClass()}csrf_token${qClass()}[^>]*value=${qClass()}([^${DQ}${SQ}]*)${qClass()}`);
const RE_CSRF_INPUT_B = rx(`value=${qClass()}([^${DQ}${SQ}]*)${qClass()}[^>]*name=${qClass()}csrf_token${qClass()}`);
const RE_SSE_DATA = rx(`^data:${BS}s*`);
const RE_FILENAME_BAD = rx(`[${BS}${BS}/:*?${DQ}<>|]`, `g`);
const RE_NON_ASCII = rx(`[^${BS}x20-${BS}x7e]`, `g`);

class ApiError extends Error {
  status: number;
  code: string;
  detail?: string;
  constructor(status: number, code: string, message: string, detail?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

function htmlSnippet(html: string): string {
  return html.replace(RE_WS, ` `).trim().slice(0, 900);
}

class Jar {
  cookies: Record<string, string> = {};
  absorb(res: Response): void {
    const raw = typeof res.headers.getSetCookie === `function`
      ? res.headers.getSetCookie()
      : [res.headers.get(`set-cookie`) || ``];
    for (const line of raw) {
      const pair = line.split(`;`)[0];
      const eq = pair.indexOf(`=`);
      if (eq > 0) this.cookies[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
  }
  header(): string {
    return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join(`; `);
  }
}

type Converted = {
  title: string;
  mode: `direct` | `worker`;
  downloadUrl: string;
  jar: Jar;
};

function cleanTitle(raw: string): string {
  return raw
    .replace(RE_KLICKAUD_SUFFIX, ``)
    .replace(RE_FORHUB_SUFFIX, ``)
    .replace(RE_MP3_SUFFIX, ``)
    .replace(RE_UNDERSCORE, ` `)
    .trim();
}

function assertSoundcloudUrl(url: string): void {
  let host = ``;
  try {
    host = new URL(url).host.toLowerCase();
  } catch {
    throw new ApiError(400, `bad_url`, `Pass a SoundCloud track link in the url= parameter.`);
  }
  if (host !== `soundcloud.com` && host !== `www.soundcloud.com` && host !== `on.soundcloud.com` &&
    host !== `m.soundcloud.com`) {
    throw new ApiError(400, `bad_url`, `This API takes SoundCloud links only (got host "${host}").`);
  }
}

function scrapeCsrf(html: string): string {
  const m = html.match(RE_CSRF_INPUT_A) || html.match(RE_CSRF_INPUT_B);
  return (m && m[1]) || ``;
}

async function kfetch(jar: Jar, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const headers = new Headers(init.headers || {});
  headers.set(`User-Agent`, UA);
  headers.set(`Accept`, headers.get(`Accept`) || `text/html,application/xhtml+xml,*/*;q=0.5`);
  headers.set(`Accept-Language`, `en-US,en;q=0.9`);
  headers.set(`Sec-Fetch-Site`, `same-origin`);
  headers.set(`Sec-Fetch-Mode`, `navigate`);
  const cookie = jar.header();
  if (cookie) headers.set(`Cookie`, cookie);
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers, redirect: `follow`, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new ApiError(
      502,
      `upstream`,
      `klickaud.org did not answer (${err instanceof Error ? err.message : String(err)}).`,
    );
  }
  jar.absorb(res);
  return res;
}

export async function convert(soundcloudUrl: string): Promise<Converted> {
  assertSoundcloudUrl(soundcloudUrl);
  const jar = new Jar();

  let landHtml = ``;
  try {
    const landRes = await kfetch(jar, `${BASE}/en17/`, {
      headers: { Accept: `text/html,application/xhtml+xml` },
    }, 15000);
    landHtml = await landRes.text();
  } catch { /* warm-up only; the steps below report real failures */ }

  let csrf = scrapeCsrf(landHtml);
  try {
    const tokenRes = await kfetch(jar, `${BASE}/csrf-token-endpoint.php`, {
      headers: { Referer: `${BASE}/en17/`, Accept: `application/json` },
    }, 15000);
    const tokenText = await tokenRes.text();
    if (tokenRes.ok) {
      const m = tokenText.match(RE_CSRF_JSON);
      csrf = (m && m[1]) || csrf;
    }
  } catch { /* the token endpoint is optional since the site's 2026-11 redesign */ }

  const form = new URLSearchParams();
  form.append(`value`, soundcloudUrl);
  form.append(`csrf_token`, csrf);
  const postRes = await kfetch(jar, `${BASE}/download.php`, {
    method: `POST`,
    headers: {
      Referer: `${BASE}/en17/`,
      Origin: BASE,
      'Content-Type': `application/x-www-form-urlencoded`,
    },
    body: form.toString(),
  }, 30000);
  if ((postRes.status === 403 || postRes.status === 401) && !csrf) {
    throw new ApiError(
      502,
      `no_token`,
      `klickaud.org refused the Convert request and no CSRF token was available - ` +
        `the site may be updating or blocking non-browser traffic.`,
    );
  }
  const firstHtml = await postRes.text();
  const html = await continueThroughVerify(jar, soundcloudUrl, csrf, postRes.status, firstHtml);
  const downloadMode = (html.match(RE_DOWNLOAD_MODE) || [])[1] || ``;
  const directUrl = (html.match(RE_DIRECT_URL) || [])[1] || ``;
  const defaultFileName = (html.match(RE_FILE_NAME) || [])[1] || `SoundCloud Track`;
  const sseGrant = (html.match(RE_SSE_GRANT) || [])[1] || ``;
  const title = cleanTitle(defaultFileName) || `SoundCloud Track`;

  if (downloadMode === `direct` && directUrl) {
    return { title, mode: `direct`, downloadUrl: directUrl, jar };
  }

  if (!sseGrant) {
    throw new ApiError(
      502,
      `convert_failed`,
      `klickaud.org did not return a download for this track - it may be private, region-locked, ` +
        `or the service is busy. The site showed no download link after Convert.`,
      `POST /download.php -> HTTP ${postRes.status}; page: ${htmlSnippet(html)}`,
    );
  }

  const capRes = await kfetch(jar, `${BASE}/sse_capability.php`, {
    method: `POST`,
    headers: {
      Referer: `${BASE}/download.php`,
      Origin: BASE,
      'Content-Type': `application/json`,
    },
    body: JSON.stringify({ grant: sseGrant, url: soundcloudUrl }),
  }, 15000);
  const capBody = await capRes.json().catch(() => null);
  const capability = capBody && capBody.capability;
  if (!capability) {
    throw new ApiError(502, `convert_failed`, `klickaud.org did not authorize the download capability for this track.`);
  }

  const sseUrl = `${BASE}/worker_sse.php?url=${encodeURIComponent(soundcloudUrl)}&cap=${encodeURIComponent(capability)}`;
  const sseRes = await kfetch(jar, sseUrl, {
    headers: { Referer: `${BASE}/download.php`, Accept: `text/event-stream` },
  }, 90000);
  if (!sseRes.ok || !sseRes.body) {
    throw new ApiError(502, `convert_failed`, `klickaud.org's worker stream answered HTTP ${sseRes.status}.`);
  }

  const result = await readSseResult(sseRes.body);
  if (result.failed) {
    throw new ApiError(502, `worker_failed`, `klickaud.org's worker reported: failed to process this track.`);
  }
  if (!result.downloadUrl) {
    throw new ApiError(502, `no_result`, `klickaud.org's worker stream ended without a download link.`);
  }
  return {
    title: (result.fileName && cleanTitle(result.fileName)) || title,
    mode: `worker`,
    downloadUrl: result.downloadUrl,
    jar,
  };
}

type SseResult = { downloadUrl?: string; fileName?: string; failed?: boolean };

const CAPTCHA_MARKERS = [
  `hcaptcha`,
  `turnstile`,
  `recaptcha`,
  `g-recaptcha`,
  `funcaptcha`,
  `altcha`,
  `mcaptcha`,
  `captcha-delivery`,
  `geo.captcha`,
];

async function continueThroughVerify(
  jar: Jar,
  soundcloudUrl: string,
  csrf: string,
  status: number,
  firstHtml: string,
): Promise<string> {
  const hasConstants = RE_HAS_CONSTANTS.test(firstHtml);
  const hasForm = RE_VERIFY_FORM.test(firstHtml);
  if (hasConstants || !hasForm) return firstHtml;

  const lowered = firstHtml.toLowerCase();
  for (const marker of CAPTCHA_MARKERS) {
    if (lowered.includes(marker)) {
      throw new ApiError(
        403,
        `verify_required`,
        `klickaud.org asks for human verification (${marker}) before this download. ` +
          `This API does not solve captchas - use the site in a real browser for this track.`,
        htmlSnippet(firstHtml),
      );
    }
  }

  const hidden: Record<string, string> = {};
  for (const m of firstHtml.matchAll(RE_HIDDEN_INPUT)) {
    const tag = m[0];
    const name = (tag.match(RE_INPUT_NAME) || [])[1];
    const value = (tag.match(RE_INPUT_VALUE) || [])[1] ?? ``;
    if (name) hidden[name] = value;
  }
  if (Object.keys(hidden).length === 0) return firstHtml;

  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(hidden)) form.append(k, v);
  if (!(Object.prototype.hasOwnProperty.call(hidden, `value`))) form.append(`value`, soundcloudUrl);
  if (!(Object.prototype.hasOwnProperty.call(hidden, `csrf_token`))) form.append(`csrf_token`, csrf);
  const res = await kfetch(jar, `${BASE}/download.php`, {
    method: `POST`,
    headers: {
      Referer: `${BASE}/download.php`,
      Origin: BASE,
      'Content-Type': `application/x-www-form-urlencoded`,
    },
    body: form.toString(),
  }, 30000);
  return await res.text();
}

async function readSseResult(body: ReadableStream<Uint8Array>): Promise<SseResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = ``;
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    if (buffer.includes(`event: ready`)) {
      const blocks = buffer.split(`event: `);
      for (const block of blocks) {
        if (!block.startsWith(`ready`)) continue;
        const dataLine = block.split(NL).find((l) => l.trim().startsWith(`data:`));
        if (!dataLine) continue;
        try {
          const data = JSON.parse(dataLine.replace(RE_SSE_DATA, ``));
          if (data.download_url) {
            try { await reader.cancel(); } catch { /* stream may already be gone */ }
            return { downloadUrl: data.download_url, fileName: data.file_name || `` };
          }
        } catch { /* keep reading */ }
      }
    }
    if (buffer.includes(`event: failed`)) {
      try { await reader.cancel(); } catch { /* stream may already be gone */ }
      return { failed: true };
    }
    if (done) return {};
  }
}

async function fetchSong(converted: Converted): Promise<Response> {
  const res = await kfetch(converted.jar, converted.downloadUrl, {
    headers: { Referer: `${BASE}/download.php`, Accept: `audio/mpeg,audio/*;q=0.9,*/*;q=0.5` },
  }, 60000);
  if (!res.ok || !res.body) {
    throw new ApiError(502, `upstream`, `The download link answered HTTP ${res.status}.`);
  }
  if (res.headers.get(`content-length`) === `0`) {
    throw new ApiError(
      502,
      `empty_file`,
      `klickaud.org's download link returned an empty file - the site sometimes fails mid-conversion. Try again shortly.`,
    );
  }
  return res;
}

function songHeaders(converted: Converted, attachment: boolean): Headers {
  const baseName = (converted.title || `SoundCloud Track`).replace(RE_FILENAME_BAD, ``);
  const filename = `${baseName}.mp3`;
  const h = new Headers();
  h.set(`Access-Control-Allow-Origin`, `*`);
  h.set(`Content-Type`, `audio/mpeg`);
  h.set(`X-SCK-Source`, SOURCE_LABEL);
  h.set(`X-SCK-Mode`, converted.mode);
  const disposition = attachment ? `attachment` : `inline`;
  const safeAscii = filename.replace(RE_NON_ASCII, `_`);
  h.set(
    `Content-Disposition`,
    `${disposition}; filename=${DQ}${safeAscii}${DQ}; filename*=UTF-8''${encodeURIComponent(filename)}`,
  );
  return h;
}

function corsHeaders(): Headers {
  const h = new Headers();
  h.set(`Access-Control-Allow-Origin`, `*`);
  h.set(`Access-Control-Allow-Methods`, `GET, HEAD, OPTIONS`);
  h.set(`Access-Control-Allow-Headers`, `Content-Type`);
  h.set(`Access-Control-Expose-Headers`, `Content-Length, Content-Disposition, X-SCK-Source, X-SCK-Mode`);
  return h;
}

function jsonResponse(data: unknown, status = 200): Response {
  const h = corsHeaders();
  h.set(`Content-Type`, `application/json; charset=utf-8`);
  return new Response(JSON.stringify(data), { status, headers: h });
}

function errorResponse(err: ApiError): Response {
  const body: Record<string, unknown> = { code: err.code, message: err.message };
  if (err.detail) body.detail = err.detail;
  return jsonResponse({ error: body }, err.status);
}

async function debugFlow(soundcloudUrl: string): Promise<unknown> {
  const jar = new Jar();
  const out: Record<string, unknown> = {};
  const land = await kfetch(jar, `${BASE}/en17/`, {
    headers: { Accept: `text/html,application/xhtml+xml` },
  }, 15000);
  const landHtml = await land.text();
  out.landing = { status: land.status, snippet: htmlSnippet(landHtml) };

  const tokenRes = await kfetch(jar, `${BASE}/csrf-token-endpoint.php`, {
    headers: { Referer: `${BASE}/en17/`, Accept: `application/json` },
  }, 15000);
  const tokenText = await tokenRes.text();
  out.csrf = { status: tokenRes.status, snippet: tokenText.slice(0, 300) };

  const csrf = (tokenText.match(RE_CSRF_JSON) || [])[1] || scrapeCsrf(landHtml) || ``;
  const form = new URLSearchParams();
  form.append(`value`, soundcloudUrl);
  form.append(`csrf_token`, csrf);
  const postRes = await kfetch(jar, `${BASE}/download.php`, {
    method: `POST`,
    headers: {
      Referer: `${BASE}/en17/`,
      Origin: BASE,
      'Content-Type': `application/x-www-form-urlencoded`,
    },
    body: form.toString(),
  }, 30000);
  const html = await postRes.text();
  const signals: Record<string, unknown> = {};
  for (const [key, re] of [
    [`downloadMode`, RE_DOWNLOAD_MODE],
    [`directDownloadUrl`, RE_DIRECT_URL],
    [`defaultFileName`, RE_FILE_NAME],
    [`sseGrant`, RE_SSE_GRANT],
  ] as const) {
    const m = html.match(re);
    signals[key] = m ? m[1] : null;
  }
  signals.hasVerifyForm = RE_VERIFY_FORM.test(html);
  signals.captchaMarkers = CAPTCHA_MARKERS.filter((c) => html.toLowerCase().includes(c));
  signals.scrapedCsrf = scrapeCsrf(html) || null;
  const idx = html.indexOf(`downloadMode`);
  signals.aroundDownloadMode = idx >= 0 ? html.slice(Math.max(0, idx - 150), idx + 250) : null;
  const fidx = html.search(RE_VERIFY_FORM);
  signals.aroundForm = fidx >= 0 ? html.slice(Math.max(0, fidx - 100), fidx + 500) : null;
  const tidx = html.indexOf(`<title`);
  signals.title = tidx >= 0 ? html.slice(tidx, tidx + 120) : null;
  out.convert = {
    status: postRes.status,
    contentType: postRes.headers.get(`content-type`),
    length: html.length,
    signals,
    snippet: html.replace(RE_WS, ` `).trim().slice(0, 1500),
  };
  out.cookieCount = Object.keys(jar.cookies).length;
  return out;
}

function serviceIndex() {
  return {
    name: SERVICE_NAME,
    description: `An API of klickaud.org, the SoundCloud downloader website: paste a SoundCloud URL, get the song. Runs the site's own flow (Convert -> Download the song).`,
    version: VERSION,
    source: SOURCE_LABEL,
    endpoints: {
      '/api/health': `GET - status`,
      '/api/info': `GET - ?url=<soundcloud-url> track title + mode, without downloading`,
      '/api/audio': `GET - ?url=<soundcloud-url> the song, mp3 bytes`,
      '/api/download': `GET - same, as a file download`,
      '/api/debug': `GET - ?url=<soundcloud-url> what each site step answered`,
    },
  };
}

function stripPrefix(pathname: string): string {
  const idx = pathname.lastIndexOf(`/sck`);
  const path = idx >= 0 ? pathname.slice(idx + `/sck`.length) : pathname;
  return path === `` ? `/` : path;
}

export async function handleRequest(req: Request): Promise<Response> {
  if (req.method === `OPTIONS`) {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (req.method !== `GET` && req.method !== `HEAD`) {
    return errorResponse(new ApiError(405, `method_not_allowed`, `Only GET is supported.`));
  }

  try {
    const url = new URL(req.url);
    const path = stripPrefix(url.pathname);

    if (path === `/` || path === `/api`) return jsonResponse(serviceIndex());
    if (path === `/api/health`) {
      return jsonResponse({ ok: true, name: SERVICE_NAME, version: VERSION, source: SOURCE_LABEL });
    }

    const pageUrl = (url.searchParams.get(`url`) || ``).trim();

    if (path === `/api/debug`) {
      if (!pageUrl) throw new ApiError(400, `missing_url`, `Pass a SoundCloud track link in the url= parameter.`);
      return jsonResponse(await debugFlow(pageUrl));
    }

    if (path === `/api/info`) {
      if (!pageUrl) throw new ApiError(400, `missing_url`, `Pass a SoundCloud track link in the url= parameter.`);
      const converted = await convert(pageUrl);
      return jsonResponse({
        title: converted.title,
        mode: converted.mode,
        source: SOURCE_LABEL,
        url: pageUrl,
      });
    }

    if (path === `/api/audio` || path === `/api/download`) {
      if (!pageUrl) throw new ApiError(400, `missing_url`, `Pass a SoundCloud track link in the url= parameter.`);
      const converted = await convert(pageUrl);
      const songRes = await fetchSong(converted);
      const h = songHeaders(converted, path === `/api/download`);
      const cl = songRes.headers.get(`content-length`);
      if (cl) h.set(`Content-Length`, cl);
      return new Response(songRes.body, { status: 200, headers: h });
    }

    return errorResponse(new ApiError(404, `not_found`, `No such endpoint.`));
  } catch (err) {
    if (err instanceof ApiError) return errorResponse(err);
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse(new ApiError(500, `internal`, message.split(NL)[0].slice(0, 160)));
  }
}

declare const Deno: { serve: (handler: (req: Request) => Response | Promise<Response>) => void } | undefined;
if (typeof Deno !== `undefined` && Deno && typeof Deno.serve === `function`) {
  Deno.serve((req) => handleRequest(req));
}
