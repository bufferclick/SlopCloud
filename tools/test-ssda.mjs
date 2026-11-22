// Local tests for supabase/functions/ssda/index.ts (no network needed).
// Mocks global fetch to simulate SoundCloud, then exercises every endpoint.
//
//   node tools/test-ssda.mjs
//
// Node loader hooks map the function's `npm:` imports (and .wasm asset
// imports) onto the local node_modules install, so run `npm install` first.
import { register } from "node:module";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCipheriv } from "node:crypto";
register("./npm-hook.mjs", import.meta.url);

import { Conversion, Input, Output, BufferTarget, BufferSource, Mp3OutputFormat, Mp4OutputFormat, WaveInputFormat } from "mediabunny";
import { registerMp3Encoder } from "@mediabunny/mp3-encoder";
import { registerAacEncoder } from "@mediabunny/aac-encoder";

const { handleRequest } = await import("../supabase/functions/ssda/index.ts");

const CID = "CID1234567890abcdefghij";
const CID2 = "CID2stuvwxz0123456789ab";
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
  duration: 20000,
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
  duration: 20000,
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
  duration: 20000,
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
  duration: 20000,
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
  duration: 20000,
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
  duration: 20000,
  permalink_url: "https://soundcloud.com/test/wav-track",
  downloadable: true,
  has_downloads_left: 2,
  user: { username: "w" },
  media: { transcodings: [] },
};

// SoundCloud's profile roulette: the same track alternates between a
// DRM-only rendition profile and a playable one. The first resolve answers
// with DRM-only transcodings (like the live Harvey probes), the retry with a
// clear progressive rendition.
const drmFlakyFixture = {
  kind: "track",
  id: 620,
  title: "DRM Flaky",
  duration: 20000,
  permalink_url: "https://soundcloud.com/test/drm-flaky",
  user: { username: "d" },
  media: {
    transcodings: [
      { url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:620/aaa/stream/cbc-encrypted-hls", format: { protocol: "cbc-encrypted-hls", mime_type: 'audio/mp4; codecs="mp4a.40.2"' }, quality: "sq" },
      { url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:620/bbb/stream/ctr-encrypted-hls", format: { protocol: "ctr-encrypted-hls", mime_type: 'audio/mp4; codecs="mp4a.40.2"' }, quality: "sq" },
    ],
  },
};
const drmFlakyFixtureClear = {
  ...drmFlakyFixture,
  media: {
    transcodings: [
      { url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:620/stream/progressive", format: { protocol: "progressive", mime_type: "audio/mpeg" }, quality: "sq" },
    ],
  },
};

// the api-v2 rendition is broken AND the legacy stream rate-limits (429)
// before serving: backoff must carry the request through
const legacy429Fixture = {
  kind: "track",
  id: 615,
  title: "Legacy 429",
  duration: 20000,
  permalink_url: "https://soundcloud.com/test/legacy-429",
  user: { username: "l" },
  media: {
    transcodings: [
      { url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:615/stream/hls/missing615", format: { protocol: "hls", mime_type: "audio/mpegurl" }, quality: "sq" },
    ],
  },
};

// DRM-only profile AND the legacy stream permanently rate-limits (429): the
// failure is temporary throttling, not a property of the track - the error
// must say so (502 temporary), not blame DRM or the track.
const legacy429DrmFixture = {
  kind: "track",
  id: 630,
  title: "Legacy 429 DRM",
  duration: 20000,
  permalink_url: "https://soundcloud.com/test/legacy-429-drm",
  user: { username: "l" },
  media: {
    transcodings: [
      { url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:630/aaa/stream/cbc-encrypted-hls", format: { protocol: "cbc-encrypted-hls", mime_type: 'audio/mp4; codecs="mp4a.40.2"' }, quality: "sq" },
    ],
  },
};

// clear progressive AND DRM AND download -> progressive must win
const mixedFixture = {
  kind: "track",
  id: 604,
  title: "Mixed Track",
  duration: 20000,
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
  duration: 20000,
  permalink_url: "https://soundcloud.com/test/ogg-only",
  user: { username: "o" },
  media: {
    transcodings: [
      { url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:555/stream/hls/oggonly", format: { protocol: "hls", mime_type: "application/octet-stream" }, quality: "sq" },
    ],
  },
};

// SoundCloud-style HLS: no EXT-X-MAP, styp-prefixed fragment segments
const stypFixture = {
  kind: "track",
  id: 606,
  title: "Styp Track",
  duration: 350,
  permalink_url: "https://soundcloud.com/test/styp-track",
  user: { username: "s" },
  media: {
    transcodings: [
      { url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:606/stream/hls/styp", format: { protocol: "hls", mime_type: "audio/mpegurl" }, quality: "sq" },
    ],
  },
};

// api-v2 renditions are DRM-only, but the legacy stream endpoint still
// serves a plain mp3 (the honeypie case that downloader tools handle)
const legacyOnlyFixture = {
  kind: "track",
  id: 610,
  title: "Legacy Only",
  duration: 20000,
  permalink_url: "https://soundcloud.com/test/legacy-only",
  downloadable: false,
  user: { username: "l" },
  media: {
    transcodings: [
      { url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:610/stream/cbc-encrypted-hls", format: { protocol: "cbc-encrypted-hls", mime_type: 'audio/mp4; codecs="mp4a.40.2"' }, quality: "sq" },
    ],
  },
};

// legacy stream is flaky: first attempt fails, retry must recover
const legacyFlakyFixture = {
  kind: "track",
  id: 611,
  title: "Legacy Flaky",
  duration: 20000,
  permalink_url: "https://soundcloud.com/test/legacy-flaky",
  downloadable: false,
  user: { username: "l" },
  media: { transcodings: [] },
};

// media URL fails several times then recovers (anti-abuse roulette)
const mediaFlakyFixture = {
  kind: "track",
  id: 612,
  title: "Media Flaky",
  duration: 20000,
  permalink_url: "https://soundcloud.com/test/media-flaky",
  user: { username: "m" },
  media: {
    transcodings: [
      { url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:612/stream/progressive", format: { protocol: "progressive", mime_type: "audio/mpeg" }, quality: "sq" },
    ],
  },
};

// every source down: the error must say it is often transient
const allDownFixture = {
  kind: "track",
  id: 613,
  title: "All Down",
  duration: 20000,
  permalink_url: "https://soundcloud.com/test/all-down",
  downloadable: false,
  user: { username: "a" },
  media: {
    transcodings: [
      { url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:613/stream/progressive", format: { protocol: "progressive", mime_type: "audio/mpeg" }, quality: "sq" },
    ],
  },
};

// ---- real audio fixtures for conversion tests (decoded + re-encoded) ----

registerMp3Encoder();
registerAacEncoder();

function synthWav(sampleRate = 22050, freq = 440, secs = 0.35) {
  const n = Math.round(sampleRate * secs);
  const data = new Int16Array(n);
  for (let i = 0; i < n; i++) data[i] = Math.round(Math.sin(2 * Math.PI * freq * i / sampleRate) * 12000);
  const bytes = new Uint8Array(44 + data.byteLength);
  const dv = new DataView(bytes.buffer);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) bytes[o + i] = s.charCodeAt(i); };
  w(0, "RIFF"); dv.setUint32(4, 36 + data.byteLength, true); w(8, "WAVE");
  w(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  w(36, "data"); dv.setUint32(40, data.byteLength, true);
  bytes.set(new Uint8Array(data.buffer), 44);
  return bytes;
}

async function wavToBytes(wav, format, codec, bitrate) {
  const input = new Input({ source: new BufferSource(wav), formats: [new WaveInputFormat()] });
  const target = new BufferTarget();
  const output = new Output({ format, target });
  const conversion = await Conversion.init({ input, output, audio: { codec, bitrate, forceTranscode: true } });
  await conversion.execute();
  return new Uint8Array(target.buffer);
}

const realMp3 = await wavToBytes(synthWav(), new Mp3OutputFormat(), "mp3", 128_000);
const realM4a = await wavToBytes(synthWav(44100), new Mp4OutputFormat(), "aac", 96_000);
const realMp3Long24 = await wavToBytes(synthWav(22050, 440, 24), new Mp3OutputFormat(), "mp3", 128_000);
const realM4aLong24 = await wavToBytes(synthWav(44100, 440, 24), new Mp4OutputFormat(), "aac", 96_000);
const realOggWasm = readFileSync("node_modules/wasm-media-encoders/wasm/ogg.wasm");
const realMp3Wasm = readFileSync("node_modules/wasm-media-encoders/wasm/mp3.wasm");

// progressive renditions carrying the real bytes; format requests must
// convert rather than serve the wrong container
const convMp3Fixture = {
  kind: "track",
  id: 801,
  title: "Conv MP3",
  duration: 350,
  permalink_url: "https://soundcloud.com/test/conv-mp3",
  user: { username: "c" },
  media: {
    transcodings: [
      { url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:801/stream/progressive", format: { protocol: "progressive", mime_type: "audio/mpeg" }, quality: "sq" },
    ],
  },
};

const convAacFixture = {
  kind: "track",
  id: 802,
  title: "Conv AAC",
  duration: 350,
  permalink_url: "https://soundcloud.com/test/conv-aac",
  user: { username: "c" },
  media: {
    transcodings: [
      { url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:802/stream/progressive", format: { protocol: "progressive", mime_type: "audio/mp4" }, quality: "sq" },
    ],
  },
};

// long-track chunked conversion: metadata says 213 s, source is a short m4a
// clip (the chunk machinery is under test). No mp3 rendition -> format=mp3
// must take the conversion path (the Die Empty case).
const convLongFixture = {
  kind: "track",
  id: 805,
  title: "Conv Long",
  duration: 213456,
  permalink_url: "https://soundcloud.com/test/conv-long",
  user: { username: "c" },
  media: {
    transcodings: [
      { url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:805/stream/progressive", format: { protocol: "progressive", mime_type: "audio/mp4" }, quality: "sq" },
    ],
  },
};

// 24 s of real audio: chunk windows (10 s) must split + stitch it seamlessly
const convSpliceFixture = {
  kind: "track",
  id: 806,
  title: "Conv Splice",
  duration: 24000,
  permalink_url: "https://soundcloud.com/test/conv-splice",
  user: { username: "c" },
  media: {
    transcodings: [
      { url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:806/stream/progressive", format: { protocol: "progressive", mime_type: "audio/mp4" }, quality: "sq" },
    ],
  },
};

// 24 s mp3 source: exercises mp3-frame windowing (chunk -> opus)
const convMp3ChunkFixture = {
  kind: "track",
  id: 807,
  title: "Conv MP3 Chunk",
  duration: 24000,
  permalink_url: "https://soundcloud.com/test/conv-mp3chunk",
  user: { username: "c" },
  media: {
    transcodings: [
      { url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:807/stream/progressive", format: { protocol: "progressive", mime_type: "audio/mpeg" }, quality: "sq" },
    ],
  },
};

// HLS-only source (Die Empty shape): legacy 404s (mock default), the first hls
// candidate carries real fMP4 segments, the second is dead. Chunk windowing
// must demux the fMP4 segment to ADTS before converting - and must not mask
// its own failure behind the dead candidate's stream-URL error.
const convHlsChunkFixture = {
  kind: "track",
  id: 808,
  title: "Conv HLS Chunk",
  duration: 8000,
  permalink_url: "https://soundcloud.com/test/conv-hlschunk",
  user: { username: "c" },
  media: {
    transcodings: [
      { url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:808/stream/hls/chunky", format: { protocol: "hls", mime_type: 'audio/mp4; codecs="mp4a.40.2"' }, quality: "sq" },
      { url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:808/stream/hls/chunky404", format: { protocol: "hls", mime_type: 'audio/mp4; codecs="mp4a.40.2"' }, quality: "sq" },
      { url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:808/stream/hls/mpeg404", format: { protocol: "hls", mime_type: "audio/mpegurl" }, quality: "sq" },
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

// SoundCloud-style fMP4 HLS segments: styp box + moof/mdat fragments
function splitFmp4(bytes) {
  let p = 0;
  let firstMoof = -1;
  while (p + 8 <= bytes.length) {
    const size = new DataView(bytes.buffer, bytes.byteOffset + p, 8).getUint32(0);
    const type = String.fromCharCode(...bytes.slice(p + 4, p + 8));
    if (type === "moof" && firstMoof < 0) firstMoof = p;
    if (size < 8) break;
    p += size;
  }
  return { init: bytes.slice(0, firstMoof), frags: bytes.slice(firstMoof) };
}
const stypBox = new Uint8Array([0, 0, 0, 12, 0x73, 0x74, 0x79, 0x70, 0x6d, 0x73, 0x69, 0x78]); // 'styp msix'
const realFmp4Frag = await wavToBytes(synthWav(44100), new Mp4OutputFormat({ fastStart: "fragmented" }), "aac", 96_000);
const stypFmp4 = splitFmp4(realFmp4Frag);
if (stypFmp4.frags.length < 16) throw new Error("fragmented fMP4 has no moof/mdat; cannot build styp fixture");
const stypInit = new Uint8Array([...stypBox, ...stypFmp4.init]);
const stypSegment = new Uint8Array([...stypBox, ...stypFmp4.frags]);

const stypMediaPlaylist = [
  "#EXTM3U",
  '#EXT-X-MAP:URI="init.styp"',
  "#EXTINF:1.0,",
  "seg1.styp",
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

// ---- plain AES-128 HLS (encrypted-hls): key served to any client, so the
// pipeline must decrypt it like any HLS client (vs cbc-/ctr- DRM, refused).
const AES_KEY = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
const AES_IV = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
function aesEncrypt(bytes, key, iv) {
  const cipher = createCipheriv("aes-128-cbc", Buffer.from(key), Buffer.from(iv));
  return new Uint8Array(Buffer.concat([cipher.update(Buffer.from(bytes)), cipher.final()]));
}
const aesSegEnc = aesEncrypt(stypFmp4.frags, AES_KEY, AES_IV);
const aesSegEncSeq = aesEncrypt(stypFmp4.frags, AES_KEY, new Uint8Array(16)); // IV = media sequence 0

const aesMediaPlaylist = [
  "#EXTM3U",
  '#EXT-X-KEY:METHOD=AES-128,URI="https://cf-hls-media.sndcdn.com/aes/key.bin",IV=0x0102030405060708090a0b0c0d0e0f10',
  '#EXT-X-MAP:URI="init.mp4"',
  "#EXTINF:1.0,",
  "frag.enc",
  "#EXT-X-ENDLIST",
].join("\n");

const aesNoIvMediaPlaylist = [
  "#EXTM3U",
  "#EXT-X-MEDIA-SEQUENCE:0",
  '#EXT-X-KEY:METHOD=AES-128,URI="https://cf-hls-media.sndcdn.com/aes/key.bin"',
  '#EXT-X-MAP:URI="init.mp4"',
  "#EXTINF:1.0,",
  "frag2.enc",
  "#EXT-X-ENDLIST",
].join("\n");

const aesChunkFixture = {
  kind: "track",
  id: 830,
  title: "AES HLS",
  duration: 1000,
  permalink_url: "https://soundcloud.com/test/aes-hls",
  user: { username: "a" },
  media: {
    transcodings: [
      { url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:830/stream/encrypted-hls", format: { protocol: "encrypted-hls", mime_type: 'audio/mp4; codecs="mp4a.40.2"' }, quality: "sq" },
    ],
  },
};

const aesNoIvFixture = {
  kind: "track",
  id: 831,
  title: "AES HLS No IV",
  duration: 1000,
  permalink_url: "https://soundcloud.com/test/aes-noiv",
  user: { username: "a" },
  media: {
    transcodings: [
      { url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:831/stream/encrypted-hls", format: { protocol: "encrypted-hls", mime_type: 'audio/mp4; codecs="mp4a.40.2"' }, quality: "sq" },
    ],
  },
};

// progressive stream that rejects the first pooled client_id: the pool must
// rotate to the next id instead of failing (or re-scraping under pressure)
const poolFixture = {
  kind: "track",
  id: 833,
  title: "Pool Rotation",
  duration: 6000,
  permalink_url: "https://soundcloud.com/test/poolrot",
  user: { username: "p" },
  media: {
    transcodings: [
      { url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:833/stream/poolrot", format: { protocol: "progressive", mime_type: "audio/mpeg" }, quality: "sq" },
    ],
  },
};

// ---------- mock network ----------

const realFetch = globalThis.fetch;
let homeCalls = 0;
let flakyCalls = 0;
let blockedFlakyCalls = 0;
let legacyFlakyCalls = 0;
let mediaFlakyCalls = 0;
let drmFlakyCalls = 0;
let legacy429Calls = 0;
let blockMode = false;
let failCdn = false;
const cacheDb = new Map(); // emulates PostgREST over the ssda_cache table

const goodHome = `<html><script src="https://a-v2.sndcdn.com/assets/0-old.js"></script>
  <script crossorigin src="//a-v2.sndcdn.com/assets/99-app.js"></script></html>`;
const challengePage = "<html><title>Just a moment...</title>" + "x".repeat(800) + "</html>";

globalThis.fetch = async (input, init) => {
  const u = String(input instanceof Request ? input.url : input);
  const method = String((init && init.method) || (input instanceof Request ? input.method : "GET")).toUpperCase();
  const redirect = (init && init.redirect) || "follow";
  const R = (body, status = 200, headers = {}) => new Response(body, { status, headers });
  const J = (obj, status = 200) => R(JSON.stringify(obj), status, { "Content-Type": "application/json" });

  // npm CDN fallbacks for the codec wasm (serve the right file per name)
  if (u.includes("cdn.jsdelivr.net/npm/wasm-media-encoders") || u.includes("unpkg.com/wasm-media-encoders")) {
    if (failCdn) return R("not found", 404);
    const bytes = u.includes("mp3.wasm") ? realMp3Wasm : realOggWasm;
    return R(bytes, 200, { "Content-Type": "application/wasm" });
  }

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
  if (u.includes("a-v2.sndcdn.com/assets/0-old.js")) {
    return R(`var cfg2={client_id:"${CID2}"};`);
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
    if (target.includes("styp-track")) return J(stypFixture);
    if (target.includes("legacy-only")) return J(legacyOnlyFixture);
    if (target.includes("legacy-flaky")) return J(legacyFlakyFixture);
    if (target.includes("media-flaky")) return J(mediaFlakyFixture);
    if (target.includes("all-down")) return J(allDownFixture);
    if (target.includes("conv-mp3chunk")) return J(convMp3ChunkFixture);
    if (target.includes("conv-hlschunk")) return J(convHlsChunkFixture);
    if (target.includes("aes-hls")) return J(aesChunkFixture);
    if (target.includes("aes-noiv")) return J(aesNoIvFixture);
    if (target.includes("poolrot")) return J(poolFixture);
    if (target.includes("resolve-429")) return R("slow down", 429, { "Retry-After": "42" });
    if (target.includes("conv-mp3")) return J(convMp3Fixture);
    if (target.includes("conv-aac")) return J(convAacFixture);
    if (target.includes("conv-long")) return J(convLongFixture);
    if (target.includes("conv-splice")) return J(convSpliceFixture);
    if (target.includes("shortbad")) return J({ code: "not_a_track", message: "This url is not a track." });
    if (target.includes("junklink")) return J({});
    if (target.includes("download-track")) return J(downloadFixture);
    if (target.includes("drm-only")) return J(drmOnlyFixture);
    if (target.includes("drm-flaky")) {
      drmFlakyCalls++;
      return J(drmFlakyCalls === 1 ? drmFlakyFixture : drmFlakyFixtureClear);
    }
    if (target.includes("legacy-429-drm")) return J(legacy429DrmFixture);
    if (target.includes("legacy-429")) return J(legacy429Fixture);
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
  // legacy public stream endpoint (what downloader tools use for "blocked" tracks)
  if (u.startsWith("https://api.soundcloud.com/tracks/") && u.includes("/stream")) {
    const id = (u.split("/tracks/")[1] || "").split("/")[0];
    if (id === "610") return R(realMp3, 200, { "Content-Type": "audio/mpeg" });
    if (id === "611") {
      legacyFlakyCalls++;
      return legacyFlakyCalls === 1 ? R("oops", 503) : R(realMp3, 200, { "Content-Type": "audio/mpeg" });
    }
    if (id === "615") {
      legacy429Calls++;
      return legacy429Calls <= 2 ? R("slow down", 429) : R(realMp3, 200, { "Content-Type": "audio/mpeg" });
    }
    if (id === "630") return R("slow down", 429, { "Retry-After": "7" });
    return R("not found", 404);
  }
  // track endpoint used to fetch a fresh track_authorization
  if (u.startsWith("https://api-v2.soundcloud.com/tracks/") && u.includes("?client_id=") && !u.includes("/stream") && !u.includes("/download")) {
    return J({ id: 1, track_authorization: "TATOKEN" });
  }
  // media stream-URL endpoints
  if (u.includes("soundcloud:tracks:777")) {
    if (!u.includes("track_authorization=TOKEN123")) return J({ error: "not found" }, 404);
    return J({ url: "https://cf-media.sndcdn.com/auth.mp3" });
  }
  if (u.includes("/stream/cbc-encrypted-hls")) return J({ url: "https://cf-hls-media.sndcdn.com/drm/playlist.m3u8" });
  if (u.includes("soundcloud:tracks:830") && u.includes("/stream/encrypted-hls")) return J({ url: "https://cf-hls-media.sndcdn.com/aes/playlist.m3u8" });
  if (u.includes("soundcloud:tracks:831") && u.includes("/stream/encrypted-hls")) return J({ url: "https://cf-hls-media.sndcdn.com/aes/playlist2.m3u8" });
  if (u.includes("soundcloud:tracks:833") && u.includes("/stream/poolrot")) {
    return u.includes("client_id=" + CID2)
      ? J({ url: "https://cf-media.sndcdn.com/conv/real.mp3" })
      : J({ error: "nope" }, 401);
  }
  if (u.includes("/tracks/601/download")) return J({ url: "https://cf-media.sndcdn.com/x1.128.mp3" });
  if (u.includes("/tracks/603/download")) return J({ url: "https://cf-media.sndcdn.com/x3.wav" });
  if (u.includes("/tracks/604/download")) return J({ url: "https://cf-media.sndcdn.com/x4.128.mp3" });
  if (u.includes("soundcloud:tracks:801") && u.includes("/stream/progressive")) return J({ url: "https://cf-media.sndcdn.com/conv/real.mp3" });
  if (u.includes("soundcloud:tracks:802") && u.includes("/stream/progressive")) return J({ url: "https://cf-media.sndcdn.com/conv/real.m4a" });
  if (u.includes("soundcloud:tracks:805") && u.includes("/stream/progressive")) return J({ url: "https://cf-media.sndcdn.com/conv/real.m4a" });
  if (u.includes("soundcloud:tracks:806") && u.includes("/stream/progressive")) return J({ url: "https://cf-media.sndcdn.com/conv/real24.m4a" });
  if (u.includes("soundcloud:tracks:807") && u.includes("/stream/progressive")) return J({ url: "https://cf-media.sndcdn.com/conv/real24.mp3" });
  if (u.includes("soundcloud:tracks:444") && u.includes("/stream/progressive")) return J({ url: "https://cf-media.sndcdn.com/conv/real.mp3" });
  if (u.includes("soundcloud:tracks:612") && u.includes("/stream/progressive")) {
    mediaFlakyCalls++;
    return mediaFlakyCalls <= 4 ? J({ error: "not found" }, 404) : J({ url: "https://cf-media.sndcdn.com/conv/real.mp3" });
  }
  if (u.includes("soundcloud:tracks:613") && u.includes("/stream/progressive")) return J({ error: "not found" }, 404);
  if (u.includes("/stream/progressive")) return J({ url: "https://cf-media.sndcdn.com/tkHfEWxK.mp3" });
  if (u.includes("/stream/hls/chunky404") || u.includes("/stream/hls/mpeg404")) return R("gone", 404);
  if (u.includes("/stream/hls/chunky")) return J({ url: "https://cf-hls-media.sndcdn.com/chunky/media/playlist.m3u8" });
  if (u.includes("/stream/hls/badaac")) return J({ url: "https://cf-hls-media.sndcdn.com/bad/playlist.m3u8" });
  if (u.includes("/stream/hls/missing615")) return J({ error: "not found" }, 404);
  if (u.includes("/stream/hls/ts")) return J({ url: "https://cf-hls-media.sndcdn.com/ts/playlist.m3u8" });
  if (u.includes("/stream/hls/oggonly")) return J({ url: "https://cf-hls-media.sndcdn.com/opus/playlist.m3u8?token=abc" });
  if (u.includes("/stream/hls/styp")) return J({ url: "https://cf-hls-media.sndcdn.com/styp/playlist.m3u8" });
  if (u.includes("/stream/hls/aac")) return J({ url: "https://cf-hls-media.sndcdn.com/aac/master.m3u8?token=abc" });
  if (u.includes("/stream/hls")) return J({ url: "https://cf-hls-media.sndcdn.com/opus/playlist.m3u8?token=abc" });
  // audio bytes / playlists
  if (u === "https://cf-media.sndcdn.com/conv/real.mp3") {
    return R(realMp3, 200, { "Content-Type": "audio/mpeg" });
  }
  if (u === "https://cf-media.sndcdn.com/conv/real.m4a") {
    return R(realM4a, 200, { "Content-Type": "audio/mp4" });
  }
  if (u === "https://cf-media.sndcdn.com/conv/real24.mp3") {
    return R(realMp3Long24, 200, { "Content-Type": "audio/mpeg" });
  }
  if (u === "https://cf-media.sndcdn.com/conv/real24.m4a") {
    return R(realM4aLong24, 200, { "Content-Type": "audio/mp4" });
  }
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
  if (u.startsWith("https://cf-hls-media.sndcdn.com/aes/playlist2.m3u8")) return R(aesNoIvMediaPlaylist);
  if (u.startsWith("https://cf-hls-media.sndcdn.com/aes/playlist.m3u8")) return R(aesMediaPlaylist);
  if (u.startsWith("https://cf-hls-media.sndcdn.com/aes/key.bin")) return R(AES_KEY, 200, { "Content-Type": "application/octet-stream" });
  if (u.startsWith("https://cf-hls-media.sndcdn.com/aes/init.mp4")) return R(stypFmp4.init);
  if (u.startsWith("https://cf-hls-media.sndcdn.com/aes/frag2.enc")) return R(aesSegEncSeq);
  if (u.startsWith("https://cf-hls-media.sndcdn.com/aes/frag.enc")) return R(aesSegEnc);
  if (u === "https://cf-hls-media.sndcdn.com/styp/playlist.m3u8") return R(stypMediaPlaylist);
  if (u === "https://cf-hls-media.sndcdn.com/styp/init.styp") return R(stypInit, 200, { "Content-Type": "video/mp4" });
  if (u === "https://cf-hls-media.sndcdn.com/styp/seg1.styp") return R(stypSegment, 200, { "Content-Type": "video/mp4" });
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
  if (u === "https://cf-hls-media.sndcdn.com/chunky/media/playlist.m3u8") {
    return R([
      "#EXTM3U",
      "#EXT-X-VERSION:4",
      "#EXT-X-TARGETDURATION:4",
      '#EXT-X-MAP:URI="init.mp4"',
      "#EXTINF:4.000,",
      "frag1.m4s",
      "#EXTINF:4.000,",
      "frag2.m4s",
      "#EXT-X-ENDLIST",
    ].join("\n"));
  }
  if (u.startsWith("https://cf-hls-media.sndcdn.com/chunky/media/init.mp4")) return R(stypFmp4.init);
  if (u.startsWith("https://cf-hls-media.sndcdn.com/chunky/media/frag")) return R(stypFmp4.frags);
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
  // short2: HEAD gets no Location, GET does. short3: only a followed GET
  // reveals the target. shortbad: never redirects at all.
  if (u.startsWith("https://on.soundcloud.com/short2")) {
    if (method === "HEAD") return R(null, 200);
    return R(null, 302, { Location: "https://soundcloud.com/test/test-track" });
  }
  if (u.startsWith("https://on.soundcloud.com/short3")) {
    if (method === "GET" && redirect === "follow") {
      const r = R("<html>ok</html>", 200);
      Object.defineProperty(r, "url", { value: "https://soundcloud.com/test/test-track" });
      return r;
    }
    return R(null, 200);
  }
  if (u.startsWith("https://on.soundcloud.com/shortbad")) {
    return R(null, 200);
  }
  // emulated PostgREST over the ssda_cache table (server-side response cache)
  if (u.startsWith("https://supabase.test/rest/v1/ssda_cache")) {
    const parsed = new URL(u);
    if (method === "GET") {
      const raw = parsed.searchParams.get("cache_key") ?? "";
      const m = raw.match(/^in\.\((.*)\)$/);
      const keys = m
        ? m[1].split(",").map((s) => decodeURIComponent(s.replace(/^"|"$/g, "")))
        : raw ? [decodeURIComponent(raw.replace(/^eq\./, ""))] : [];
      return J(keys.filter((k) => cacheDb.has(k)).map((k) => ({ cache_key: k, data: cacheDb.get(k) })));
    }
    if (method === "POST") {
      for (const row of JSON.parse(String(init && init.body ? init.body : "[]"))) {
        cacheDb.set(row.cache_key, row.data);
      }
      return R("", 204);
    }
    if (method === "DELETE") {
      cacheDb.clear();
      return R("", 204);
    }
    return R("bad request", 400);
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
  ok(String(mp3.headers.get("Content-Disposition")).startsWith("inline;"), "format=mp3 on /api/audio is inline (only /api/download attaches)");

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

  // a later rendition in the exact requested format wins over an earlier
  // mismatched one
  const weirdOpus = await call("/api/audio?url=" + encodeURIComponent("https://soundcloud.com/test/weird") + "&format=opus");
  ok(weirdOpus.status === 200 && weirdOpus.headers.get("X-SSDA-Extension") === "opus",
    "explicit format prefers an exact match over an earlier fallback candidate", String(weirdOpus.headers.get("X-SSDA-Extension")));

  // when the source cannot be converted: clear error, never the wrong ext
  const oggToM4a = await call("/api/audio?url=" + encodeURIComponent("https://soundcloud.com/test/ogg-only") + "&format=m4a");
  const oggToM4aErr = (await oggToM4a.json()).error;
  ok(oggToM4a.status === 415 && oggToM4aErr.code === "conversion_failed",
    "explicit format errors when the source cannot be converted (never the wrong ext)", JSON.stringify(oggToM4aErr));

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
  ok(skip.status === 200 && skip.headers.get("X-SSDA-Extension") === "m4a",
    "broken rendition skipped, next candidate converted to the requested format", String(skip.status) + " " + skip.headers.get("X-SSDA-Extension"));
  ok(String(skip.headers.get("X-SSDA-Format-Note")) === "converted from mp3 to m4a", "conversion note present", String(skip.headers.get("X-SSDA-Format-Note")));
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

// 8b. rendition-profile roulette + legacy rate-limit backoff
{
  console.log("profile roulette + 429 backoff:");
  drmFlakyCalls = 0;
  const roulette = await call("/api/audio?url=" + encodeURIComponent("https://soundcloud.com/test/drm-flaky"));
  ok(roulette.status === 200 && roulette.headers.get("X-SSDA-Extension") === "mp3",
    "DRM-only profile on resolve is retried until a playable profile appears", String(roulette.status) + " " + roulette.headers.get("X-SSDA-Extension"));
  ok(drmFlakyCalls >= 2, "resolve was retried past the DRM-only profile", "calls=" + drmFlakyCalls);

  legacy429Calls = 0;
  const throttled = await call("/api/audio?url=" + encodeURIComponent("https://soundcloud.com/test/legacy-429"));
  ok(throttled.status === 200 && throttled.headers.get("X-SSDA-Extension") === "mp3",
    "legacy stream 429s are backed off and retried", String(throttled.status) + " " + throttled.headers.get("X-SSDA-Extension"));
  ok(legacy429Calls === 3, "legacy stream served on the third try after two 429s", "calls=" + legacy429Calls);
}

// 8c. throttled legacy + DRM-only profile -> honest temporary 502
{
  console.log("throttled legacy + DRM-only profile:");
  const res = await call("/api/audio?url=" + encodeURIComponent("https://soundcloud.com/test/legacy-429-drm"));
  const body = await res.json();
  ok(res.status === 502 && body.error.code === "upstream",
    "legacy 429 + DRM-only profile answers 502 upstream", String(res.status) + " " + JSON.stringify(body.error));
  ok(/temporary/i.test(body.error.message) && /429/.test(body.error.message),
    "the message names the rate limit and says it is temporary", body.error.message);
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

// 9d. broken ogg.wasm must not poison other conversions (edge-runtime bug)
{
  console.log("codec resilience:");
  const marker = join(tmpdir(), "ssda-fail-ogg-wasm");
  writeFileSync(marker, "1");
  try {
    // wasm import broken AND the CDN fallbacks are down -> clean error,
    // never an internal file path
    failCdn = true;
    const opusFail = await call("/api/audio?url=" + encodeURIComponent("https://soundcloud.com/test/conv-aac") + "&format=opus");
    const opusFailBody = (await opusFail.json()).error;
    ok(opusFail.status === 503 && opusFailBody.code === "codec_unavailable" && !/file:\/\//.test(opusFailBody.message),
      "opus encoder failure is a clean error", JSON.stringify(opusFailBody));

    // CDN fallback serves the real wasm -> opus conversion works anyway
    failCdn = false;
    const opusOk = await call("/api/audio?url=" + encodeURIComponent("https://soundcloud.com/test/conv-aac") + "&format=opus&x=cdn");
    ok(opusOk.status === 200 && opusOk.headers.get("X-SSDA-Extension") === "opus",
      "opus conversion recovers via CDN wasm fallback", String(opusOk.status) + " " + opusOk.headers.get("X-SSDA-Extension"));

    // mp3 conversion works even while ogg.wasm is broken (the Die Empty bug)
    const mp3Ok = await call("/api/audio?url=" + encodeURIComponent("https://soundcloud.com/test/conv-aac") + "&format=mp3");
    ok(mp3Ok.status === 200 && mp3Ok.headers.get("X-SSDA-Extension") === "mp3",
      "mp3 conversion unaffected by broken ogg.wasm", String(mp3Ok.status));
  } finally {
    rmSync(marker, { force: true });
    failCdn = false;
  }
}

// 10. format conversion: decode + re-encode when no matching rendition exists
{
  console.log("conversion:");
  const toMp3 = await call("/api/audio?url=" + encodeURIComponent("https://soundcloud.com/test/conv-aac") + "&format=mp3");
  const toMp3Bytes = new Uint8Array(await toMp3.arrayBuffer());
  ok(toMp3.status === 200 && toMp3.headers.get("X-SSDA-Extension") === "mp3" && toMp3.headers.get("Content-Type") === "audio/mpeg",
    "format=mp3 converts aac -> mp3", String(toMp3.status) + " " + toMp3.headers.get("X-SSDA-Extension"));
  ok(toMp3Bytes.length > 200 && (toMp3Bytes[0] === 0x49 || toMp3Bytes[0] === 0xff),
    "converted mp3 has real frames", "len=" + toMp3Bytes.length + " head=" + toMp3Bytes[0]);
  ok(String(toMp3.headers.get("X-SSDA-Format-Note")) === "converted from m4a to mp3",
    "conversion note set", String(toMp3.headers.get("X-SSDA-Format-Note")));

  const toOpus = await call("/api/audio?url=" + encodeURIComponent("https://soundcloud.com/test/conv-aac") + "&format=opus");
  const toOpusBytes = new Uint8Array(await toOpus.arrayBuffer());
  ok(toOpus.status === 200 && toOpus.headers.get("X-SSDA-Extension") === "opus",
    "format=opus converts aac -> opus", String(toOpus.status));
  ok(toOpusBytes.length > 100 && toOpusBytes[0] === 0x4f && toOpusBytes[1] === 0x67,
    "converted opus is an Ogg stream", "len=" + toOpusBytes.length);

  const toM4a = await call("/api/audio?url=" + encodeURIComponent("https://soundcloud.com/test/conv-mp3") + "&format=m4a");
  const toM4aBytes = new Uint8Array(await toM4a.arrayBuffer());
  ok(toM4a.status === 200 && toM4a.headers.get("X-SSDA-Extension") === "m4a",
    "format=m4a converts mp3 -> m4a", String(toM4a.status));
  ok(toM4aBytes.length > 200 && toM4aBytes[4] === 0x66 && toM4aBytes[5] === 0x74,
    "converted m4a is an fMP4 file", "len=" + toM4aBytes.length);

  // exact match stays a byte-identical passthrough ("quality is the same")
  const passthru = await call("/api/audio?url=" + encodeURIComponent("https://soundcloud.com/test/conv-mp3") + "&format=mp3");
  const passthruBytes = new Uint8Array(await passthru.arrayBuffer());
  ok(passthruBytes.length === realMp3.length && passthruBytes.every((b, i) => b === realMp3[i]),
    "mp3 -> mp3 passes the original bytes through untouched");
  ok(passthru.headers.get("X-SSDA-Format-Note") === null, "passthrough carries no conversion note");

  const drm3 = await call("/api/audio?url=" + encodeURIComponent("https://soundcloud.com/test/drm-only") + "&format=mp3");
  const drm3Err = (await drm3.json()).error;
  ok(drm3.status === 415 && drm3Err.code === "drm_protected" && /DRM/i.test(drm3Err.message),
    "DRM-only + explicit format keeps the clear drm error", JSON.stringify(drm3Err));
}

// 10b. SoundCloud-style styp HLS, legacy fallback, and format fidelity
{
  console.log("styp + legacy + format fidelity:");
  // styp-headed HLS (no EXT-X-MAP) must be recognized as fMP4 and converted
  const styp = await call("/api/audio?url=" + encodeURIComponent("https://soundcloud.com/test/styp-track") + "&format=mp3");
  const stypBytes = new Uint8Array(await styp.arrayBuffer());
  ok(styp.status === 200 && styp.headers.get("X-SSDA-Extension") === "mp3",
    "styp HLS converts to the requested mp3", String(styp.status) + " " + styp.headers.get("X-SSDA-Extension"));
  ok(stypBytes.length > 200 && (stypBytes[0] === 0x49 || stypBytes[0] === 0xff),
    "converted mp3 from styp HLS has real frames", "len=" + stypBytes.length + " body=" + new TextDecoder().decode(stypBytes));
  ok(String(styp.headers.get("X-SSDA-Format-Note")) === "converted from m4a to mp3",
    "styp conversion note set", String(styp.headers.get("X-SSDA-Format-Note")));

  // DRM-only api-v2 renditions, but the legacy stream has a plain mp3:
  // this is the honeypie case that other downloader tools serve
  const leg = await call("/api/audio?url=" + encodeURIComponent("https://soundcloud.com/test/legacy-only") + "&format=mp3");
  const legBytes = new Uint8Array(await leg.arrayBuffer());
  ok(leg.status === 200 && leg.headers.get("X-SSDA-Extension") === "mp3" && legBytes.length === realMp3.length,
    "legacy stream serves mp3 when api-v2 is DRM-only", String(leg.status) + " " + leg.headers.get("X-SSDA-Extension"));
  const legAuto = await call("/api/audio?url=" + encodeURIComponent("https://soundcloud.com/test/legacy-only"));
  ok(legAuto.status === 200 && legAuto.headers.get("X-SSDA-Extension") === "mp3", "legacy stream also serves auto format");

  // unconvertible source + explicit format -> clear error, never the wrong ext
  const badConv = await call("/api/audio?url=" + encodeURIComponent("https://soundcloud.com/test/ogg-only") + "&format=mp3");
  const badConvErr = (await badConv.json()).error;
  ok(badConv.status === 415 && badConvErr.code === "conversion_failed",
    "unconvertible source with explicit format errors instead of wrong ext", JSON.stringify(badConvErr));

  // info exposes the policy so clients can warn about preview-only tracks
  const meta = await call("/api/info?url=" + encodeURIComponent("https://soundcloud.com/test/test-track"));
  const metaBody = await meta.json();
  ok("policy" in metaBody && metaBody.snip === false,
    "info exposes policy/snip fields", JSON.stringify({ policy: metaBody.policy, snip: metaBody.snip }));
}

// 10c. transient anti-abuse failures must not dead-end a request
{
  console.log("transient retries:");
  // legacy stream 503s once, the in-render retry recovers
  const lf = await call("/api/audio?url=" + encodeURIComponent("https://soundcloud.com/test/legacy-flaky"));
  const lfBytes = new Uint8Array(await lf.arrayBuffer());
  ok(lf.status === 200 && lf.headers.get("X-SSDA-Extension") === "mp3" && lfBytes.length === realMp3.length,
    "legacy stream retry recovers from a transient 503", String(lf.status) + " " + lf.headers.get("X-SSDA-Extension"));

  // media URL 404s repeatedly, the full-pass retry recovers
  const mf = await call("/api/audio?url=" + encodeURIComponent("https://soundcloud.com/test/media-flaky"));
  ok(mf.status === 200 && mf.headers.get("X-SSDA-Extension") === "mp3",
    "full-pass retry recovers after repeated media 404s", String(mf.status) + " " + mf.headers.get("X-SSDA-Extension"));

  // everything down for real: clear error that says it is often transient
  const ad = await call("/api/audio?url=" + encodeURIComponent("https://soundcloud.com/test/all-down"));
  const adErr = (await ad.json()).error;
  ok(ad.status === 502 && adErr.code === "upstream" && /transient/i.test(adErr.message),
    "all-sources-down error says it is often transient", JSON.stringify(adErr));
}

// 10c. edge-runtime regression: the runtime stubs out Worker ("Not implemented:
// Worker.prototype.constructor"); conversions must not need one
{
  console.log("no-Worker conversion (edge runtime):");
  const realWorker = globalThis.Worker;
  globalThis.Worker = class {
    constructor() {
      throw new Error("Not implemented: Worker.prototype.constructor");
    }
  };
  try {
    const noWorker = await call("/api/audio?url=" + encodeURIComponent("https://soundcloud.com/test/conv-aac") + "&format=mp3&x=worker");
    ok(noWorker.status === 200 && noWorker.headers.get("X-SSDA-Extension") === "mp3",
      "m4a -> mp3 conversion works with Worker stubbed out", String(noWorker.status) + " " + noWorker.headers.get("X-SSDA-Extension"));
  } finally {
    globalThis.Worker = realWorker;
  }
}

// 11. short-link expansion and resolve-body handling
{
  console.log("short links:");
  const s2 = await call("/api/info?url=" + encodeURIComponent("https://on.soundcloud.com/short2"));
  const s2b = await s2.json();
  ok(s2.status === 200 && s2b.title === "Test Track",
    "short link expands via GET when HEAD has no Location", JSON.stringify(s2b));

  const s3 = await call("/api/info?url=" + encodeURIComponent("https://on.soundcloud.com/short3"));
  const s3b = await s3.json();
  ok(s3.status === 200 && s3b.title === "Test Track",
    "short link expands via followed GET when manual hops give no Location", JSON.stringify(s3b));

  const s4 = await call("/api/info?url=" + encodeURIComponent("https://on.soundcloud.com/shortbad"));
  const s4b = await s4.json();
  ok(s4.status === 400 && s4b.error && s4b.error.code === "not_a_track",
    "unexpandable short link + SoundCloud not_a_track body -> clear 400", JSON.stringify(s4b));

  const j = await call("/api/info?url=" + encodeURIComponent("https://soundcloud.com/test/junklink"));
  const jb = await j.json();
  ok(j.status === 502 && jb.error && /did not return a track/.test(jb.error.message),
    "junk resolve body -> clear upstream error", JSON.stringify(jb));
}

// 10. chunked conversion (long tracks exceed the per-request compute budget)
{
  console.log("chunked conversion:");
  const U = encodeURIComponent("https://soundcloud.com/test/conv-long");

  const info = await call("/api/audio?url=" + U + "&format=mp3&chunk=info");
  const infoB = await info.json();
  ok(info.status === 200 && infoB.chunk_count === 22 && infoB.chunk_seconds === 10,
    "chunk=info reports count + window", JSON.stringify(infoB));

  const c0 = await call("/api/audio?url=" + U + "&format=mp3&chunk=0");
  const c0b = new Uint8Array(await c0.arrayBuffer());
  ok(c0.status === 200 && c0.headers.get("X-SSDA-Extension") === "mp3", "chunk=0 returns converted mp3",
    "status=" + c0.status + " body=" + new TextDecoder().decode(c0b.slice(0, 150)));
  ok(c0.headers.get("X-SSDA-Chunk-Index") === "0" && c0.headers.get("X-SSDA-Chunk-Count") === "22",
    "chunk index/count headers present");
  ok(c0b.length > 4 && (c0b[0] === 0xff || (c0b[0] === 0x49 && c0b[1] === 0x44 && c0b[2] === 0x33)),
    "chunk bytes start with an mp3 frame or ID3", String(c0b.length));

  const cLast = await call("/api/audio?url=" + U + "&format=mp3&chunk=21");
  ok(cLast.status === 200, "tail chunk past the audio returns 200 (empty is fine to append)",
    "status=" + cLast.status + " body=" + new TextDecoder().decode(new Uint8Array(await (await call("/api/audio?url=" + U + "&format=mp3&chunk=21")).arrayBuffer()).slice(0, 150)));

  const cBad = await call("/api/audio?url=" + U + "&format=mp3&chunk=22");
  const cBadB = await cBad.json();
  ok(cBad.status === 404 && cBadB.error && cBadB.error.code === "invalid_chunk",
    "out-of-range chunk -> 404 invalid_chunk", JSON.stringify(cBadB));

  const one = await call("/api/audio?url=" + U + "&format=mp3");
  const oneB = await one.json();
  ok(one.status === 413 && oneB.error && oneB.error.code === "chunked_conversion_required" && oneB.error.message.includes("chunk=info"),
    "long single-shot conversion -> 413 with the chunk recipe", JSON.stringify(oneB));
  ok(!/file:\/\/|\/var\/tmp/.test(oneB.error.message), "413 message leaks no internal paths", oneB.error.message);

  const auto = await call("/api/audio?url=" + U + "&format=auto");
  ok(auto.status === 200 && auto.headers.get("X-SSDA-Extension") === "m4a",
    "long track passthrough (auto) unaffected by chunking");

  const m4a = await call("/api/audio?url=" + U + "&format=m4a&chunk=0");
  const m4aB = await m4a.json();
  ok(m4a.status === 400 && m4aB.error && m4aB.error.code === "chunking_not_supported_for_format",
    "m4a chunking refused honestly (cannot be assembled from chunks)", JSON.stringify(m4aB));

  // splice: 24 s of real audio across 3 windows == the single-shot decode
  const S = encodeURIComponent("https://soundcloud.com/test/conv-splice");
  const sInfo = await (await call("/api/audio?url=" + S + "&format=mp3&chunk=info")).json();
  ok(sInfo.chunk_count === 3, "splice fixture plans 3 chunks", JSON.stringify(sInfo));

  const cat = (arrs) => {
    let n = 0;
    for (const a of arrs) n += a.length;
    const out = new Uint8Array(n);
    let off = 0;
    for (const a of arrs) { out.set(a, off); off += a.length; }
    return out;
  };
  const parts = [];
  let allOk = true;
  for (let i = 0; i < 3; i++) {
    const r = await call("/api/audio?url=" + S + "&format=mp3&chunk=" + i);
    parts.push(new Uint8Array(await r.arrayBuffer()));
    if (r.status !== 200) allOk = false;
  }
  ok(allOk, "all splice chunks return 200");

  const whole = await call("/api/audio?url=" + S + "&format=mp3");
  const wholeB = new Uint8Array(await whole.arrayBuffer());
  ok(whole.status === 200, "splice fixture single-shot convert ok (24 s < limit)");

  const decodeMp3 = (await import("npm:@audio/decode-mp3@1.3.1")).default;
  const stitchedPcm = await decodeMp3(cat(parts));
  const wholePcm = await decodeMp3(wholeB);
  ok(Math.abs(stitchedPcm.channelData[0].length - wholePcm.channelData[0].length) <= 5 * 1152,
    "stitched chunks decode to (within encoder padding of) the single-shot length",
    stitchedPcm.channelData[0].length + " vs " + wholePcm.channelData[0].length);
  ok(stitchedPcm.channelData[0].length >= 22050 * 23,
    "stitched audio covers the full 24 s", String(stitchedPcm.channelData[0].length));

  // mp3-source windowing: chunks of a 24 s mp3 converted to opus
  const P = encodeURIComponent("https://soundcloud.com/test/conv-mp3chunk");
  const pInfo = await (await call("/api/audio?url=" + P + "&format=opus&chunk=info")).json();
  ok(pInfo.chunk_count === 3, "mp3-source fixture plans 3 chunks", JSON.stringify(pInfo));
  const o0 = await call("/api/audio?url=" + P + "&format=opus&chunk=0");
  const o0b = new Uint8Array(await o0.arrayBuffer());
  ok(o0.status === 200 && o0.headers.get("X-SSDA-Extension") === "opus" && o0b[0] === 0x4f,
    "mp3-source chunk converts to opus (OggS)", String(o0.status));
  const o2 = await call("/api/audio?url=" + P + "&format=opus&chunk=2");
  ok(o2.status === 200, "mp3-source last chunk ok", String(o2.status));
}

// 12. HLS-branch chunk conversion (real fMP4 segments must be demuxed first)
{
  console.log("hls chunk conversion:");
  const H = encodeURIComponent("https://soundcloud.com/test/conv-hlschunk");
  const hInfo = await (await call("/api/audio?url=" + H + "&format=mp3&chunk=info")).json();
  ok(hInfo.chunk_count === 2 && hInfo.chunk_seconds === 0,
    "hls chunk=info counts segments", JSON.stringify(hInfo));

  const h0 = await call("/api/audio?url=" + H + "&format=mp3&chunk=0");
  const h0b = new Uint8Array(await h0.arrayBuffer());
  ok(h0.status === 200 && h0b[0] === 0xff && h0.headers.get("X-SSDA-Extension") === "mp3",
    "hls fMP4 segment converts to mp3 (demuxed before encode)", String(h0.status) + " head=" + h0b[0] + " extHdr=" + h0.headers.get("X-SSDA-Extension") + " type=" + h0.headers.get("Content-Type"));
  ok(h0.headers.get("X-SSDA-Chunk-Index") === "0" && h0.headers.get("X-SSDA-Chunk-Count") === "2",
    "hls chunk headers", h0.headers.get("X-SSDA-Chunk-Index") + "/" + h0.headers.get("X-SSDA-Chunk-Count"));

  const h1 = await call("/api/audio?url=" + H + "&format=mp3&chunk=1");
  const h1b = new Uint8Array(await h1.arrayBuffer());
  ok(h1.status === 200 && h1b[0] === 0xff, "hls second chunk ok", String(h1.status));

  const h9 = await call("/api/audio?url=" + H + "&format=mp3&chunk=2");
  ok(h9.status === 404, "hls chunk past the end -> 404", String(h9.status));
}

// 13. plain AES-128 HLS (encrypted-hls): the key URI is served to every client
// that can read the playlist (hls.js and ffmpeg decrypt it transparently), so
// the pipeline decrypts it too - unlike cbc-/ctr-encrypted-hls (Widevine/
// FairPlay) which stay refused with an honest error.
{
  console.log("encrypted-hls (plain AES-128):");
  const A = encodeURIComponent("https://soundcloud.com/test/aes-hls");
  const info = await (await call("/api/audio?url=" + A + "&format=mp3&chunk=info")).json();
  ok(info.chunk_count === 1, "aes-hls chunk plan", JSON.stringify(info));

  const chunk = await call("/api/audio?url=" + A + "&format=mp3&chunk=0");
  const cb = new Uint8Array(await chunk.arrayBuffer());
  ok(chunk.status === 200 && chunk.headers.get("X-SSDA-Extension") === "mp3",
    "aes-hls chunk decrypts + converts", String(chunk.status));
  ok(cb.length > 1000 && cb[0] === 0xff, "aes-hls chunk is real mp3", "len=" + cb.length);

  const chunk2 = await call("/api/audio?url=" + encodeURIComponent("https://soundcloud.com/test/aes-noiv") + "&format=mp3&chunk=0");
  const cb2 = new Uint8Array(await chunk2.arrayBuffer());
  ok(chunk2.status === 200 && cb2.length > 1000 && cb2[0] === 0xff,
    "aes-hls without IV attribute (media-sequence IV) converts", String(chunk2.status) + " len=" + cb2.length);

  const whole = await call("/api/audio?url=" + A + "&format=mp3");
  const wb = new Uint8Array(await whole.arrayBuffer());
  ok(whole.status === 200 && wb.length > 1000 && wb[0] === 0xff,
    "aes-hls whole-track path decrypts too", String(whole.status) + " len=" + wb.length);

  const drm = await call("/api/audio?url=" + encodeURIComponent("https://soundcloud.com/test/drm-only") + "&format=mp3&chunk=0");
  const drmBody = await drm.json();
  ok(drm.status === 415 && drmBody.error.code === "drm_protected" && /Widevine|FairPlay|DRM-encrypted/.test(drmBody.error.message),
    "cbc/ctr DRM still refused, chunked path included", JSON.stringify(drmBody));
}

// 14. Retry-After is honored and echoed to clients
{
  console.log("retry-after:");
  const r = await call("/api/audio?url=" + encodeURIComponent("https://soundcloud.com/test/resolve-429"));
  const rb = await r.json();
  ok(r.status === 429 && rb.error.code === "rate_limited" && rb.error.retry_after_seconds === 42 && r.headers.get("Retry-After") === "42",
    "resolve 429 echoes Retry-After", JSON.stringify(rb.error) + " hdr=" + r.headers.get("Retry-After"));

  const l = await call("/api/audio?url=" + encodeURIComponent("https://soundcloud.com/test/legacy-429-drm"));
  const lb = await l.json();
  ok(l.status === 502 && /rate-limiting/.test(lb.error.message) && lb.error.retry_after_seconds === 90 && l.headers.get("Retry-After") === "90",
    "legacy 429 failure carries Retry-After", JSON.stringify(lb.error) + " hdr=" + l.headers.get("Retry-After"));
}

// 15. client_id pool: a poisoned id rotates to the next pooled id
{
  console.log("client_id pool:");
  const rot = await call("/api/audio?url=" + encodeURIComponent("https://soundcloud.com/test/poolrot"));
  const rb = new Uint8Array(await rot.arrayBuffer());
  ok(rot.status === 200 && rb.length > 5, "stream recovered via the next pooled client_id", String(rot.status) + " len=" + rb.length);
}

// 16. server-side cache + chunk=all assembly (opt-in via SUPABASE_URL env)
{
  console.log("server cache + chunk=all:");
  process.env.SUPABASE_URL = "https://supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc-test";
  const H = encodeURIComponent("https://soundcloud.com/test/conv-hlschunk");

  const c0 = await call("/api/audio?url=" + H + "&format=mp3&chunk=0");
  const c0b = new Uint8Array(await c0.arrayBuffer());
  ok(c0.status === 200 && c0.headers.get("X-SSDA-Cache") === "miss", "first chunk is a cache miss", String(c0.headers.get("X-SSDA-Cache")));

  const c0again = await call("/api/audio?url=" + H + "&format=mp3&chunk=0");
  const c0againB = new Uint8Array(await c0again.arrayBuffer());
  ok(c0again.headers.get("X-SSDA-Cache") === "hit" && c0againB.length === c0b.length,
    "repeat chunk served from the server cache", String(c0again.headers.get("X-SSDA-Cache")));
  ok(cacheDb.size >= 2, "cache rows were stored", "rows=" + cacheDb.size);

  const info = await call("/api/audio?url=" + H + "&format=mp3&chunk=info");
  const infoB = await info.json();
  ok(info.headers.get("X-SSDA-Cache") === "hit" && infoB.chunk_count === 2 && infoB.chunk_seconds === 0,
    "chunk plan served from cache meta (hls keeps chunk_seconds=0)", JSON.stringify(infoB));

  const all1 = await call("/api/audio?url=" + H + "&format=mp3&chunk=all");
  const all1b = await all1.json();
  ok(all1.status === 409 && all1b.error.code === "chunks_not_cached" && Array.isArray(all1b.error.missing) && all1b.error.missing.includes(1),
    "chunk=all before fill lists the missing chunks", JSON.stringify(all1b.error));

  const c1 = await call("/api/audio?url=" + H + "&format=mp3&chunk=1");
  const c1b = new Uint8Array(await c1.arrayBuffer());
  ok(c1.status === 200 && c1.headers.get("X-SSDA-Cache") === "miss", "chunk 1 converted and stored", String(c1.status));

  const all2 = await call("/api/audio?url=" + H + "&format=mp3&chunk=all");
  const all2b = new Uint8Array(await all2.arrayBuffer());
  ok(all2.status === 200 && all2.headers.get("X-SSDA-Cache") === "hit",
    "chunk=all assembles from cache once every chunk exists", String(all2.status));
  ok(all2b.length === c0b.length + c1b.length,
    "assembled length = sum of chunks", all2b.length + " vs " + (c0b.length + c1b.length));
  ok(all2b.slice(0, c0b.length).every((v, i) => v === c0b[i]) && all2b.slice(c0b.length).every((v, i) => v === c1b[i]),
    "assembled bytes = chunks in order");

  const full = await call("/api/audio?url=" + encodeURIComponent("https://soundcloud.com/test/conv-mp3") + "&format=mp3");
  const fb = new Uint8Array(await full.arrayBuffer());
  ok(full.status === 200 && full.headers.get("X-SSDA-Cache") === "miss", "whole file: first request misses");
  const full2 = await call("/api/audio?url=" + encodeURIComponent("https://soundcloud.com/test/conv-mp3") + "&format=mp3");
  const fb2 = new Uint8Array(await full2.arrayBuffer());
  ok(full2.headers.get("X-SSDA-Cache") === "hit" && fb2.length === fb.length,
    "whole file served from the server cache", String(full2.headers.get("X-SSDA-Cache")));

  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
