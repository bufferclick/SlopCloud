// tests/sca: SCA SoundCloud downloader API + api-anything recipe replay runner
// Run: npm install (once), then node tools/test-sca.mjs
// All upstream traffic is mocked - no network, no real SoundCloud calls.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");
const fnUrl = new URL(`file://${path.join(REPO, "supabase/functions/sca/index.ts")}`);
const { handleRequest, runOp } = await import(fnUrl.href);

const pending = [];
const test = (name, fn) => pending.push([name, fn]);
const eq = (a, b) => {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja !== jb) throw new Error(`${ja} !== ${jb}`);
};
const ok = (cond, msg = "expected true") => {
  if (!cond) throw new Error(msg);
};
let passCount = 0;
let failCount = 0;

// ------------------------------------------------------------------ mocks

const calls = { scrapePage: 0, scrapeAsset: 0, resolve: 0, streamMeta: 0, media: 0, ssda: 0, ssdaChunk: 0 };
const REAL_FETCH = globalThis.fetch;

const FAKE_MP3 = new Uint8Array([0xff, 0xfb, 0x90, 0x44, 0x00, 0x02, 0x44, 0x00, 0x01, 0x02, 0x03]);
const SSDBYTES = new Uint8Array([0xff, 0xfb, 0x90, 0x44, 0xaa, 0xbb, 0xcc, 0xdd, 0x11, 0x22, 0x33, 0x44]);
// Real wire shape (2026-11 live): format.mime_type (snake_case), presets like
// aac_160k, protocols progressive | hls | cbc-encrypted-hls | ctr-encrypted-hls.
const TRACK = {
  id: 340501365,
  title: "Harvey",
  user: { username: "alexg232" },
  duration: 152000,
  artwork_url: "https://i1.sndcdn.com/artworks-abc-t500x500.jpg",
  permalink_url: "https://soundcloud.com/alexg232/harvey",
  genre: "Alternative Rock",
  policy: "MONETIZE",
  track_authorization: "eyJhbGciOiJIUzI1NIn0.test",
  media: {
    transcodings: [
      {
        url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:340501365/1a2b3c4d-5e6f-4a8b-9c0d-1234567890ab/stream/https",
        preset: "mp3_0_1",
        duration: 152000,
        format: { protocol: "progressive", mime_type: "audio/mpeg" },
      },
      {
        url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:340501365/9f8e7d6c-5b4a-3c2d-1e0f-0987654321ab/stream/hls",
        preset: "aac_160k",
        duration: 152000,
        format: { protocol: "hls", mime_type: "audio/mp4; codecs=\"mp4a.40.2\"" },
      },
    ],
  },
};

function makeTrack(overrides) {
  return {
    ...structuredClone(TRACK),
    ...(overrides ?? {}),
    media: { transcodings: (overrides?.transcodings) ?? structuredClone(TRACK.media.transcodings) },
  };
}

let resolveRejectOnce = false;

globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  const u = new URL(url);

  // client_id scrape entry page
  if (u.host === "soundcloud.com") {
    calls.scrapePage++;
    return new Response(
      `<html><head><script src="https://a-v2.sndcdn.com/assets/app-abc123.js"></script></head><body></body></html>`,
      { status: 200, headers: { "content-type": "text/html" } },
    );
  }
  // client_id scrape asset bundles (two ids -> a rotatable pool)
  if (u.host === "a-v2.sndcdn.com") {
    calls.scrapeAsset++;
    return new Response(
      `var config={client_id:"CID_TEST_0001abcdefabcdef",other:1};var alt={"client_id":"CID_TEST_0002abcdefabcdef"};`,
      { status: 200, headers: { "content-type": "application/javascript" } },
    );
  }

  // api-v2
  if (u.host === "api-v2.soundcloud.com") {
    const cid = u.searchParams.get("client_id") || "";
    if (!cid.startsWith("CID_TEST")) {
      return new Response(JSON.stringify({ errors: [{ error_message: "unknown client id" }] }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
    if (u.pathname === "/search/tracks") {
      const q = u.searchParams.get("q") || "";
      return new Response(
        JSON.stringify({
          collection: [
            {
              id: 1, title: `Result for ${q}`, user: { username: "artist1" }, duration: 1000,
              permalink_url: "https://soundcloud.com/artist1/track1", artwork_url: null, genre: "Pop",
            },
            { id: 2, title: "No user object edge", duration: 500 }, // should be dropped-less: id+title survive
          ],
          next_href: null,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (u.pathname === "/resolve") {
      calls.resolve++;
      const target = u.searchParams.get("url") || "";
      if (resolveRejectOnce) {
        resolveRejectOnce = false;
        return new Response("nope", { status: 401 });
      }
      if (target.includes("missing")) return new Response("not found", { status: 404 });
      if (target.includes("restr")) {
        return new Response(JSON.stringify(makeTrack({ policy: "BLOCK" })), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      if (target.includes("snip")) {
        return new Response(JSON.stringify(makeTrack({ policy: "SNIP" })), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      if (target.includes("hlsonly")) {
        // plain unencrypted HLS only (sayiko-shaped)
        return new Response(JSON.stringify(makeTrack({ transcodings: [{
          url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:340501365/bbbb2222-3333-4444-5555-666677778888/stream/hls",
          preset: "aac_160k",
          format: { protocol: "hls", mime_type: "audio/mp4; codecs=\"mp4a.40.2\"" },
        }] })), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (target.includes("hlschunk")) {
        return new Response(JSON.stringify(makeTrack({ transcodings: [{
          url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:340501365/cccc3333-4444-5555-6666-777788889999/stream/hls",
          preset: "aac_160k",
          format: { protocol: "hls", mime_type: "audio/mp4; codecs=\"mp4a.40.2\"" },
        }] })), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (target.includes("enconly")) {
        // 2026-11 alexg-shaped: cbc/ctr encrypted HLS only
        return new Response(JSON.stringify(makeTrack({ transcodings: [
          {
            url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:340501365/dddd4444-5555-6666-7777-888899990000/stream/cbc-encrypted-hls",
            preset: "aac_160k",
            format: { protocol: "cbc-encrypted-hls", mime_type: "audio/mp4; codecs=\"mp4a.40.2\"" },
          },
          {
            url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:340501365/dddd4444-5555-6666-7777-888899990000/stream/ctr-encrypted-hls",
            preset: "aac_160k",
            format: { protocol: "ctr-encrypted-hls", mime_type: "audio/mp4; codecs=\"mp4a.40.2\"" },
          },
        ] })), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (target.includes("opusonly")) {
        return new Response(JSON.stringify(makeTrack({
          transcodings: [{
            url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:340501365/aaaa1111-2222-3333-4444-555566667777/stream/https",
            preset: "opus_0_0",
            format: { protocol: "progressive", mime_type: "audio/ogg; codecs=opus" },
          }],
        })), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify(makeTrack()), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    if (u.pathname.startsWith("/media/soundcloud:tracks:")) {
      calls.streamMeta++;
      if (!u.searchParams.get("track_authorization")) {
        return new Response("no auth", { status: 401 });
      }
      return new Response(JSON.stringify({ url: "https://media.test/abc.mp3" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    return new Response("no route", { status: 404 });
  }

  // ssda engine (ours, same project) - the HLS-to-mp3 conversion backend
  if (u.host === "zfshvxknthgzlgzulpuq.supabase.co" && u.pathname.endsWith("/ssda/api/audio")) {
    calls.ssda++;
    const target = u.searchParams.get("url") || "";
    const chunk = u.searchParams.get("chunk");
    if (target.includes("hlschunk")) {
      if (chunk === "all") return new Response(JSON.stringify({ error: { code: "chunks_not_cached", missing: [0, 1] } }), { status: 409 });
      if (chunk === "info") return new Response(JSON.stringify({ chunk_count: 2, chunk_seconds: 10 }), { status: 200, headers: { "content-type": "application/json" } });
      if (chunk === null) return new Response(JSON.stringify({ error: { code: "chunked_conversion_required", chunk_count: 2 } }), { status: 413, headers: { "content-type": "application/json" } });
      calls.ssdaChunk++;
      return new Response(chunk === "0" ? SSDBYTES.slice(0, 4) : SSDBYTES.slice(4), {
        status: 200, headers: { "content-type": "audio/mpeg" },
      });
    }
    return new Response(SSDBYTES, { status: 200, headers: { "content-type": "audio/mpeg" } });
  }

  // media host
  if (u.host === "media.test") {
    calls.media++;
    return new Response(FAKE_MP3, {
      status: 200,
      headers: { "content-type": "audio/mpeg", "content-length": String(FAKE_MP3.length) },
    });
  }

  throw new Error(`unmocked fetch: ${url} ${init.method ?? "GET"}`);
};

const app = (pathAndQuery) =>
  handleRequest(new Request(`https://example.supabase.co/sca${pathAndQuery}`, {
    method: "GET",
    headers: { origin: "https://bufferclick.github.io" },
  }));

// ------------------------------------------------------------------ tests

console.log("# SCA recipe replay + SoundCloud downloader API");

test("recipe file loads and is schema-shaped", () => {
  const raw = readFileSync(path.join(REPO, "sites/soundcloud.json"), "utf8");
  const site = JSON.parse(raw);
  eq(site.name, "soundcloud");
  eq(site.baseUrl, "https://soundcloud.com");
  ok(Array.isArray(site.operations) && site.operations.length === 4, "4 operations");
  for (const op of site.operations) {
    ok(op.name && op.request?.method === "GET", `${op.name}: name + GET`);
    ok(op.request.url.startsWith("https://"), `${op.name}: absolute url`);
    ok(Array.isArray(op.slots) && op.slots.length > 0, `${op.name}: slots`);
    ok(Array.isArray(op.params) && op.params.length > 0, `${op.name}: params`);
    ok(op.response?.pick?.length > 0, `${op.name}: response.pick`);
    ok(op.readOnly === true && op.minTier === 1, `${op.name}: readOnly tier 1`);
    // every {param} in the request (file stores them %7B-encoded) has a slot + a declared param
    const placeholders = [...op.request.url.matchAll(/(?:%7B|\{)([A-Za-z0-9_]+)(?:%7D|\})/g)].map((m) => m[1]);
    for (const ph of placeholders) {
      ok(op.slots.some((s) => s.param === ph), `${op.name}: slot for {${ph}}`);
      ok(op.params.some((p) => p.name === ph), `${op.name}: param for {${ph}}`);
    }
  }
});

test("recipe file and embedded runner agree on the op set", async () => {
  const site = JSON.parse(readFileSync(path.join(REPO, "sites/soundcloud.json"), "utf8"));
  eq(site.operations.map((o) => o.name), ["searchTracks", "resolveTrack", "getTrack", "getStreamUrl"]);
  const r = await app("/api/ops");
  eq((await r.json()).operations.map((o) => o.name), site.operations.map((o) => o.name));
});

test("health", async () => {
  const r = await app("/api/health");
  eq(r.status, 200);
  const body = await r.json();
  eq(body.ok, true);
  eq(body.name, "SCA");
  eq(body.ops, 4);
});

test("/api/ops lists the four learned operations with parameters", async () => {
  const r = await app("/api/ops");
  eq(r.status, 200);
  const body = await r.json();
  eq(body.format, "api-anything");
  eq(body.operations.length, 4);
  eq(body.operations.map((o) => o.name), ["searchTracks", "resolveTrack", "getTrack", "getStreamUrl"]);
  ok(body.operations[0].params.some((p) => p.name === "q" && p.required));
});

test("/api/call?op=searchTracks replays the learned search and picks fields", async () => {
  const r = await app("/api/call?op=searchTracks&q=harvey");
  eq(r.status, 200);
  const body = await r.json();
  eq(body.ok, true);
  eq(body.class, "ok");
  eq(body.tier, 1);
  eq(body.op, "searchTracks");
  ok(body.request.includes("q=harvey"), "request echoes filled slots");
  eq(body.data.length, 2);
  eq(body.data[0].title, "Result for harvey");
  eq(body.data[0].artist, "artist1");
  eq(body.data[0].permalink, "https://soundcloud.com/artist1/track1");
  ok(body.data[1].id === 2 && body.data[1].title, "second item survives on id+title alone");
});

test("/api/call validates required parameters", async () => {
  const r = await app("/api/call?op=searchTracks");
  eq(r.status, 400);
  const body = await r.json();
  eq(body.error.code, "invalid_args");
  ok(body.error.message.includes("q"), "names the missing param");
});

test("/api/call rejects unknown operations", async () => {
  const r = await app("/api/call?op=stealCookies");
  eq(r.status, 404);
  eq((await r.json()).error.code, "unknown_op");
});

test("getStreamUrl replays directly through /api/call", async () => {
  const r = await app(
    "/api/call?op=getStreamUrl&trackId=340501365&transcodingKey=1a2b3c4d-5e6f-4a8b-9c0d-1234567890ab&track_authorization=eyJhbGciOiJIUzI1NIn0.test",
  );
  eq(r.status, 200);
  const body = await r.json();
  eq(body.data.url, "https://media.test/abc.mp3");
  ok(body.request.includes("soundcloud:tracks:340501365/1a2b3c4d"), "slot template composed the transcoding path");
});

test("/api/search convenience endpoint", async () => {
  const r = await app("/api/search?q=harvey");
  eq(r.status, 200);
  const body = await r.json();
  eq(body.query, "harvey");
  eq(body.results[0].artist, "artist1");
});

test("/api/search requires a query", async () => {
  const r = await app("/api/search");
  eq(r.status, 400);
  eq((await r.json()).error.code, "missing_query");
});

test("/api/info resolves a track with transcodings", async () => {
  const r = await app("/api/info?url=https://soundcloud.com/alexg232/harvey");
  eq(r.status, 200);
  const body = await r.json();
  eq(body.id, 340501365);
  eq(body.artist, "alexg232");
  eq(body.policy, "MONETIZE");
  eq(body.transcodings.length, 2);
  ok(body.trackAuthorization.startsWith("eyJ"), "track authorization carried for the chain");
});

test("/api/info 404s honestly on unknown tracks", async () => {
  const r = await app("/api/info?url=https://soundcloud.com/x/missing");
  eq(r.status, 404);
  eq((await r.json()).error.code, "not_found");
});

test("/api/audio streams progressive mp3 through unchanged", async () => {
  const before = calls.media;
  const r = await app("/api/audio?url=https://soundcloud.com/alexg232/harvey");
  eq(r.status, 200);
  eq(r.headers.get("content-type"), "audio/mpeg");
  ok((r.headers.get("x-sca-source") || "").includes("passthrough"), "labels passthrough honestly");
  eq(r.headers.get("x-sca-extension"), "mp3");
  const bytes = new Uint8Array(await r.arrayBuffer());
  eq(bytes.length, FAKE_MP3.length);
  eq(bytes[0], 0xff);
  ok(calls.media > before, "media bytes were fetched from the stream URL");
});

test("/api/audio labels non-mp3 progressive streams honestly (no silent substitution)", async () => {
  const r = await app("/api/audio?url=https://soundcloud.com/x/opusonly");
  eq(r.status, 200);
  eq(r.headers.get("content-type"), "audio/ogg");
  eq(r.headers.get("x-sca-extension"), "opus");
  ok((r.headers.get("x-sca-source") || "").includes("not mp3"), "explicit about the format");
});

test("/api/download sends a filename disposition", async () => {
  const r = await app("/api/download?url=https://soundcloud.com/alexg232/harvey");
  eq(r.status, 200);
  const cd = r.headers.get("content-disposition") || "";
  ok(cd.startsWith("attachment;"), "attachment disposition");
  ok(decodeURIComponent(cd.split("filename*=UTF-8''")[1] ?? "").includes("alexg232 - Harvey.mp3"), "sane filename");
});

test("restricted tracks are refused with an honest message", async () => {
  const r = await app("/api/audio?url=https://soundcloud.com/x/restr");
  eq(r.status, 403);
  const body = await r.json();
  eq(body.error.code, "restricted");
  ok(body.error.message.includes("Go+"), "names the real reason class");
  ok(body.error.message.includes("no signed-in session"), "states what it will NOT do");
});

test("plain-HLS tracks are converted to mp3 by the ssda engine and streamed through", async () => {
  const before = calls.ssda;
  const r = await app("/api/audio?url=https://soundcloud.com/x/hlsonly&format=mp3");
  eq(r.status, 200);
  eq(r.headers.get("content-type"), "audio/mpeg");
  eq(r.headers.get("x-sca-extension"), "mp3");
  ok((r.headers.get("x-sca-source") || "").includes("ssda engine"), "labels the converting engine");
  const bytes = new Uint8Array(await r.arrayBuffer());
  eq(bytes.length, SSDBYTES.length);
  ok(calls.ssda > before, "ssda engine was called");
});

test("plain-HLS auto mode also converts via ssda", async () => {
  const r = await app("/api/audio?url=https://soundcloud.com/x/hlsonly");
  eq(r.status, 200);
  eq(r.headers.get("content-type"), "audio/mpeg");
});

test("chunked conversions are stitched sequentially", async () => {
  const before = calls.ssdaChunk;
  const r = await app("/api/audio?url=https://soundcloud.com/x/hlschunk");
  eq(r.status, 200);
  const bytes = new Uint8Array(await r.arrayBuffer());
  eq(bytes.length, SSDBYTES.length);
  eq(bytes[4], SSDBYTES[4]);
  ok(calls.ssdaChunk >= before + 2, "both chunks fetched");
  ok((r.headers.get("x-sca-source") || "").includes("stitched 2 chunks"), "says it stitched");
});

test("encrypted-HLS-only tracks are refused by name, honestly", async () => {
  const r = await app("/api/audio?url=https://soundcloud.com/x/enconly");
  eq(r.status, 403);
  const body = await r.json();
  eq(body.error.code, "encrypted_stream");
  ok(body.error.message.includes("cbc-encrypted-hls"), "names the protocol");
  ok(body.error.message.includes("no keys, no CDM"), "states what it will NOT do");
});

test("encrypted refusal also applies when mp3 is demanded", async () => {
  const r = await app("/api/audio?url=https://soundcloud.com/x/enconly&format=mp3");
  eq(r.status, 403);
  eq((await r.json()).error.code, "encrypted_stream");
});

test("MONETIZE policy tracks download normally", async () => {
  const r = await app("/api/audio?url=https://soundcloud.com/alexg232/harvey");
  eq(r.status, 200);
  ok(!(r.headers.get("x-sca-source") || "").includes("preview"), "no preview label");
});

test("SNIP tracks serve with an honest preview label", async () => {
  const r = await app("/api/audio?url=https://soundcloud.com/x/snip");
  eq(r.status, 200);
  ok((r.headers.get("x-sca-source") || "").includes("preview/snip"), "labeled preview");
});

test("format parameter is validated", async () => {
  const r = await app("/api/audio?url=https://soundcloud.com/alexg232/harvey&format=wav");
  eq(r.status, 400);
  eq((await r.json()).error.code, "invalid_format");
});

test("stale client_id rotates to the next pooled id and retries", async () => {
  resolveRejectOnce = true;
  const before = calls.resolve;
  const r = await app("/api/info?url=https://soundcloud.com/alexg232/harvey");
  eq(r.status, 200);
  eq((await r.json()).id, 340501365);
  ok(calls.resolve >= before + 2, "reject then successful retry");
});

test("the recipe chain is exercised end to end (resolve -> stream url -> media)", async () => {
  const before = { resolve: calls.resolve, streamMeta: calls.streamMeta, media: calls.media };
  const r = await app("/api/audio?url=https://soundcloud.com/alexg232/harvey");
  eq(r.status, 200);
  ok(calls.resolve > before.resolve, "resolveTrack ran");
  ok(calls.streamMeta > before.streamMeta, "getStreamUrl ran");
  ok(calls.media > before.media, "media bytes streamed");
});

test("CORS preflight", async () => {
  const r = await handleRequest(new Request("https://example.supabase.co/sca/api/audio", { method: "OPTIONS" }));
  eq(r.status, 204);
  eq(r.headers.get("access-control-allow-origin"), "*");
});

test("only GET is supported", async () => {
  const r = await handleRequest(new Request("https://example.supabase.co/sca/api/health", { method: "POST" }));
  eq(r.status, 405);
  eq((await r.json()).error.code, "method_not_allowed");
});

test("runOp is importable for recipe replay outside the HTTP surface", async () => {
  const r = await runOp("searchTracks", { q: "direct" });
  eq(r.ok, true);
  eq(r.site, "soundcloud");
  eq(r.data[0].title, "Result for direct");
});

for (const [name, fn] of pending) {
  try {
    await fn();
    passCount++;
    console.log(`ok ${passCount} - ${name}`);
  } catch (err) {
    failCount++;
    console.error(`FAIL ${name}: ${err?.message ?? err}`);
    if (process.env.FAIL_FAST) {
      globalThis.fetch = REAL_FETCH;
      process.exit(1);
    }
  }
}
console.log(`# ${passCount} passed, ${failCount} failed`);
globalThis.fetch = REAL_FETCH;
if (failCount > 0) process.exit(1);
