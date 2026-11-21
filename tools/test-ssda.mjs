// Local tests for supabase/functions/ssda/index.ts (no network needed).
// Mocks global fetch to simulate SoundCloud, then exercises every endpoint.
//
//   node tools/test-ssda.mjs
//
import { handleRequest } from "../supabase/functions/ssda/index.ts";

const CID = "CID1234567890abcdefghij";
const BASE = "https://zfshvxknthgzlgzulpuq.supabase.co/functions/v1/ssda";

// ---------- fixtures ----------

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
      { url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:987654321/stream/hls/aac", format: { protocol: "hls", mime_type: 'audio/mp4; codecs="mp4a.40.2"' }, quality: "sq" },
      { url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:987654321/stream/hls", format: { protocol: "hls", mime_type: 'audio/ogg; codecs="opus"' }, quality: "sq" },
      { url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:987654321/stream/hls/mpegurl", format: { protocol: "hls", mime_type: "audio/mpegurl" }, quality: "sq" },
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

// wrong/empty mime metadata: only the stream URL and the real bytes decide
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

// media endpoint requires track_authorization
const authFixture = {
  kind: "track",
  id: 777,
  title: "Auth Track",
  duration: 30000,
  permalink_url: "https://soundcloud.com/test/auth-track",
  track_authorization: "TOKEN123",
  user: { username: "a" },
  media: {
    transcodings: [
      { url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:777/xyz/stream/progressive", format: { protocol: "progressive", mime_type: "audio/mpeg" }, quality: "sq" },
    ],
  },
};

// only a TS-container HLS rendition -> must be demuxed to ADTS aac
const tsFixture = {
  kind: "track",
  id: 333,
  title: "TS Track",
  duration: 30000,
  permalink_url: "https://soundcloud.com/test/ts-track",
  user: { username: "t" },
  media: {
    transcodings: [
      { url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:333/stream/hls/ts", format: { protocol: "hls", mime_type: "audio/mpegurl" }, quality: "sq" },
    ],
  },
};

// first rendition is broken (unknown container); second must be used instead
const skipBadFixture = {
  kind: "track",
  id: 444,
  title: "Skip Bad",
  duration: 30000,
  permalink_url: "https://soundcloud.com/test/skip-bad",
  user: { username: "s" },
  media: {
    transcodings: [
      { url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:444/stream/hls/badaac", format: { protocol: "hls", mime_type: 'audio/mp4; codecs="mp4a.40.2"' }, quality: "sq" },
      { url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:444/stream/progressive", format: { protocol: "progressive", mime_type: "audio/mpeg" }, quality: "sq" },
    ],
  },
};

// only DRM-wrapped renditions, but the artist allows downloads
const downloadFixture = {
  kind: "track",
  id: 601,
  title: "Download Track",
  duration: 30000,
  permalink_url: "https://soundcloud.com/test/download-track",
  downloadable: true,
  has_downloads_left: 5,
  user: { username: "d" },
  media: {
    transcodings: [
      { url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:601/stream/cbc-encrypted-hls", format: { protocol: "cbc-encrypted-hls", mime_type: 'audio/mp4; codecs="mp4a.40.2"' }, quality: "sq" },
    ],
  },
};

// DRM-only and no downloads -> clear error
const drmOnlyFixture = {
  kind: "track",
  id: 602,
  title: "DRM Only",
  duration: 30000,
  permalink_url: "https://soundcloud.com/test/drm-only",
  downloadable: false,
  user: { username: "x" },
  media: {
    transcodings: [
      { url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:602/stream/cbc-encrypted-hls", format: { protocol: "cbc-encrypted-hls", mime_type: 'audio/mp4; codecs="mp4a.40.2"' }, quality: "sq" },
    ],
  },
};

// no renditions at all, only a downloadable original (wav)
const wavFixture = {
  kind: "track",
  id: 603,
  title: "Wav Track",
  duration: 30000,
  permalink_url: "https://soundcloud.com/test/wav-track",
  downloadable: true,
  has_downloads_left: 2,
  user: { username: "w" },
  media: { transcodings: [] },
};

// clear progressive AND DRM AND download -> progressive must win
const mixedFixture = {
  kind: "track",
  id: 604,
  title: "Mixed Track",
  duration: 30000,
  permalink_url: "https://soundcloud.com/test/mixed-track",
  downloadable: true,
  has_downloads_left: 9,
  user: { username: "m" },
  media: {
    transcodings: [
      { url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:604/stream/cbc-encrypted-hls", format: { protocol: "cbc-encrypted-hls", mime_type: 'audio/mp4; codecs="mp4a.40.2"' }, quality: "sq" },
      { url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:604/stream/progressive", format: { protocol: "progressive", mime_type: "audio/mpeg" }, quality: "sq" },
    ],
  },
};

// only one generic-hls rendition whose real bytes are Ogg -> served as opus
const oggOnlyFixture = {
  kind: "track",
  id: 555,
  title: "Ogg Only",
  duration: 30000,
  permalink_url: "https://soundcloud.com/test/ogg-only",
  user: { username: "o" },
  media: {
    transcodings: [
      { url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:555/stream/hls/oggonly", format: { protocol: "hls", mime_type: "application/octet-stream" }, quality: "sq" },
    ],
  },
};

const opusMediaPlaylist = [
  "#EXTM3U",
  '#EXT-X-MAP:URI="init.ogg"',
  "#EXTINF:4.000,",
  "seg1.ogg",
  "#EXTINF:4.000,",
  "seg2.ogg",
  "#EXT-X-ENDLIST",
].join("\n");

const aacMasterPlaylist = [
  "#EXTM3U",
  '#EXT-X-STREAM-INF:BANDWIDTH=160000,CODECS="mp4a.40.2"',
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

const badMediaPlaylist = [
  "#EXTM3U",
  "#EXTINF:4.000,",
  "junk.bin",
  "#EXT-X-ENDLIST",
].join("\n");

const tsMediaPlaylist = [
  "#EXTM3U",
  "#EXTINF:4.000,",
  "seg0.ts",
  "#EXT-X-ENDLIST",
].join("\n");

const drmMediaPlaylist = [
  "#EXTM3U",
  "#EXT-X-VERSION:7",
  '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://deadbeef",KEYFORMAT="com.apple.streamingkeydelivery"',
  '#EXT-X-MAP:URI="init.mp4"',
  "#EXTINF:4.000,",
  "seg.m4s",
  "#EXT-X-ENDLIST",
].join("\n");

// two MPEG-TS packets carrying one PES with one ADTS frame (9 bytes)
function makeTs() {
  const adts = [0xff, 0xf1, 0x50, 0x80, 0x01, 0x3f, 0xfc, 0x11, 0x22]; // frame_length = 9
  const pes = [0x00, 0x00, 0x01, 0xc0, 0x00, 0x10, 0x80, 0x80, 0x05, 0, 0, 0, 0, 0];
  const payload = pes.concat(adts);
  const pkt = new Uint8Array(188);
  pkt[0] = 0x47;
  pkt[1] = 0x41; // PUSI + pid hi (pid 0x0100)
  pkt[2] = 0x00;
  pkt[3] = 0x10; // adaptation: payload only
  pkt.set(payload, 4);
  pkt.fill(0xff, 4 + payload.length);
  return new Uint8Array([...pkt, ...pkt]); // two packets -> container sniffing sees sync at 0 and 188
}

// ---------- mock network ----------

const realFetch = globalThis.fetch;
let homeCalls = 0;
let flakyCalls = 0;
let blockedFlakyCalls = 0;
let blockMode = false;

const goodHome = `<html><script src="https://a-v2.sndcdn.com/assets/0-old.js"></script>
  <script crossorigin src="//a-v2.sndcdn.com/assets/99-app.js"></script></html>`;
const challengePage = "<html><title>Just a moment...</title>" + "x".repeat(800) + "</html>";

globalThis.fetch = async (input) => {
  const u = String(input instanceof Request ? input.url : input);
  const R = (body, status = 200, headers = {}) => new Response(body, { status, headers });
  const J = (obj, status = 200) => R(JSON.stringify(obj), status, { "Content-Type": "application/json" });

  if (/^https:\/\/(www\.|m\.)?soundcloud\.com\/(discover)?\/?$/.test(u)) {
    homeCalls++;
    if (blockMode) return R(challengePage);
    return R(homeCalls === 1 ? challengePage : goodHome); // first call is a bot-challenge
  }
  if (u.startsWith("https://soundcloud.com/oembed")) {
    return blockMode
      ? J({ title: "Harvey", author_name: "Alex G", thumbnail_url: "https://i1.sndcdn.com/artworks-x-large.jpg" })
      : J({}, 404);
  }
  if (u.includes("a-v2.sndcdn.com/assets/99-app.js")) {
    return R(`var cfg={client_id:"${CID}",foo:1};`);
  }
  if (u.includes("a-v2.sndcdn.com/assets/")) {
    return R("var nothing=1;");
  }
  if (u.startsWith("https://api-v2.soundcloud.com/resolve")) {
    const target = new URL(u).searchParams.get("url") || "";
    if (blockMode) return R("blocked", 503);
    if (target.includes("restricted")) return J(restrictedFixture);
    if (target.includes("weird")) return J(weirdFixture);
    if (target.includes("ogg-only")) return J(oggOnlyFixture);
    if (target.includes("download-track")) return J(downloadFixture);
    if (target.includes("drm-only")) return J(drmOnlyFixture);
    if (target.includes("wav-track")) return J(wavFixture);
    if (target.includes("mixed-track")) return J(mixedFixture);
    if (target.includes("auth-track")) return J(authFixture);
    if (target.includes("ts-track")) return J(tsFixture);
    if (target.includes("skip-bad")) return J(skipBadFixture);
    if (target.includes("flaky")) {
      flakyCalls++;
      return J(flakyCalls === 1 ? { ...trackFixture, media: { transcodings: [] } } : trackFixture);
    }
    if (target.includes("blocked-flaky")) {
      blockedFlakyCalls++;
      return J(blockedFlakyCalls === 1
        ? { ...trackFixture, policy: "BLOCK", media: { transcodings: [] } }
        : trackFixture);
    }
    if (target.includes("missing")) return J({ errors: [{ error_message: "404 - Not Found" }] }, 404);
    return J(trackFixture);
  }
  // media stream-URL endpoints
  if (u.includes("soundcloud:tracks:777")) {
    if (!u.includes("track_authorization=TOKEN123")) return J({ error: "not found" }, 404);
    return J({ url: "https://cf-media.sndcdn.com/auth.mp3" });
  }
  if (u.includes("/stream/cbc-encrypted-hls")) return J({ url: "https://cf-hls-media.sndcdn.com/drm/playlist.m3u8" });
  if (u.includes("/tracks/601/download")) return J({ url: "https://cf-media.sndcdn.com/x1.128.mp3" });
  if (u.includes("/tracks/603/download")) return J({ url: "https://cf-media.sndcdn.com/x3.wav" });
  if (u.includes("/tracks/604/download")) return J({ url: "https://cf-media.sndcdn.com/x4.128.mp3" });
  if (u.includes("/stream/progressive")) return J({ url: "https://cf-media.sndcdn.com/tkHfEWxK.mp3" });
  if (u.includes("/stream/hls/badaac")) return J({ url: "https://cf-hls-media.sndcdn.com/bad/playlist.m3u8" });
  if (u.includes("/stream/hls/ts")) return J({ url: "https://cf-hls-media.sndcdn.com/ts/playlist.m3u8" });
  if (u.includes("/stream/hls/oggonly")) return J({ url: "https://cf-hls-media.sndcdn.com/opus/playlist.m3u8?token=abc" });
  if (u.includes("/stream/hls/aac")) return J({ url: "https://cf-hls-media.sndcdn.com/aac/master.m3u8?token=abc" });
  if (u.includes("/stream/hls")) return J({ url: "https://cf-hls-media.sndcdn.com/opus/playlist.m3u8?token=abc" });
  // audio bytes / playlists
  if (u === "https://cf-media.sndcdn.com/tkHfEWxK.mp3" || u === "https://cf-media.sndcdn.com/auth.mp3") {
    return R(new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]), 200, { "Content-Type": "audio/mpeg", "Content-Length": "6" });
  }
  if (u === "https://cf-media.sndcdn.com/x1.128.mp3" || u === "https://cf-media.sndcdn.com/x4.128.mp3") {
    return R(new Uint8Array([0x49, 0x44, 0x33, 9, 9, 9, 9, 9, 9]), 200, { "Content-Type": "audio/mpeg" });
  }
  if (u === "https://cf-media.sndcdn.com/x3.wav") {
    return R(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45, 0, 0]), 200, { "Content-Type": "audio/wav" });
  }
  if (u.startsWith("https://cf-hls-media.sndcdn.com/drm/playlist.m3u8")) return R(drmMediaPlaylist);
  if (u.startsWith("https://cf-hls-media.sndcdn.com/drm/init.mp4")) {
    return R(new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x35]));
  }
  if (u.startsWith("https://cf-hls-media.sndcdn.com/drm/seg.m4s")) return R(new Uint8Array([0xaa]));
  if (u.startsWith("https://cf-hls-media.sndcdn.com/opus/playlist.m3u8")) return R(opusMediaPlaylist);
  if (u.startsWith("https://cf-hls-media.sndcdn.com/opus/init.ogg")) return R(new Uint8Array([0x4f, 0x67, 0x67, 0x53, 1]));
  if (u.startsWith("https://cf-hls-media.sndcdn.com/opus/seg1.ogg")) return R(new Uint8Array([1, 1]));
  if (u.startsWith("https://cf-hls-media.sndcdn.com/opus/seg2.ogg")) return R(new Uint8Array([2, 2]));
  if (u.startsWith("https://cf-hls-media.sndcdn.com/aac/master.m3u8")) return R(aacMasterPlaylist);
  if (u.startsWith("https://cf-hls-media.sndcdn.com/aac/media/playlist.m3u8")) return R(aacMediaPlaylist);
  if (u.startsWith("https://cf-hls-media.sndcdn.com/aac/media/init.mp4")) {
    return R(new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x35]));
  }
  if (u.startsWith("https://cf-hls-media.sndcdn.com/aac/media/fragment1.m4s")) return R(new Uint8Array([0xaa]));
  if (u.startsWith("https://cf-hls-media.sndcdn.com/aac/media/fragment2.m4s")) return R(new Uint8Array([0xbb]));
  if (u.startsWith("https://cf-hls-media.sndcdn.com/bad/playlist.m3u8")) return R(badMediaPlaylist);
  if (u.startsWith("https://cf-hls-media.sndcdn.com/bad/junk.bin")) return R("hello not audio");
  if (u.startsWith("https://cf-hls-media.sndcdn.com/ts/playlist.m3u8")) return R(tsMediaPlaylist);
  if (u.startsWith("https://cf-hls-media.sndcdn.com/ts/seg0.ts")) return R(makeTs());
  if (u.startsWith("https://on.soundcloud.com/short1")) {
    return R(null, 302, { Location: "https://soundcloud.com/test/test-track" });
  }
  console.log("UNMOCKED FETCH:", u);
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

// 1. service index + health + preflight
{
  console.log("index / health / preflight:");
  const idx = await call("/");
  const idxBody = await idx.json();
  ok(idx.status === 200 && idxBody.name === "SSDA", "GET / returns service index");
  ok(idx.headers.get("Access-Control-Allow-Origin") === "*", "CORS header present");
  const health = await call("/api/health");
  ok(health.status === 200 && (await health.json()).ok === true, "GET /api/health");
  const opt = await call("/api/audio", { method: "OPTIONS" });
  ok(opt.status === 204 && opt.headers.get("Access-Control-Allow-Origin") === "*", "OPTIONS preflight");
}

// 2. info
{
  console.log("info:");
  const res = await call("/api/info?url=" + encodeURIComponent("https://on.soundcloud.com/short1"));
  const body = await res.json();
  ok(res.status === 200 && body.title === "Test Track" && body.artist === "testuser", "metadata resolved", JSON.stringify(body));
  ok(body.duration === 213, "duration ms -> s", String(body.duration));
  ok(body.permalink_url === "https://soundcloud.com/test/test-track", "short link resolved via redirect + api");
}

// 3. format selection (auto now prefers the progressive mp3)
{
  console.log("formats:");
  const auto = await call("/api/audio?url=" + encodeURIComponent("https://soundcloud.com/test/test-track"));
  const autoBytes = new Uint8Array(await auto.arrayBuffer());
  ok(auto.status === 200 && auto.headers.get("X-SSDA-Extension") === "mp3", "auto prefers progressive mp3", auto.headers.get("X-SSDA-Extension"));
  ok(autoBytes.length === 6 && autoBytes[0] === 0x49, "auto serves the mp3 bytes untouched");
  ok(String(auto.headers.get("Content-Disposition")).startsWith("inline;"), "auto inline disposition");

  const mp3 = await call("/api/audio?url=" + encodeURIComponent("https://soundcloud.com/test/test-track") + "&format=mp3");
  ok(mp3.headers.get("X-SSDA-Extension") === "mp3" && mp3.headers.get("Content-Type") === "audio/mpeg", "format=mp3 passthrough");

  const m4a = await call("/api/audio?url=" + encodeURIComponent("https://soundcloud.com/test/test-track") + "&format=m4a");
  const m4aBytes = new Uint8Array(await m4a.arrayBuffer());
  ok(m4a.status === 200 && m4a.headers.get("X-SSDA-Extension") === "m4a", "format=m4a served", String(m4a.status));
  ok(m4aBytes.length === 14 && m4aBytes[4] === 0x66, "m4a: init.mp4 + fragments concatenated (master playlist handled)", "len=" + m4aBytes.length);

  const opus = await call("/api/audio?url=" + encodeURIComponent("https://soundcloud.com/test/test-track") + "&format=opus");
  ok(opus.headers.get("X-SSDA-Extension") === "opus" && opus.headers.get("Content-Type") === "audio/ogg", "format=opus -> ogg assembled");
  const opusBytes = new Uint8Array(await opus.arrayBuffer());
  ok(opusBytes.length === 9 && opusBytes[0] === 0x4f, "opus: init.ogg + segs concatenated", "len=" + opusBytes.length);

  const dl = await call("/api/download?url=" + encodeURIComponent("https://soundcloud.com/test/test-track"));
  ok(String(dl.headers.get("Content-Disposition")).startsWith("attachment;") && !!dl.headers.get("Content-Length"), "download endpoint: attachment + length");
}

// 4. classification
{
  console.log("classification:");
  const dbg = await call("/api/info?url=" + encodeURIComponent("https://soundcloud.com/test/test-track") + "&debug=1");
  const classes = (await dbg.json()).transcodings.map((t) => t.class).join(",");
  ok(classes === "mp3,m4a,opus,hls", "mime-first classes (mpegurl demoted to generic hls)", classes);

  const weird = await call("/api/audio?url=" + encodeURIComponent("https://soundcloud.com/test/weird") + "&format=auto");
  ok(weird.status === 200 && weird.headers.get("X-SSDA-Extension") === "mp3",
    "wrong mime still serves progressive mp3 first", weird.headers.get("X-SSDA-Extension"));

  const weirdOpus = await call("/api/audio?url=" + encodeURIComponent("https://soundcloud.com/test/weird") + "&format=opus");
  ok(weirdOpus.status === 200 && weirdOpus.headers.get("X-SSDA-Extension") === "mp3" &&
    String(weirdOpus.headers.get("X-SSDA-Format-Note")).includes("no opus rendition"),
    "explicit format falls back with a note when only other renditions exist", String(weirdOpus.headers.get("X-SSDA-Format-Note")));

  const oggOnly = await call("/api/audio?url=" + encodeURIComponent("https://soundcloud.com/test/ogg-only") + "&format=auto");
  ok(oggOnly.status === 200 && oggOnly.headers.get("X-SSDA-Extension") === "opus",
    "generic hls with OggS bytes validated and served as opus", String(oggOnly.status) + " " + oggOnly.headers.get("X-SSDA-Extension"));
}

// 5. track_authorization
{
  console.log("track_authorization:");
  const res = await call("/api/audio?url=" + encodeURIComponent("https://soundcloud.com/test/auth-track"));
  ok(res.status === 200 && res.headers.get("X-SSDA-Extension") === "mp3",
    "media URL gets client_id + track_authorization", String(res.status));
}

// 6. container validation and TS demux
{
  console.log("containers:");
  const ts = await call("/api/audio?url=" + encodeURIComponent("https://soundcloud.com/test/ts-track"));
  const tsBytes = new Uint8Array(await ts.arrayBuffer());
  ok(ts.status === 200 && ts.headers.get("X-SSDA-Extension") === "aac", "TS rendition demuxed to adts aac", String(ts.status));
  ok(tsBytes.length === 18 && tsBytes[0] === 0xff, "ADTS frames extracted (2 x 9 bytes)", "len=" + tsBytes.length);
  ok(ts.headers.get("X-SSDA-Format-Note") === "stream container converted to adts aac", "conversion note set");

  const skip = await call("/api/audio?url=" + encodeURIComponent("https://soundcloud.com/test/skip-bad") + "&format=m4a");
  ok(skip.status === 200 && skip.headers.get("X-SSDA-Extension") === "mp3",
    "broken rendition skipped, next candidate served", String(skip.status) + " " + skip.headers.get("X-SSDA-Extension"));
  ok(String(skip.headers.get("X-SSDA-Format-Note")).includes("no m4a rendition"), "fallback note present", String(skip.headers.get("X-SSDA-Format-Note")));
}

// 6b. DRM and the official download file
{
  console.log("drm + download:");
  const dl = await call("/api/audio?url=" + encodeURIComponent("https://soundcloud.com/test/download-track"));
  ok(dl.status === 200 && dl.headers.get("X-SSDA-Extension") === "mp3" && dl.headers.get("X-SSDA-Format-Note") === "original download file",
    "DRM-only track served from the official download file", String(dl.status) + " " + dl.headers.get("X-SSDA-Extension"));
  const dlBytes = new Uint8Array(await dl.arrayBuffer());
  ok(dlBytes.length === 9 && dlBytes[0] === 0x49, "download file passed through untouched");

  const drm = await call("/api/audio?url=" + encodeURIComponent("https://soundcloud.com/test/drm-only"));
  ok(drm.status === 415 && (await drm.json()).error.code === "drm_protected",
    "DRM-only track without downloads -> clear drm error", String(drm.status));

  const wav = await call("/api/audio?url=" + encodeURIComponent("https://soundcloud.com/test/wav-track"));
  ok(wav.status === 200 && wav.headers.get("X-SSDA-Extension") === "wav",
    "download-only original (wav) still served", String(wav.status) + " " + wav.headers.get("X-SSDA-Extension"));

  const mixed = await call("/api/audio?url=" + encodeURIComponent("https://soundcloud.com/test/mixed-track"));
  const mixedBytes = new Uint8Array(await mixed.arrayBuffer());
  ok(mixed.status === 200 && mixed.headers.get("X-SSDA-Extension") === "mp3" && mixedBytes.length === 6,
    "clear rendition beats download and DRM", mixedBytes.length + " bytes");

  const probe = await call("/api/audio?url=" + encodeURIComponent("https://soundcloud.com/test/download-track") + "&debug=probe");
  const probeBody = await probe.json();
  ok(probeBody.downloadable === true && probeBody.served?.download === true,
    "probe reports downloadable + download candidate", JSON.stringify(probeBody.served));
}

// 7. errors
{
  console.log("errors:");
  ok((await call("/api/info")).status === 400, "missing url -> 400");
  const badHost = await call("/api/audio?url=" + encodeURIComponent("https://evil.example.com/x"));
  ok(badHost.status === 400 && (await badHost.json()).error.code === "invalid_url", "bad host -> 400");
  const badFmt = await call("/api/audio?url=" + encodeURIComponent("https://soundcloud.com/test/test-track") + "&format=flac");
  ok(badFmt.status === 400, "bad format -> 400");
  const restricted = await call("/api/audio?url=" + encodeURIComponent("https://soundcloud.com/test/restricted"));
  ok(restricted.status === 403 && (await restricted.json()).error.code === "not_streamable", "restricted track -> 403", String(restricted.status));
  const missing = await call("/api/info?url=" + encodeURIComponent("https://soundcloud.com/test/missing"));
  ok(missing.status === 404, "missing track -> 404");
  ok((await call("/api/nope")).status === 404, "unknown endpoint -> 404");
}

// 8. upstream roulette retries
{
  console.log("upstream retries:");
  const flaky = await call("/api/audio?url=" + encodeURIComponent("https://soundcloud.com/test/flaky-track"));
  ok(flaky.status === 200 && flaky.headers.get("X-SSDA-Extension") === "mp3", "empty-renditions resolve is retried");

  const blocked = await call("/api/audio?url=" + encodeURIComponent("https://soundcloud.com/test/blocked-flaky"));
  ok(blocked.status === 200 && blocked.headers.get("X-SSDA-Extension") === "mp3", "policy=BLOCK resolve is retried until renditions appear");
}

// 9. resilience: challenge page + oEmbed fallback
{
  console.log("resilience:");
  const mod = await import("../supabase/functions/ssda/index.ts?fresh=2");
  const call2 = (path, init) => mod.handleRequest(new Request(BASE + path, init));
  homeCalls = 0;
  const res = await call2("/api/info?url=" + encodeURIComponent("https://soundcloud.com/test/test-track"));
  ok(res.status === 200 && (await res.json()).title === "Test Track", "client_id discovery survives a challenge page (retry)");

  blockMode = true;
  const fb = await call2("/api/info?url=" + encodeURIComponent("https://on.soundcloud.com/short1"));
  const fbBody = await fb.json();
  ok(fb.status === 200 && fbBody.title === "Harvey" && fbBody.artist === "Alex G", "oEmbed fallback returns degraded metadata", JSON.stringify(fbBody));
  const fbAudio = await call2("/api/audio?url=" + encodeURIComponent("https://soundcloud.com/test/test-track"));
  ok(fbAudio.status !== 200 && (await fbAudio.json()).error, "audio fails with a clear error when fully blocked");
  blockMode = false;
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
