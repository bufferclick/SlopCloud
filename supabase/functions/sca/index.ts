// SCA - SlopCloud SoundCloud API, built on api-anything's recipe format
// (github.com/goodnight000/api-anything). Single-file Supabase Edge Function.
//
// sites/soundcloud.json (canonical, api-anything schema) holds the learned
// SoundCloud operations - the same requests the site's own web app makes.
// This function is the tier-1 replay runner for those recipes plus a
// downloader built from their chain:
//
//   GET /api/health                      status
//   GET /api/ops                         the recipe operations (the learned API)
//   GET /api/call?op=<op>&<param>=<val>  run one learned operation (api-anything style)
//   GET /api/search?q=<query>            searchTracks, picked fields
//   GET /api/info?url=<track-url>        resolveTrack, picked fields + transcodings
//   GET /api/audio?url=<track-url>       the downloader: progressive mp3 bytes
//   GET /api/download?url=<track-url>    same, as a file download
//
// The recipe chain (one request per op, chain lives in the caller - api-anything
// granularity): resolveTrack -> pick progressive transcoding -> getStreamUrl ->
// GET the returned url. Audio is PASSED THROUGH unconverted - the progressive
// stream is already mp3. Public tracks only: Go+/restricted tracks stay
// restricted, reported honestly. Nothing is DRM-decrypted and no signed-in
// session is ever used.

const SERVICE_NAME = `SCA`;
const VERSION = `1.0.0`;
const UA =
  `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36`;

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

// ------------------------------------------------------------------ recipes
// Embedded copy of sites/soundcloud.json (the fn bundle is single-file; the
// repo file is canonical and upstream-contribution ready). Request URLs use
// {param} placeholders (the JSON file stores them percent-encoded, %7Bparam%7D,
// exactly as api-anything's own site files do).

type RecipeSlot = {
  param?: string;
  at: string[];
  template?: string;
  escape?: `url` | `json`;
  transform?: `strip-quotes` | `url-decode`;
};

type RecipeOp = {
  name: string;
  description: string;
  request: { method: string; url: string; headers: Record<string, string>; body?: string };
  slots: RecipeSlot[];
  response: {
    format: `json` | `html` | `embedded`;
    contentType?: string;
    extract?: string;
    pick?: string[];
    key?: string;
  };
  params: { name: string; type: string; required: boolean; description: string; example: string }[];
  public?: string[];
  readOnly: boolean;
  minTier: 1 | 2 | 3;
  learnedLoggedIn: boolean;
};

const BROWSER_HEADERS: Record<string, string> = {
  'accept': `application/json`,
  'accept-language': `en-US,en;q=0.9`,
  'origin': `https://soundcloud.com`,
  'referer': `https://soundcloud.com/`,
  'user-agent': UA,
};

const TRACK_PICK = [
  `id=id`,
  `title=title`,
  `artist=user.username`,
  `durationMs=duration`,
  `artwork=artwork_url`,
  `permalink=permalink_url`,
  `policy=policy`,
  `trackAuthorization=track_authorization`,
  `transcodings=media.transcodings`,
];

const OPS: RecipeOp[] = [
  {
    name: `searchTracks`,
    description:
      `Search the first page of public tracks by keyword, from the same api-v2 search call the SoundCloud web app makes.`,
    request: {
      method: `GET`,
      url:
        `https://api-v2.soundcloud.com/search/tracks?q={q}&client_id={client_id}&limit=10&offset=0&linked_partitioning=1&app_locale=en`,
      headers: {
        ...BROWSER_HEADERS,
        referer: `https://soundcloud.com/search?q={q}`,
      },
    },
    slots: [
      { param: `q`, at: [`query:q`] },
      { param: `client_id`, at: [`query:client_id`] },
    ],
    response: {
      format: `json`,
      contentType: `application/json`,
      extract: `collection`,
      key: `id`,
      pick: [
        `id=id`,
        `title=title`,
        `artist=user.username`,
        `durationMs=duration`,
        `permalink=permalink_url`,
        `artwork=artwork_url`,
        `genre=genre`,
      ],
    },
    params: [
      { name: `q`, type: `string`, required: true, description: `Search keywords.`, example: `harvey` },
      {
        name: `client_id`,
        type: `string`,
        required: true,
        description:
          `SoundCloud web client id (public constant from the site's JS). Supplied automatically by this runner.`,
        example: `auto`,
      },
    ],
    public: [`client_id`],
    readOnly: true,
    minTier: 1,
    learnedLoggedIn: false,
  },
  {
    name: `resolveTrack`,
    description:
      `Resolve a SoundCloud track page URL to its track record: identity, artwork, availability policy, and the media transcodings a downloader picks a stream from.`,
    request: {
      method: `GET`,
      url: `https://api-v2.soundcloud.com/resolve?url={url}&client_id={client_id}`,
      headers: BROWSER_HEADERS,
    },
    slots: [
      { param: `url`, at: [`query:url`] },
      { param: `client_id`, at: [`query:client_id`] },
    ],
    response: {
      format: `json`,
      contentType: `application/json`,
      extract: `.`,
      key: `id`,
      pick: TRACK_PICK,
    },
    params: [
      {
        name: `url`,
        type: `string`,
        required: true,
        description: `Public SoundCloud track page URL.`,
        example: `https://soundcloud.com/alexg232/harvey`,
      },
      {
        name: `client_id`,
        type: `string`,
        required: true,
        description: `SoundCloud web client id (public constant). Supplied automatically by this runner.`,
        example: `auto`,
      },
    ],
    public: [`client_id`],
    readOnly: true,
    minTier: 1,
    learnedLoggedIn: false,
  },
  {
    name: `getTrack`,
    description: `Read a track record by numeric id: same record resolveTrack returns.`,
    request: {
      method: `GET`,
      url: `https://api-v2.soundcloud.com/tracks/{trackId}?client_id={client_id}`,
      headers: BROWSER_HEADERS,
    },
    slots: [
      { param: `trackId`, at: [`path:1`] },
      { param: `client_id`, at: [`query:client_id`] },
    ],
    response: {
      format: `json`,
      contentType: `application/json`,
      extract: `.`,
      key: `id`,
      pick: TRACK_PICK,
    },
    params: [
      { name: `trackId`, type: `number`, required: true, description: `Numeric track id.`, example: `340501365` },
      {
        name: `client_id`,
        type: `string`,
        required: true,
        description: `SoundCloud web client id (public constant). Supplied automatically by this runner.`,
        example: `auto`,
      },
    ],
    public: [`client_id`],
    readOnly: true,
    minTier: 1,
    learnedLoggedIn: false,
  },
  {
    name: `getStreamUrl`,
    description:
      `Turn one media transcoding of a track (from resolveTrack's transcodings[].url) into its direct stream URL. One request, one value: the chain lives in the caller.`,
    request: {
      method: `GET`,
      url:
        `https://api-v2.soundcloud.com/media/soundcloud:tracks:{trackId}/{transcodingKey}/stream/https?client_id={client_id}&track_authorization={track_authorization}`,
      headers: BROWSER_HEADERS,
    },
    slots: [
      { param: `trackId`, at: [`path:1`], template: `soundcloud:tracks:{trackId}`, escape: `url` },
      { param: `transcodingKey`, at: [`path:2`], escape: `url` },
      { param: `client_id`, at: [`query:client_id`] },
      { param: `track_authorization`, at: [`query:track_authorization`] },
    ],
    response: {
      format: `json`,
      contentType: `application/json`,
      extract: `.`,
      key: `url`,
      pick: [`url=url`],
    },
    params: [
      { name: `trackId`, type: `number`, required: true, description: `Numeric track id from resolveTrack.`, example: `340501365` },
      {
        name: `transcodingKey`,
        type: `string`,
        required: true,
        description: `Key path segment of a transcoding URL from resolveTrack's transcodings[].url.`,
        example: `1a2b3c4d-5e6f-4a8b-9c0d-1234567890ab`,
      },
      {
        name: `client_id`,
        type: `string`,
        required: true,
        description: `SoundCloud web client id (public constant). Supplied automatically by this runner.`,
        example: `auto`,
      },
      {
        name: `track_authorization`,
        type: `string`,
        required: true,
        description: `Per-track authorization token from resolveTrack's trackAuthorization.`,
        example: `from-resolveTrack`,
      },
    ],
    public: [`client_id`],
    readOnly: true,
    minTier: 1,
    learnedLoggedIn: false,
  },
];

function findOp(name: string): RecipeOp {
  const op = OPS.find((o) => o.name === name);
  if (!op) {
    throw new ApiError(
      404,
      `unknown_op`,
      `No operation named '${name}'. Known operations: ${OPS.map((o) => o.name).join(', ')}.`,
    );
  }
  return op;
}

// ------------------------------------------------------------- replay engine

/** Dotted-path getter: a.b[2].c form, dot = root. */
function getPath(value: unknown, path: string): unknown {
  if (path === `.` || path === ``) return value;
  let cur: unknown = value;
  for (const rawSeg of path.split(`.`)) {
    let key = rawSeg;
    let index = -1;
    const bracket = rawSeg.lastIndexOf(`[`);
    if (bracket >= 0 && rawSeg.endsWith(`]`)) {
      key = rawSeg.slice(0, bracket);
      index = Number(rawSeg.slice(bracket + 1, -1));
    }
    if (cur == null || typeof cur !== `object`) return undefined;
    cur = (cur as Record<string, unknown>)[key];
    if (index >= 0) {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[index];
    }
  }
  return cur;
}

/**
 * Apply one pick entry (`name=path~regex`) to one item. ~regex keeps what the
 * regex's group 1 finds in the string value (api-anything pick semantics).
 */
function applyPickOne(item: unknown, entry: string): Record<string, unknown> {
  const tilde = entry.indexOf(`~`);
  const spec = tilde >= 0 ? entry.slice(0, tilde) : entry;
  const reSrc = tilde >= 0 ? entry.slice(tilde + 1) : null;
  const eq = spec.indexOf(`=`);
  const name = eq >= 0 ? spec.slice(0, eq) : spec;
  const path = eq >= 0 ? spec.slice(eq + 1) : spec;
  let v = getPath(item, path);
  if (reSrc && typeof v === `string`) {
    const m = v.match(new RegExp(reSrc));
    v = m ? m[1] : undefined;
  }
  return v === undefined ? {} : { [name]: v };
}

/** Pick fields per item (array input) or once (object input); items with none of the fields are dropped. */
function applyPick(value: unknown, pick: string[]): unknown {
  const items = Array.isArray(value) ? value : [value];
  const out: Record<string, unknown>[] = [];
  for (const item of items) {
    const picked: Record<string, unknown> = {};
    for (const entry of pick) Object.assign(picked, applyPickOne(item, entry));
    if (Object.keys(picked).length > 0) out.push(picked);
  }
  return Array.isArray(value) ? out : out[0];
}

type CallResult = {
  ok: true;
  class: `ok`;
  tier: 1;
  site: `soundcloud`;
  op: string;
  request: string;
  data: unknown;
};

/** Fill {param} placeholders in a template with url-escaped values (escape url is the default). */
function fillTemplate(template: string, args: Record<string, string>, escape: `url` | `json` = `url`): string {
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (_all, name: string) => {
    const v = args[name];
    if (v === undefined) return ``;
    return escape === `json` ? JSON.stringify(v).slice(1, -1) : encodeURIComponent(v);
  });
}

/** Replay one learned operation (tier 1: plain HTTP). */
export async function runOp(name: string, args: Record<string, string>): Promise<CallResult> {
  const op = findOp(name);
  const filled: Record<string, string> = { ...args };
  if (op.slots.some((s) => s.param === `client_id`) && !filled.client_id) {
    filled.client_id = await getClientId();
  }
  const missing = op.params
    .filter((p) => p.required && (filled[p.name] === undefined || filled[p.name] === ``))
    .map((p) => p.name);
  if (missing.length > 0) {
    throw new ApiError(
      400,
      `invalid_args`,
      `Missing required parameters for ${op.name}: ${missing.join(', ')}. ` +
        `See /api/ops for the operation's parameters.`,
    );
  }

  const url = fillTemplate(op.request.url, filled);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(op.request.headers)) {
    headers[k] = fillTemplate(v, filled);
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: op.request.method,
      headers,
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    throw new ApiError(
      502,
      `upstream`,
      `SoundCloud did not answer ${op.name} (${err instanceof Error ? err.message : String(err)}).`,
    );
  }

  if (res.status === 404) {
    throw new ApiError(404, `not_found`, `SoundCloud has nothing at that id or URL (404).`);
  }
  if (res.status === 401 || res.status === 403) {
    // A stale public client_id is the usual cause; the caller (runOpWithClientId)
    // rotates and retries. Surface the honest shape if it was not retried.
    throw new ApiError(401, `client_id_rejected`, `SoundCloud rejected the request (${res.status}).`);
  }
  if (!res.ok) {
    throw new ApiError(502, `upstream`, `SoundCloud answered HTTP ${res.status} for ${op.name}.`);
  }

  if (op.response.format !== `json`) {
    throw new ApiError(501, `unsupported_recipe`, `Response format '${op.response.format}' is not replayed by this runner.`);
  }
  const body = await res.json();
  let data = getPath(body, op.response.extract ?? `.`);
  if (op.response.pick) data = applyPick(data, op.response.pick);
  return {
    ok: true,
    class: `ok`,
    tier: 1,
    site: `soundcloud`,
    op: op.name,
    request: `${op.request.method} ${url}`,
    data,
  };
}

/** runOp with client_id rotation on rejection (the pool turns over like the site's own JS). */
async function runOpWithClientId(name: string, args: Record<string, string>): Promise<CallResult> {
  try {
    return await runOp(name, args);
  } catch (err) {
    if (err instanceof ApiError && err.code === `client_id_rejected` && !args.client_id) {
      invalidateClientId();
      const retry = await runOp(name, { ...args, client_id: await getClientId() });
      return retry;
    }
    throw err;
  }
}

// ------------------------------------------------------ client_id (public JS constant)
// SoundCloud ships this in its own asset bundles. Ported from ssda's proven
// live scraper: page HTML -> sndcdn.com/assets/*.js -> client_id patterns,
// pooled and rotated (one scrape fills several ids).

let clientIdCache: { id: string; at: number } | null = null;
let clientIdPool: { ids: string[]; next: number; at: number } | null = null;
const CLIENT_ID_TTL = 30 * 60 * 1000;

const CLIENT_ID_PATTERNS = [
  /client_id\s*:\s*\x22([A-Za-z0-9_-]{20,})\x22/,
  /\x22client_id\x22\s*:\s*\x22([A-Za-z0-9_-]{20,})\x22/,
  /clientId\s*:\s*\x22([A-Za-z0-9_-]{20,})\x22/,
  /client_id=([A-Za-z0-9_-]{20,})/,
];

const ENTRY_PAGES = [
  `https://soundcloud.com/`,
  `https://soundcloud.com/discover`,
  `https://m.soundcloud.com/`,
];

function findAllClientIds(text: string): string[] {
  const out: string[] = [];
  for (const re of CLIENT_ID_PATTERNS) {
    for (const m of text.matchAll(new RegExp(re.source, `g`))) {
      if (m[1] && !out.includes(m[1])) out.push(m[1]);
    }
  }
  return out;
}

async function scanPageForClientIds(page: string, want = 8): Promise<string[]> {
  const res = await fetch(page, {
    headers: {
      'User-Agent': UA,
      Accept: `text/html,application/xhtml+xml`,
      'Accept-Language': `en-US,en;q=0.9`,
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return [];
  const html = await res.text();
  const found = findAllClientIds(html);
  if (found.length >= want) return found.slice(0, want);

  const assets = [...new Set(
    [...html.matchAll(/(?:https?:)?\/\/(?:[a-z0-9-]+\.)?sndcdn\.com\/assets\/[A-Za-z0-9._-]+\.js/g)]
      .map((m) => (m[0].startsWith(`//`) ? `https:` + m[0] : m[0])),
  )];
  if (assets.length === 0) return found;
  assets.reverse();

  const queue = [...assets];
  let scanned = 0;
  while (queue.length > 0 && scanned < 20 && found.length < want) {
    const batch = queue.splice(0, 5);
    scanned += batch.length;
    const results = await Promise.allSettled(
      batch.map(async (u) => {
        const r = await fetch(u, {
          headers: { 'User-Agent': UA, 'Accept-Language': `en-US,en;q=0.9` },
          signal: AbortSignal.timeout(15000),
        });
        return r.ok ? await r.text() : ``;
      }),
    );
    for (const r of results) {
      if (r.status !== `fulfilled`) continue;
      for (const cid of findAllClientIds(r.value)) {
        if (!found.includes(cid)) found.push(cid);
        if (found.length >= want) break;
      }
    }
  }
  return found;
}

// A rejected id is survived by rotating to the next pooled one instead of
// scraping under pressure (the scrape itself is what bot-challenges).
function invalidateClientId(): void {
  clientIdCache = null;
}

async function getClientId(): Promise<string> {
  if (clientIdCache && Date.now() - clientIdCache.at < CLIENT_ID_TTL) return clientIdCache.id;

  const poolFresh = clientIdPool !== null && Date.now() - clientIdPool.at < CLIENT_ID_TTL;
  if (poolFresh && clientIdPool!.next < clientIdPool!.ids.length) {
    clientIdCache = { id: clientIdPool!.ids[clientIdPool!.next++], at: Date.now() };
    return clientIdCache.id;
  }

  for (const page of ENTRY_PAGES) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const ids = await scanPageForClientIds(page);
        if (ids.length > 0) {
          clientIdPool = { ids, next: 1, at: Date.now() };
          clientIdCache = { id: ids[0], at: Date.now() };
          return ids[0];
        }
      } catch {
        // next page / attempt
      }
    }
  }
  throw new ApiError(
    502,
    `client_id_unavailable`,
    `Could not read SoundCloud's public client id from its pages right now (the site may be challenging requests). Try again in a minute.`,
  );
}

// ---------------------------------------------------------------- downloader

type PickedTrack = {
  id?: number;
  title?: string;
  artist?: string;
  policy?: string;
  trackAuthorization?: string;
  transcodings?: {
    url?: string;
    preset?: string;
    format?: { protocol?: string; mime_type?: string; mimeType?: string };
  }[];
};

// SoundCloud writes format.mime_type (snake_case) on the wire.
function mimeOf(x: { format?: { mime_type?: string; mimeType?: string } }): string {
  return x.format?.mime_type ?? x.format?.mimeType ?? ``;
}

function pickProgressiveMp3(t: PickedTrack) {
  const list = t.transcodings ?? [];
  return list.find((x) =>
    x.url && x.format?.protocol === `progressive` && mimeOf(x).startsWith(`audio/mpeg`)
  ) ?? list.find((x) => x.url && x.format?.protocol === `progressive` && (x.preset ?? ``).startsWith(`mp3`));
}

function pickPlainHls(t: PickedTrack) {
  return (t.transcodings ?? []).find((x) => x.url && x.format?.protocol === `hls`);
}

function isEncryptedOnly(t: PickedTrack): boolean {
  const list = t.transcodings ?? [];
  return list.length > 0 && list.every((x) => (x.format?.protocol ?? ``).includes(`encrypted`));
}

function transcodingKeyOf(url: string): string | null {
  const parts = url.split(`/stream/`)[0].split(`/`);
  const key = parts[parts.length - 1] || ``;
  return key && parts[parts.length - 2].startsWith(`soundcloud:tracks:`) ? key : null;
}

async function downloadStream(
  pageUrl: string,
  fmt: `auto` | `mp3`,
  attachment: boolean,
): Promise<Response> {
  const info = await runOpWithClientId(`resolveTrack`, { url: pageUrl });
  const t = info.data as PickedTrack;
  const preview = (t.policy ?? ``) === `SNIP`;

  if (t.policy === `BLOCK`) {
    throw new ApiError(
      403,
      `restricted`,
      `SoundCloud blocks this track for streaming outside its apps - ` +
        `Go+/members-only and region-locked tracks stay restricted here too (nothing is decrypted, no signed-in session is used).`,
    );
  }
  const transcodings = t.transcodings ?? [];
  if (transcodings.length === 0) {
    throw new ApiError(
      403,
      `restricted`,
      `SoundCloud offers no playable streams for this track outside its apps (nothing is decrypted here).`,
    );
  }

  // 1) Progressive file? Pass it straight through - it is already an mp3 (or
  //    opus, labeled as such). No conversion, no format substitution.
  const chosen = pickProgressiveMp3(t);
  if (chosen?.url) {
    return await fetchMedia(chosen.url, t, `audio/mpeg`, `mp3`, attachment, previewNote(`soundcloud progressive mp3 (passthrough)`, preview));
  }
  const anyProgressive = transcodings.find((x) => x.url && x.format?.protocol === `progressive`);
  if (anyProgressive?.url) {
    if (fmt === `mp3`) {
      throw new ApiError(
        415,
        `no_usable_stream`,
        `This track has no progressive mp3 stream (only a ${mimeOf(anyProgressive) || `non-mp3`} progressive file). ` +
          `The SlopCloud ssda API converts those - use it for this track.`,
      );
    }
    return await fetchMedia(anyProgressive.url, t, (mimeOf(anyProgressive) || `audio/ogg`).split(`;`)[0].trim(), `opus`, attachment,
      previewNote(`progressive stream passthrough (not mp3 - no silent substitution)`, preview));
  }

  // 2) Plain (unencrypted) HLS only? Hand the track to our ssda engine - it
  //    assembles the HLS segments and converts them to mp3, the same way the
  //    site's save flow does. Encrypted renditions are never fed to it.
  if (pickPlainHls(t)) {
    return await delegateToSsda(pageUrl, t, preview, attachment);
  }

  // 3) Encrypted-HLS-only tracks stay locked: no keys, no CDM, no signed-in
  //    session - refused honestly, by name.
  if (isEncryptedOnly(t)) {
    const kinds = [...new Set(transcodings.map((x) => x.format?.protocol).filter(Boolean))].join(`, `);
    throw new ApiError(
      403,
      `encrypted_stream`,
      `SoundCloud now serves this track only as ${kinds}. Stream encryption stays unbroken here ` +
        `(no keys, no CDM, no stolen sessions) - saving is refused honestly. SoundCloud's own player on the track page still plays it.`,
    );
  }

  throw new ApiError(415, `no_usable_stream`, `This track has no usable stream rendition to download.`);
}

function previewNote(note: string, preview: boolean): string {
  return preview ? `${note} (preview/snip track)` : note;
}

// The ssda engine (ours, same project) assembles plain HLS and converts it to
// mp3. sca streams its answer through. Long tracks come back chunked; we
// stitch the chunks here, sequentially, so the caller just gets the file.
const SSDA_BASE = `https://zfshvxknthgzlgzulpuq.supabase.co/functions/v1/ssda`;

async function delegateToSsda(pageUrl: string, t: PickedTrack, preview: boolean, attachment: boolean): Promise<Response> {
  const base = `${SSDA_BASE}/api/audio?url=${encodeURIComponent(pageUrl)}&format=mp3`;
  let res: Response;
  try {
    res = await fetch(base, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60000) });
  } catch (err) {
    throw new ApiError(502, `upstream`, `The ssda conversion engine did not answer (${err instanceof Error ? err.message : String(err)}).`);
  }

  let bytes: Uint8Array | null = null;
  let note = `hls assembled + converted to mp3 by the ssda engine`;

  if (res.status === 413) {
    // Chunked conversion: try whole-file assembly first, else stitch chunks.
    const all = await fetch(`${base}&chunk=all`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(120000) });
    if (all.ok) {
      bytes = new Uint8Array(await all.arrayBuffer());
      note += ` (assembled from cached chunks)`;
    } else {
      const planRes = await fetch(`${base}&chunk=info`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60000) });
      const plan = planRes.ok ? await planRes.json() : null;
      const count = plan?.chunk_count ?? 0;
      if (!count) {
        const text = await all.text();
        return passSsdaError(all.status, text);
      }
      const parts: Uint8Array[] = [];
      let total = 0;
      for (let i = 0; i < count; i++) {
        const c = await fetch(`${base}&chunk=${i}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60000) });
        if (!c.ok) {
          const text = await c.text();
          return passSsdaError(c.status, text);
        }
        const part = new Uint8Array(await c.arrayBuffer());
        parts.push(part);
        total += part.length;
      }
      bytes = new Uint8Array(total);
      let off = 0;
      for (const p of parts) { bytes.set(p, off); off += p.length; }
      note += ` (stitched ${count} chunks)`;
    }
  } else if (res.ok) {
    bytes = new Uint8Array(await res.arrayBuffer());
  } else {
    const text = await res.text();
    return passSsdaError(res.status, text);
  }

  const filename = `${(t.artist || 'Unknown').replace(/[\\/:*?\x22<>|]/g, '')} - ${(t.title || 'track').replace(/[\\/:*?\x22<>|]/g, '')}.mp3`;
  const h = new Headers();
  h.set(`Access-Control-Allow-Origin`, `*`);
  h.set(`Content-Type`, `audio/mpeg`);
  h.set(`X-SCA-Source`, previewNote(note, preview));
  h.set(`X-SCA-Extension`, `mp3`);
  const disposition = attachment ? 'attachment' : 'inline';
  h.set(
    `Content-Disposition`,
    `${disposition}; filename=\x22${filename.replace(/[^\x20-\x7e]/g, '_')}\x22; filename*=UTF-8''${encodeURIComponent(filename)}`,
  );
  if (bytes) h.set(`Content-Length`, String(bytes.length));
  return new Response(bytes, { status: 200, headers: h });
}

function passSsdaError(status: number, text: string): Response {
  const h = corsHeaders();
  h.set(`Content-Type`, `application/json; charset=utf-8`);
  return new Response(text, { status: status === 409 ? 409 : status, headers: h });
}

async function fetchMedia(
  transcodingUrl: string,
  t: PickedTrack,
  mime: string,
  ext: string,
  attachment: boolean,
  note: string,
): Promise<Response> {
  const key = transcodingKeyOf(transcodingUrl);
  if (!key) {
    throw new ApiError(502, `upstream`, `Could not read the transcoding key from SoundCloud's response.`);
  }
  const stream = await runOpWithClientId(`getStreamUrl`, {
    trackId: String(t.id ?? ``),
    transcodingKey: key,
    track_authorization: t.trackAuthorization ?? ``,
  });
  const direct = (stream.data as { url?: string }).url;
  if (!direct) {
    throw new ApiError(502, `upstream`, `SoundCloud did not return a direct stream URL.`);
  }

  const res = await fetch(direct, {
    headers: { 'User-Agent': UA, Referer: `https://soundcloud.com/` },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok || !res.body) {
    throw new ApiError(502, `upstream`, `The media host answered HTTP ${res.status} for the stream.`);
  }

  const filename = `${(t.artist || 'Unknown').replace(/[\\/:*?\x22<>|]/g, '')} - ${(t.title || 'track').replace(/[\\/:*?\x22<>|]/g, '')}.${ext}`;
  const h = new Headers();
  h.set(`Access-Control-Allow-Origin`, `*`);
  h.set(`Content-Type`, mime);
  h.set(`X-SCA-Source`, note);
  h.set(`X-SCA-Extension`, ext);
  const disposition = attachment ? 'attachment' : `inline`;
  h.set(
    `Content-Disposition`,
    `${disposition}; filename=\x22${filename.replace(/[^\x20-\x7e]/g, '_')}\x22; filename*=UTF-8''${encodeURIComponent(filename)}`,
  );
  const cl = res.headers.get(`content-length`);
  if (cl) h.set(`Content-Length`, cl);
  return new Response(res.body, { status: 200, headers: h });
}

// ---------------------------------------------------------------- responses

function corsHeaders(): Headers {
  const h = new Headers();
  h.set(`Access-Control-Allow-Origin`, `*`);
  h.set(`Access-Control-Allow-Methods`, `GET, HEAD, OPTIONS`);
  h.set(`Access-Control-Allow-Headers`, `Content-Type`);
  h.set(`Access-Control-Expose-Headers`, `Content-Length, Content-Disposition, X-SCA-Source, X-SCA-Extension`);
  return h;
}

function jsonResponse(data: unknown, status = 200): Response {
  const h = corsHeaders();
  h.set(`Content-Type`, `application/json; charset=utf-8`);
  return new Response(JSON.stringify(data), { status, headers: h });
}

function errorResponse(err: ApiError): Response {
  const body: Record<string, unknown> = { code: err.code, message: err.message };
  if (err.retryAfter && err.retryAfter > 0) body.retry_after_seconds = Math.ceil(err.retryAfter);
  if (err.details) Object.assign(body, err.details);
  const res = jsonResponse({ error: body }, err.status);
  if (err.retryAfter && err.retryAfter > 0) res.headers.set(`Retry-After`, String(Math.ceil(err.retryAfter)));
  return res;
}

function serviceIndex() {
  return {
    name: SERVICE_NAME,
    description:
      `SoundCloud downloader API built on api-anything's learned-recipe format (see sites/soundcloud.json). Public tracks only.`,
    version: VERSION,
    endpoints: {
      '/api/health': `GET - status`,
      '/api/ops': `GET - the learned operations and their parameters`,
      '/api/call': `GET - ?op=<op>&<param>=<value> run one learned operation`,
      '/api/search': `GET - ?q=<query> search public tracks`,
      '/api/info': `GET - ?url=<track-url> track record + transcodings`,
      '/api/audio': `GET - ?url=<track-url> the audio bytes (progressive mp3 passthrough)`,
      '/api/download': `GET - same, as a file download`,
    },
  };
}

// ---------------------------------------------------------------- router

function stripPrefix(pathname: string): string {
  const idx = pathname.lastIndexOf(`/sca`);
  const path = idx >= 0 ? pathname.slice(idx + `/sca`.length) : pathname;
  return path === `` ? '/' : path;
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
      return jsonResponse({ ok: true, name: SERVICE_NAME, version: VERSION, ops: OPS.length, format: `api-anything recipes` });
    }
    if (path === `/api/ops`) {
      return jsonResponse({
        site: `soundcloud`,
        format: `api-anything`,
        source: `sites/soundcloud.json`,
        operations: OPS.map((o) => ({
          name: o.name,
          description: o.description,
          params: o.params,
          response: { extract: o.response.extract, pick: o.response.pick, key: o.response.key },
        })),
      });
    }
    if (path === `/api/call`) {
      const op = url.searchParams.get(`op`) || ``;
      const args: Record<string, string> = {};
      for (const [k, v] of url.searchParams.entries()) {
        if (k !== `op`) args[k] = v;
      }
      return jsonResponse(await runOpWithClientId(op, args));
    }
    if (path === `/api/search`) {
      const q = url.searchParams.get(`q`) || ``;
      if (!q.trim()) {
        throw new ApiError(400, `missing_query`, `Pass a search term in the q= parameter.`);
      }
      const r = await runOpWithClientId(`searchTracks`, { q: q.trim() });
      return jsonResponse({ query: q.trim(), results: r.data });
    }
    if (path === `/api/info`) {
      const pageUrl = url.searchParams.get(`url`) || ``;
      if (!pageUrl.trim()) {
        throw new ApiError(400, `missing_url`, `Pass a SoundCloud track link in the url= parameter.`);
      }
      const r = await runOpWithClientId(`resolveTrack`, { url: pageUrl.trim() });
      return jsonResponse(r.data);
    }
    if (path === `/api/audio` || path === `/api/download`) {
      const pageUrl = url.searchParams.get(`url`) || ``;
      if (!pageUrl.trim()) {
        throw new ApiError(400, `missing_url`, `Pass a SoundCloud track link in the url= parameter.`);
      }
      let fmt = (url.searchParams.get(`format`) || `auto`).toLowerCase();
      if (fmt !== `auto` && fmt !== `mp3`) {
        throw new ApiError(400, `invalid_format`, `format must be auto or mp3 (this endpoint passes audio through; it does not convert).`);
      }
      return await downloadStream(pageUrl.trim(), fmt as `auto` | `mp3`, path === `/api/download`);
    }
    return errorResponse(new ApiError(404, `not_found`, `No such endpoint.`));
  } catch (err) {
    if (err instanceof ApiError) return errorResponse(err);
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse(new ApiError(500, `internal`, message.split(`\n`)[0].slice(0, 160)));
  }
}

declare const Deno: { serve: (handler: (req: Request) => Response | Promise<Response>) => void } | undefined;
if (typeof Deno !== `undefined` && Deno && typeof Deno.serve === `function`) {
  Deno.serve((req) => handleRequest(req));
}
