// Local tests for supabase/functions/ssda/index.ts (no network needed).
// Mocks global fetch to simulate SoundCloud, then exercises every endpoint.
//
//   node tools/test-ssda.mjs
//
import { handleRequest } from "../supabase/functions/ssda/index.ts";

const CID = "CID1234567890abcdefghij";
const BASE = "https://zfshvxknthgzlgzulpuq.supabase.co/functions/v1/ssda";

const trackFixture = {
  kind: "track",
  id: 987654321,
  title: "Test Track",
  duration: 213456,
  permalink_url: "https://soundcloud.com/test/test-track",
  artwork_url: "https://i1.sndcdn.com/artworks-large.jpg",
  user: { username: "testuser" },
  media: {
    transcodings: [
      { url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:987654321/stream/progressive", format: { protocol: "progressive", mime_type: "audio/mpeg" }, quality: "sq" },
      { url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:987654321/stream/hls", format: { protocol: "hls", mime_type: 'audio/ogg; codecs="opus"' }, quality: "sq" },
      { url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:987654321/stream/hls/aac", format: { protocol: "hls", mime_type: 'audio/mp4; codecs="mp4a.40.2"' }, quality: "sq" },
    ],
  },
};

const restrictedFixture = {
  kind: "track",
  id: 111,
  title: "Restricted",
  duration: 1000,
  permalink_url: "https://soundcloud.com/test/restricted",
  user: { username: "r" },
  media: { transcodings: [] },
};

// transcodings whose format metadata is empty/wrong: only the URL is reliable
const weirdFixture = {
  kind: "track",
  id: 222,
  title: "Weird Mime",
  duration: 60000,
  permalink_url: "https://soundcloud.com/test/weird",
  user: { username: "w" },
  media: {
    transcodings: [
      { url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:222/stream/hls", format: { protocol: "hls", mime_type: "application/octet-stream" }, quality: "sq" },
      { url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:222/stream/progressive", format: {}, quality: "sq" },
    ],
  },
};

const opusMediaPlaylist = [
  "#EXTM3U",
  "#EXT-X-VERSION:3",
  '#EXT-X-MAP:URI="init.ogg"',
  "#EXTINF:4.000,",
  "seg1.ogg",
  "#EXTINF:4.000,",
  "seg2.ogg",
  "#EXTINF:2.500,",
  "https://cf-hls-media.sndcdn.com/opus/seg3.ogg",
  "#EXT-X-ENDLIST",
].join("\n");

const aacMasterPlaylist = [
  "#EXTM3U",
  "#EXT-X-STREAM-INF:BANDWIDTH=256000,CODECS=\"mp4a.40.2\"",
  "media/playlist.m3u8",
].join("\n");

const aacMediaPlaylist = [
  "#EXTM3U",
  '#EXT-X-MAP:URI="init.mp4"',
  "#EXTINF:4.000,",
  "fragment1.m4s",
  "#EXTINF:4.000,",
  "fragment2.m4s",
  "#EXT-X-ENDLIST",
].join("\n");

const realFetch = globalThis.fetch;
let homeCalls = 0;
let flakyCalls = 0;
let blockMode = false; // when true, every entry page is a bot-challenge page

const goodHome = `<html><script src="https://a-v2.sndcdn.com/assets/0-old.js"></script>
  <script crossorigin src="//a-v2.sndcdn.com/assets/99-app.js"></script></html>`;
const challengePage = "<html><title>Just a moment...</title>" + "x".repeat(800) + "</html>";

globalThis.fetch = async (input, init) => {
  const u = String(input instanceof Request ? input.url : input);
  const R = (body, status = 200, headers = {}) =>
    new Response(body, { status, headers });
  const J = (obj, status = 200) =>
    R(JSON.stringify(obj), status, { "Content-Type": "application/json" });

  if (/^https:\/\/(www\.|m\.)?soundcloud\.com\/(discover)?\/?$/.test(u)) {
    homeCalls++;
    if (blockMode) return R(challengePage);
    // first call serves a challenge page -> discovery must retry
    return R(homeCalls === 1 ? challengePage : goodHome);
  }
  if (u.startsWith("https://soundcloud.com/oembed")) {
    if (blockMode) return J({ title: "Harvey", author_name: "Alex G", thumbnail_url: "https://i1.sndcdn.com/artworks-x-large.jpg" });
    return J({}, 404);
  }
  if (u.startsWith("https://api-v2.soundcloud.com/resolve") && blockMode) {
    return R("blocked", 503);
  }
  if (u.includes("a-v2.sndcdn.com/assets/99-app.js")) {
    return R(`var cfg={client_id:"${CID}",foo:1};`);
  }
  if (u.includes("a-v2.sndcdn.com/assets/")) {
    return R("var nothing=1;");
  }
  if (u.startsWith("https://api-v2.soundcloud.com/resolve")) {
    const target = new URL(u).searchParams.get("url") || "";
    if (target.includes("restricted")) return J(restrictedFixture);
    if (target.includes("weird")) return J(weirdFixture);
    if (target.includes("flaky")) {
      // first resolve omits renditions, retry returns them
      flakyCalls++;
      return J(flakyCalls === 1 ? { ...trackFixture, media: { transcodings: [] } } : trackFixture);
    }
    if (target.includes("missing")) return J({ errors: [{ error_message: "404 - Not Found" }] }, 404);
    return J(trackFixture);
  }
  if (u.includes("/stream/progressive?") || u.includes("/stream/progressive&")) {
    return J({ url: "https://cf-media.sndcdn.com/tkHfEWxK.mp3" });
  }
  if (u.includes("/stream/hls/aac")) {
    return J({ url: "https://cf-hls-media.sndcdn.com/aac/master.m3u8?token=abc" });
  }
  if (u.includes("/stream/hls")) {
    return J({ url: "https://cf-hls-media.sndcdn.com/opus/playlist.m3u8?token=abc" });
  }
  if (u === "https://cf-media.sndcdn.com/tkHfEWxK.mp3") {
    return R(new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]), 200, { "Content-Type": "audio/mpeg", "Content-Length": "6" });
  }
  if (u.startsWith("https://cf-hls-media.sndcdn.com/opus/playlist.m3u8")) {
    return R(opusMediaPlaylist);
  }
  if (u.startsWith("https://cf-hls-media.sndcdn.com/opus/init.ogg")) return R(new Uint8Array([0x4f, 0x67, 0x67, 0x53]));
  if (u.startsWith("https://cf-hls-media.sndcdn.com/opus/seg1.ogg")) return R(new Uint8Array([1, 1]));
  if (u.startsWith("https://cf-hls-media.sndcdn.com/opus/seg2.ogg")) return R(new Uint8Array([2, 2]));
  if (u.startsWith("https://cf-hls-media.sndcdn.com/opus/seg3.ogg")) return R(new Uint8Array([3, 3]));
  if (u.startsWith("https://cf-hls-media.sndcdn.com/aac/master.m3u8")) return R(aacMasterPlaylist);
  if (u.startsWith("https://cf-hls-media.sndcdn.com/aac/media/playlist.m3u8")) return R(aacMediaPlaylist);
  if (u.startsWith("https://cf-hls-media.sndcdn.com/aac/media/init.mp4")) return R(new Uint8Array([0x66, 0x74, 0x79, 0x70]));
  if (u.startsWith("https://cf-hls-media.sndcdn.com/aac/media/fragment1.m4s")) return R(new Uint8Array([0xaa]));
  if (u.startsWith("https://cf-hls-media.sndcdn.com/aac/media/fragment2.m4s")) return R(new Uint8Array([0xbb]));
  if (u.startsWith("https://on.soundcloud.com/short1")) {
    return R(null, 302, { Location: "https://soundcloud.com/test/test-track" });
  }
  console.log("UNMOCKED FETCH:", u);
  return realFetch(input, init);
};

// ---------------------------------------------------------------- assertions

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

// 1. service index + health
{
  console.log("index / health:");
  const idx = await call("/");
  const idxBody = await idx.json();
  ok(idx.status === 200 && idxBody.name === "SSDA", "GET / returns service index");
  ok(idx.headers.get("Access-Control-Allow-Origin") === "*", "CORS header present");

  const health = await call("/api/health");
  const hb = await health.json();
  ok(health.status === 200 && hb.ok === true && hb.version, "GET /api/health");
}

// 2. OPTIONS preflight
{
  console.log("preflight:");
  const res = await call("/api/audio", { method: "OPTIONS" });
  ok(res.status === 204, "OPTIONS returns 204", "got " + res.status);
  ok(res.headers.get("Access-Control-Allow-Origin") === "*", "OPTIONS has CORS");
}

// 3. info
{
  console.log("info:");
  const res = await call("/api/info?url=" + encodeURIComponent("https://on.soundcloud.com/short1"));
  const body = await res.json();
  ok(res.status === 200, "GET /api/info status 200");
  ok(body.title === "Test Track" && body.artist === "testuser", "metadata resolved", JSON.stringify(body));
  ok(body.duration === 213, "duration ms -> s", String(body.duration));
  ok(body.permalink_url === "https://soundcloud.com/test/test-track", "short link resolved via redirect + api");
}

// 4. audio formats
{
  console.log("audio formats:");
  const auto = await call("/api/audio?url=" + encodeURIComponent("https://soundcloud.com/test/test-track"));
  const autoBytes = new Uint8Array(await auto.arrayBuffer());
  ok(auto.status === 200, "auto status 200");
  ok(auto.headers.get("X-SSDA-Extension") === "opus", "auto prefers opus", auto.headers.get("X-SSDA-Extension"));
  ok(auto.headers.get("Content-Type") === "audio/ogg", "auto opus mime");
  ok(autoBytes.length === 10 && autoBytes[0] === 0x4f, "auto: init.ogg + seg1 + seg2 + seg3 concatenated", "len=" + autoBytes.length);
  ok(String(auto.headers.get("Content-Disposition")).startsWith("inline;"), "auto inline disposition");

  const mp3 = await call("/api/audio?url=" + encodeURIComponent("https://soundcloud.com/test/test-track") + "&format=mp3");
  const mp3Bytes = new Uint8Array(await mp3.arrayBuffer());
  ok(mp3.headers.get("X-SSDA-Extension") === "mp3" && mp3Bytes.length === 6, "mp3 progressive passthrough");

  const m4a = await call("/api/audio?url=" + encodeURIComponent("https://soundcloud.com/test/test-track") + "&format=m4a");
  const m4aBytes = new Uint8Array(await m4a.arrayBuffer());
  ok(m4a.headers.get("X-SSDA-Extension") === "m4a", "m4a extension");
  ok(m4aBytes.length === 6 && m4aBytes[0] === 0x66, "m4a: init.mp4 + f1 + f2 concatenated (master playlist handled)", "len=" + m4aBytes.length);

  const dl = await call("/api/download?url=" + encodeURIComponent("https://soundcloud.com/test/test-track"));
  ok(String(dl.headers.get("Content-Disposition")).startsWith("attachment;"), "download endpoint uses attachment");
  ok(!!dl.headers.get("Content-Length"), "Content-Length set on buffered response");
}

// 5. errors
{
  console.log("errors:");
  const noUrl = await call("/api/info");
  ok(noUrl.status === 400, "missing url -> 400", String(noUrl.status));
  const badHost = await call("/api/audio?url=" + encodeURIComponent("https://evil.example.com/x"));
  ok(badHost.status === 400 && (await badHost.json()).error.code === "invalid_url", "bad host -> 400 invalid_url");
  const badFmt = await call("/api/audio?url=" + encodeURIComponent("https://soundcloud.com/test/test-track") + "&format=flac");
  ok(badFmt.status === 400 && (await badFmt.json()).error.code === "invalid_format", "bad format -> 400");
  const restricted = await call("/api/audio?url=" + encodeURIComponent("https://soundcloud.com/test/restricted"));
  ok(restricted.status === 403 && (await restricted.json()).error.code === "not_streamable", "restricted track -> 403", String(restricted.status));
  const missing = await call("/api/info?url=" + encodeURIComponent("https://soundcloud.com/test/missing"));
  ok(missing.status === 404 && (await missing.json()).error.code === "track_not_found", "missing track -> 404");
  const unknown = await call("/api/nope");
  ok(unknown.status === 404, "unknown endpoint -> 404");
}

// 6. classification by stream URL when format metadata is wrong
{
  console.log("classification:");
  const auto = await call("/api/audio?url=" + encodeURIComponent("https://soundcloud.com/test/weird"));
  ok(auto.headers.get("X-SSDA-Extension") === "opus" && auto.headers.get("Content-Type") === "audio/ogg",
    "hls URL classifies as opus despite odd mime", auto.headers.get("X-SSDA-Extension"));
  const mp3 = await call("/api/audio?url=" + encodeURIComponent("https://soundcloud.com/test/weird") + "&format=mp3");
  ok(mp3.status === 200 && mp3.headers.get("X-SSDA-Extension") === "mp3",
    "progressive URL classifies as mp3 despite empty format", String(mp3.status));
  const dbg = await call("/api/info?url=" + encodeURIComponent("https://soundcloud.com/test/weird") + "&debug=1");
  const dbgBody = await dbg.json();
  ok(Array.isArray(dbgBody.transcodings) && dbgBody.transcodings.length === 2 && dbgBody.transcodings[0].class === "opus",
    "debug reports transcoding classification", JSON.stringify(dbgBody.transcodings));
}

// 7. flaky upstream: empty renditions on first resolve -> retry succeeds
{
  console.log("flaky resolve:");
  const res = await call("/api/audio?url=" + encodeURIComponent("https://soundcloud.com/test/flaky-track"));
  ok(res.status === 200 && res.headers.get("X-SSDA-Extension") === "opus",
    "empty-renditions resolve is retried", res.status + " " + res.headers.get("X-SSDA-Extension"));
}

// 8. resilience: challenge page retry + oEmbed fallback
{
  console.log("resilience:");
  // fresh module instance -> empty client_id cache; mock serves a challenge
  // page on the first home fetch, so success here proves discovery retries.
  const mod = await import("../supabase/functions/ssda/index.ts?fresh=1");
  const call2 = (path, init) => mod.handleRequest(new Request(BASE + path, init));
  homeCalls = 0;
  const res = await call2("/api/info?url=" + encodeURIComponent("https://soundcloud.com/test/test-track"));
  ok(res.status === 200 && (await res.json()).title === "Test Track", "client_id discovery survives a challenge page (retry)");

  blockMode = true;
  const fb = await call2("/api/info?url=" + encodeURIComponent("https://on.soundcloud.com/short1"));
  const fbBody = await fb.json();
  ok(fb.status === 200 && fbBody.title === "Harvey" && fbBody.artist === "Alex G", "oEmbed fallback returns degraded metadata", JSON.stringify(fbBody));
  const fbAudio = await call2("/api/audio?url=" + encodeURIComponent("https://soundcloud.com/test/test-track"));
  ok(fbAudio.status === 502 && (await fbAudio.json()).error.code === "upstream", "audio still fails honestly when blocked");
  blockMode = false;
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
