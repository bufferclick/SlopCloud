// Local tests for supabase/functions/yta/index.ts (no network needed).
// Mocks global fetch to simulate YouTube (Innertube search/player + media)
// and the ssda_cache PostgREST table, then exercises every endpoint.
//
//   node tools/test-yta.mjs
//
// Node loader hooks map the function's `npm:` imports onto the local
// node_modules install, so run `npm install` first.
import { register } from "node:module";
register("./npm-hook.mjs", import.meta.url);

import encodeM4a from "@audio/encode-mp4";

const { handleRequest } = await import("../supabase/functions/yta/index.ts");

const BASE = "https://zfshvxknthgzlgzulpuq.supabase.co/functions/v1/yta";

// ---------- fixtures ----------

// A real AAC/fMP4 file (12 s sine) built at test time with the same FDK
// encoder the SSDA function uses - the function decodes it for real.
async function makeM4a(seconds, sampleRate = 44100) {
  const enc = await encodeM4a({ sampleRate, channels: 2, codec: "aac", profile: "lc", bitrate: 128 });
  const n = seconds * sampleRate;
  const CH = 32768;
  for (let off = 0; off < n; off += CH) {
    const end = Math.min(off + CH, n);
    const l = new Float32Array(end - off);
    const r = new Float32Array(end - off);
    for (let i = 0; i < end - off; i++) {
      const t = (off + i) / sampleRate;
      l[i] = Math.sin(2 * Math.PI * 440 * t) * 0.4;
      r[i] = Math.sin(2 * Math.PI * 554 * t) * 0.4;
    }
    await enc.encode([l, r]);
  }
  const bytes = await enc.flush();
  enc.free?.();
  return new Uint8Array(bytes);
}

const m4aBytes = await makeM4a(12);
const shortM4aBytes = await makeM4a(4);

const LONG_URL = "https://www.youtube.com/watch?v=bbbbbbbbbbb";
const SHORT_URL = "https://youtu.be/aaaaaaaaaaa";
const CIPHER_URL = "https://www.youtube.com/watch?v=ccccccccccc";
const AGE_URL = "https://www.youtube.com/watch?v=ddddddddddd";
const WEBM_URL = "https://www.youtube.com/watch?v=eeeeeeeeeee";
const LONGID_URL = "https://www.youtube.com/watch?v=ffffffffff1";

function audioFormat(itag, mime, bitrate, url, len) {
  return { itag, mimeType: mime, bitrate, url, contentLength: String(len), audioQuality: "AUDIO_QUALITY_MEDIUM" };
}

function playerOk(videoId, title, author, lengthSeconds, mediaBytes) {
  return {
    playabilityStatus: { status: "OK" },
    videoDetails: {
      videoId,
      title,
      author,
      lengthSeconds: String(lengthSeconds),
      thumbnail: { thumbnails: [{ url: "https://i.ytimg.test/thumb1.jpg" }, { url: "https://i.ytimg.test/thumb.jpg" }] },
    },
    streamingData: {
      adaptiveFormats: [
        audioFormat(251, 'audio/webm; codecs="opus"', 160000, `https://rr.googlevideo.test/opus?vid=${videoId}`, 1000),
        audioFormat(140, 'audio/mp4; codecs="mp4a.40.2"', 131000, `https://rr.googlevideo.test/aac?vid=${videoId}`, mediaBytes.length),
        audioFormat(139, 'audio/mp4; codecs="mp4a.40.2"', 48000, `https://rr.googlevideo.test/aac-low?vid=${videoId}`, mediaBytes.length),
      ],
    },
  };
}

const searchFixture = {
  contents: {
    twoColumnSearchResultsRenderer: {
      primaryContents: {
        sectionListRenderer: {
          contents: [
            {
              itemSectionRenderer: {
                contents: [
                  {
                    videoRenderer: {
                      videoId: "aaaaaaaaaaa",
                      title: { runs: [{ text: "First Song" }] },
                      ownerText: { runs: [{ text: "Some Artist" }] },
                      lengthText: { simpleText: "3:12" },
                      thumbnail: { thumbnails: [{ url: "https://i.ytimg.test/1.jpg" }, { url: "https://i.ytimg.test/2.jpg" }] },
                    },
                  },
                  { adRenderer: { junk: true } },
                  {
                    compactVideoRenderer: {
                      videoId: "bbbbbbbbbbb",
                      title: { runs: [{ text: "Second Video" }] },
                      shortBylineText: { runs: [{ text: "Other Channel" }] },
                      lengthText: { simpleText: "1:02:03" },
                      thumbnail: { thumbnails: [{ url: "https://i.ytimg.test/3.jpg" }] },
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    },
  },
};

// ---------- mock network ----------

const realFetch = globalThis.fetch;
const cacheDb = new Map(); // emulates PostgREST over the ssda_cache table
let playerCalls = new Map(); // videoId -> count

globalThis.fetch = async (input, init) => {
  const u = String(input instanceof Request ? input.url : input);
  const method = String((init && init.method) || (input instanceof Request ? input.method : "GET")).toUpperCase();
  const R = (body, status = 200, headers = {}) => new Response(body, { status, headers });
  const J = (obj, status = 200) => R(JSON.stringify(obj), status, { "Content-Type": "application/json" });

  // emulated PostgREST over the ssda_cache table
  if (u.startsWith("https://supabase.test/rest/v1/ssda_cache")) {
    const parsed = new URL(u);
    if (method === "GET") {
      const raw = parsed.searchParams.get("cache_key") ?? "";
      const keys = raw ? [decodeURIComponent(raw.replace(/^eq\./, ""))] : [];
      return J(keys.filter((k) => cacheDb.has(k)).map((k) => ({ cache_key: k, data: cacheDb.get(k) })));
    }
    if (method === "POST") {
      const bodyArr = JSON.parse(init.body);
      for (const r of bodyArr) if (r && r.cache_key) cacheDb.set(r.cache_key, r.data);
      return R("", 201);
    }
    if (method === "DELETE") {
      cacheDb.clear();
      return R("", 204);
    }
  }

  if (u.startsWith("https://www.youtube.com/youtubei/v1/search")) {
    const body = JSON.parse(init.body);
    if ((body.query || "") === "") return J({ error: "empty" }, 400);
    return J(searchFixture);
  }

  if (u.startsWith("https://www.youtube.com/youtubei/v1/player")) {
    const body = JSON.parse(init.body);
    const vid = body.videoId;
    playerCalls.set(vid, (playerCalls.get(vid) || 0) + 1);
    if (vid === "aaaaaaaaaaa") return J(playerOk(vid, "Short Song", "Test Artist", 4, shortM4aBytes));
    if (vid === "bbbbbbbbbbb") return J(playerOk(vid, "Long Song", "Long Artist", 40, m4aBytes));
    if (vid === "ccccccccccc") {
      return J({
        playabilityStatus: { status: "OK" },
        videoDetails: { videoId: vid, title: "Ciphered", author: "X", lengthSeconds: "30" },
        streamingData: {
          adaptiveFormats: [
            { itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 131000, signatureCipher: "s=AAA&sp=sig&url=https%3A%2F%2Frr.googlevideo.test%2Fcipher" },
          ],
        },
      });
    }
    if (vid === "ddddddddddd") {
      return J({
        playabilityStatus: {
          status: "LOGIN_REQUIRED",
          reason: { simpleText: "Sign in to confirm your age" },
          errorScreen: { playerErrorMessageRenderer: { subreason: { simpleText: "This video may be inappropriate for some users" } } },
        },
      });
    }
    if (vid === "ggggggggggg") {
      return J({
        playabilityStatus: {
          status: "LOGIN_REQUIRED",
          reason: { simpleText: "Sign in to confirm you\u2019re not a bot" },
        },
      });
    }
    if (vid === "eeeeeeeeeee") {
      return J({
        playabilityStatus: { status: "OK" },
        videoDetails: { videoId: vid, title: "Opus Only", author: "Y", lengthSeconds: "30" },
        streamingData: {
          adaptiveFormats: [
            audioFormat(251, 'audio/webm; codecs="opus"', 160000, `https://rr.googlevideo.test/opus?vid=${vid}`, 1000),
          ],
        },
      });
    }
    if (vid === "ffffffffff1") {
      return J({
        playabilityStatus: { status: "OK" },
        videoDetails: { videoId: vid, title: "Huge", author: "Z", lengthSeconds: "3600" },
        streamingData: {
          adaptiveFormats: [
            audioFormat(140, 'audio/mp4; codecs="mp4a.40.2"', 131000, `https://rr.googlevideo.test/aac?vid=${vid}`, 30 * 1024 * 1024),
          ],
        },
      });
    }
    return J({ playabilityStatus: { status: "ERROR", reason: { simpleText: "Video unavailable" } } });
  }

  if (u.startsWith("https://www.youtube.com/watch?v=webpage0001")) {
    const pr = {
      playabilityStatus: { status: "OK" },
      videoDetails: { videoId: "webpage0001", title: "Webpage Song", author: "Page Artist", lengthSeconds: "30" },
      streamingData: {
        adaptiveFormats: [
          { itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 131000, contentLength: "1234", audioQuality: "AUDIO_QUALITY_MEDIUM", url: "https://rr.googlevideo.test/aac?vid=webpage0001" },
        ],
      },
    };
    return R('<html><script>var other = 1; ytInitialPlayerResponse = ' + JSON.stringify(pr) + ';</script></html>');
  }
  if (u.startsWith("https://www.youtube.com/")) {
    return R('<html><script>var ytcfg={INNERTUBE_API_KEY:"TESTKEY123",INNERTUBE_CONTEXT:{}};</script></html>');
  }

  if (u.includes("rr.googlevideo.test/aac")) {
    const vid = new URL(u).searchParams.get("vid") || "";
    return R(vid === "aaaaaaaaaaa" ? shortM4aBytes : m4aBytes, 200, { "Content-Type": "audio/mp4" });
  }
  if (u.includes("rr.googlevideo.test/opus")) {
    return R("OggS-not-decodable", 200, { "Content-Type": "audio/webm" });
  }

  return realFetch(input);
};

// ---------- assertions ----------

let passed = 0;
let failed = 0;
function ok(cond, label, extra = "") {
  if (cond) {
    passed++;
    console.log("  ok  " + label);
  } else {
    failed++;
    console.log("  FAIL " + label + (extra ? " | " + extra : ""));
  }
}

async function call(path, init) {
  return handleRequest(new Request(BASE + path, init));
}

function isMp3(bytes) {
  return bytes.length > 4 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
}

// 1. service index + health + preflight
{
  console.log("index / health / preflight:");
  const idx = await call("/");
  const idxBody = await idx.json();
  ok(idx.status === 200 && idxBody.name === "YTA", "GET / returns service index");
  ok(idx.headers.get("Access-Control-Allow-Origin") === "*", "CORS header present");
  const health = await call("/api/health");
  const hb = await health.json();
  ok(health.status === 200 && hb.ok === true && hb.cache === "off", "GET /api/health (cache off without env)");
  const opt = await call("/api/audio", { method: "OPTIONS" });
  ok(opt.status === 204 && opt.headers.get("Access-Control-Allow-Origin") === "*", "OPTIONS preflight");
}

// 2. search
{
  console.log("search:");
  const res = await call("/api/search?q=" + encodeURIComponent("first song"));
  const body = await res.json();
  ok(res.status === 200 && Array.isArray(body.results) && body.results.length === 2, "search returns results", JSON.stringify(body).slice(0, 120));
  const first = body.results[0];
  ok(first.video_id === "aaaaaaaaaaa" && first.title === "First Song" && first.author === "Some Artist", "search item fields");
  ok(first.duration_s === 192 && first.thumbnail_url === "https://i.ytimg.test/2.jpg", "search duration + best thumbnail");
  ok(body.results[1].duration_s === 3723, "long duration parsed (1:02:03)");
  const missing = await call("/api/search");
  ok(missing.status === 400 && (await missing.json()).error.code === "missing_query", "empty query -> 400");
  const toolong = await call("/api/search?q=" + "x".repeat(201));
  ok(toolong.status === 400, "over-long query -> 400");
}

// 3. info + url validation
{
  console.log("info / validation:");
  const res = await call("/api/info?url=" + encodeURIComponent(SHORT_URL));
  const body = await res.json();
  ok(res.status === 200 && body.id === "aaaaaaaaaaa" && body.title === "Short Song", "info metadata");
  ok(body.artist === "Test Artist" && body.duration === 4 && body.artwork_url === "https://i.ytimg.test/thumb.jpg", "info artist/duration/artwork");
  ok(Array.isArray(body.formats) && body.formats.some((f) => f.mime.startsWith("audio/mp4")), "info lists audio formats");
  const badHost = await call("/api/info?url=" + encodeURIComponent("https://vimeo.com/12345"));
  ok(badHost.status === 400 && (await badHost.json()).error.code === "invalid_url", "non-YouTube host -> 400");
  const noId = await call("/api/info?url=" + encodeURIComponent("https://www.youtube.com/feed/subscriptions"));
  ok(noId.status === 400 && (await noId.json()).error.code === "no_video_id", "link without video id -> 400");
  const missing = await call("/api/info");
  ok(missing.status === 400 && (await missing.json()).error.code === "missing_url", "missing url -> 400");
  const cred = await call("/api/info?url=" + encodeURIComponent("https://user:pw@www.youtube.com/watch?v=aaaaaaaaaaa"));
  ok(cred.status === 400, "credentials in url -> 400");

  // watch-page fallback: the page embeds ytInitialPlayerResponse - the API
  // ladder must not even be touched when the page answers.
  const web = await call("/api/info?url=" + encodeURIComponent("https://www.youtube.com/watch?v=webpage0001"));
  const webBody = await web.json();
  ok(web.status === 200 && webBody.title === "Webpage Song" && webBody.artist === "Page Artist", "watch-page player response parsed");
  ok(!playerCalls.has("webpage0001"), "no player API call when the watch page answers");
}

// 4. one-shot audio + m4a passthrough
{
  console.log("audio one-shot:");
  const res = await call("/api/audio?url=" + encodeURIComponent(SHORT_URL));
  const bytes = new Uint8Array(await res.arrayBuffer());
  ok(res.status === 200 && isMp3(bytes), "short video -> mp3 bytes", `len=${bytes.length}`);
  ok(res.headers.get("X-YTA-Extension") === "mp3", "X-YTA-Extension: mp3");
  ok((res.headers.get("X-YTA-Format-Note") || "").includes("320 kbps"), "format note mentions 320 kbps");
  ok(res.headers.get("Content-Type") === "audio/mpeg", "content-type audio/mpeg");

  const m4a = await call("/api/audio?url=" + encodeURIComponent(SHORT_URL) + "&format=m4a");
  const m4aBody = new Uint8Array(await m4a.arrayBuffer());
  ok(m4a.status === 200 && m4a.headers.get("X-YTA-Extension") === "m4a", "format=m4a passthrough");
  ok(m4aBody.length === shortM4aBytes.length && m4aBody[4] === 0x66, "m4a bytes are the original source");
  ok((m4a.headers.get("X-YTA-Format-Note") || "").includes("original aac"), "m4a note says original aac");

  const dl = await call("/api/download?url=" + encodeURIComponent(SHORT_URL));
  ok((dl.headers.get("Content-Disposition") || "").startsWith("attachment"), "download = attachment");
  ok((dl.headers.get("Content-Disposition") || "").includes("Test%20Artist") || (dl.headers.get("Content-Disposition") || "").includes("filename="), "download filename present");

  const badFmt = await call("/api/audio?url=" + encodeURIComponent(SHORT_URL) + "&format=wav");
  ok(badFmt.status === 400 && (await badFmt.json()).error.code === "invalid_format", "invalid format -> 400");
  const chunkM4a = await call("/api/audio?url=" + encodeURIComponent(SHORT_URL) + "&format=m4a&chunk=info");
  ok(chunkM4a.status === 400, "chunk= with m4a -> 400");
}

// 5. honest upstream errors
{
  console.log("upstream errors:");
  const cipher = await call("/api/audio?url=" + encodeURIComponent(CIPHER_URL));
  const cipherBody = await cipher.json();
  ok(cipher.status === 415 && cipherBody.error.code === "streams_locked", "cipher-only -> 415 streams_locked");
  ok(/cipher|protected/i.test(cipherBody.error.message) && !/path|index\.ts|file:/.test(cipherBody.error.message), "cipher message honest, no leaks");
  ok((playerCalls.get("ccccccccccc") || 0) >= 2, "multiple clients tried for ciphered video");

  const age = await call("/api/audio?url=" + encodeURIComponent(AGE_URL));
  const ageBody = await age.json();
  ok(age.status === 403 && ageBody.error.code === "not_available" && /age|sign in/i.test(ageBody.error.message), "age-restricted -> 403 with reason");

  const bot = await call("/api/audio?url=" + encodeURIComponent("https://www.youtube.com/watch?v=ggggggggggg"));
  const botBody = await bot.json();
  ok(bot.status === 429 && botBody.error.code === "bot_check", "bot-check wall -> 429 bot_check");
  ok(/not a bot/i.test(botBody.error.message) && /nothing was signed in or bypassed/i.test(botBody.error.message),
    "bot-check message honest, no bypass claims");

  const webm = await call("/api/audio?url=" + encodeURIComponent(WEBM_URL));
  const webmBody = await webm.json();
  ok(webm.status === 415 && webmBody.error.code === "no_usable_audio", "opus-only -> 415 no_usable_audio");

  const big = await call("/api/audio?url=" + encodeURIComponent(LONGID_URL));
  const bigBody = await big.json();
  ok(big.status === 413 && bigBody.error.code === "too_long", "oversized source -> 413 too_long");
}

// 6. chunked conversion + server-side cache
{
  console.log("chunked + cache:");
  const oneShot = await call("/api/audio?url=" + encodeURIComponent(LONG_URL));
  const oneBody = await oneShot.json();
  ok(oneShot.status === 413 && oneBody.error.code === "chunked_conversion_required", "long video -> 413 chunked_conversion_required");
  ok(/chunks?/.test(oneBody.error.message) && /chunk=info/.test(oneBody.error.message), "413 explains the chunk recipe");

  const plan = await call("/api/audio?url=" + encodeURIComponent(LONG_URL) + "&chunk=info");
  const planBody = await plan.json();
  ok(plan.status === 200 && planBody.chunk_count === 2 && planBody.chunk_seconds === 10, "chunk plan from real audio length", JSON.stringify(planBody));
  ok(plan.headers.get("X-YTA-Cache") === "miss", "plan served as miss");

  const c0 = await call("/api/audio?url=" + encodeURIComponent(LONG_URL) + "&chunk=0");
  const c0b = new Uint8Array(await c0.arrayBuffer());
  ok(c0.status === 200 && isMp3(c0b), "chunk 0 is a valid partial mp3", `len=${c0b.length}`);
  ok(c0.headers.get("X-YTA-Chunk-Index") === "0" && c0.headers.get("X-YTA-Chunk-Count") === "2", "chunk headers");

  const oor = await call("/api/audio?url=" + encodeURIComponent(LONG_URL) + "&chunk=9");
  ok(oor.status === 404 && (await oor.json()).error.code === "invalid_chunk", "out-of-range chunk -> 404");

  const badChunk = await call("/api/audio?url=" + encodeURIComponent(LONG_URL) + "&chunk=abc");
  ok(badChunk.status === 400, "non-numeric chunk -> 400");

  const all = await call("/api/audio?url=" + encodeURIComponent(LONG_URL) + "&chunk=all");
  const allBody = await all.json();
  ok(all.status === 409 && allBody.error.code === "chunks_not_cached", "chunk=all before fill -> 409");
  ok(Array.isArray(allBody.error.missing) && allBody.error.missing.includes(1), "409 lists missing chunks");

  // ---- enable the server-side cache for the rest ----
  process.env.SUPABASE_URL = "https://supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-test-key";

  const c0f = await call("/api/audio?url=" + encodeURIComponent(LONG_URL) + "&chunk=0");
  const c0fB = new Uint8Array(await c0f.arrayBuffer());
  ok(c0f.headers.get("X-YTA-Cache") === "miss" && isMp3(c0fB), "chunk 0 converts + stores (miss)");

  const c0hit = await call("/api/audio?url=" + encodeURIComponent(LONG_URL) + "&chunk=0");
  const c0hitB = new Uint8Array(await c0hit.arrayBuffer());
  ok(c0hit.headers.get("X-YTA-Cache") === "hit", "repeat chunk served from cache");
  ok(c0hitB.length === c0fB.length && Buffer.compare(Buffer.from(c0hitB), Buffer.from(c0fB)) === 0, "cached chunk byte-equal");

  const c1f = await call("/api/audio?url=" + encodeURIComponent(LONG_URL) + "&chunk=1");
  const c1fB = new Uint8Array(await c1f.arrayBuffer());
  ok(c1f.status === 200 && c1f.headers.get("X-YTA-Cache") === "miss" && isMp3(c1fB), "chunk 1 converts + stores");

  const planHit = await call("/api/audio?url=" + encodeURIComponent(LONG_URL) + "&chunk=info");
  ok(planHit.headers.get("X-YTA-Cache") === "hit", "plan served from cache");

  const allDone = await call("/api/audio?url=" + encodeURIComponent(LONG_URL) + "&chunk=all");
  const allDoneB = new Uint8Array(await allDone.arrayBuffer());
  const expect = Buffer.concat([Buffer.from(c0fB), Buffer.from(c1fB)]);
  ok(allDone.status === 200 && allDone.headers.get("X-YTA-Cache") === "hit", "chunk=all assembled");
  ok(allDoneB.length === expect.length && Buffer.compare(Buffer.from(allDoneB), expect) === 0, "assembly byte-equal to chunk concat");
  ok(isMp3(allDoneB), "assembled file is an mp3");

  // whole-file cache for short videos
  const short1 = await call("/api/audio?url=" + encodeURIComponent(SHORT_URL));
  const short1B = new Uint8Array(await short1.arrayBuffer());
  const short2 = await call("/api/audio?url=" + encodeURIComponent(SHORT_URL));
  const short2B = new Uint8Array(await short2.arrayBuffer());
  ok(short1.headers.get("X-YTA-Cache") === "miss" && short2.headers.get("X-YTA-Cache") === "hit", "whole-file miss -> hit");
  ok(short2B.length === short1B.length && Buffer.compare(Buffer.from(short2B), Buffer.from(short1B)) === 0, "whole-file cache byte-equal");

  const health2 = await call("/api/health");
  const hb2 = await health2.json();
  ok(hb2.cache === "on" && hb2.cache_error === null, "health shows cache on, no errors");

  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
