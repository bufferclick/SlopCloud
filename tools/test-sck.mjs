// tests/sck: SCK - an API of klickaud.org (SoundCloud downloader website)
// Run: npm install (once), then node tools/test-sck.mjs
// All upstream traffic is mocked - no network, no klickaud calls.

import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");
const fnUrl = new URL(`file://${path.join(REPO, "supabase/functions/sck/index.ts")}`);
const { handleRequest, convert } = await import(fnUrl.href);

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

const REAL_FETCH = globalThis.fetch;
const FAKE_MP3 = new Uint8Array([0xff, 0xfb, 0x90, 0x44, 0x00, 0x02, 0x44, 0x00, 0x01, 0x02, 0x03]);
const encoder = new TextEncoder();
const seen = { downloadCookie: null, downloadValue: null, capBody: null, sseUrl: null, sseCount: 0 };

function sseResponse(text) {
  return new Response(
    new ReadableStream({
      start(c) {
        // deliver in two chunks like a real event stream
        const mid = Math.ceil(text.length / 2);
        c.enqueue(encoder.encode(text.slice(0, mid)));
        c.enqueue(encoder.encode(text.slice(mid)));
        c.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

const convertHtml = (mode, extra) =>
  `<html><head><script>
  const downloadMode = "${mode}";
  const directDownloadUrl = "${extra.direct || ""}";
  const defaultFileName = "${extra.file || "SoundCloud Track"}";
  const sseGrant = "${extra.grant || ""}";
  </script></head><body>${extra.body || ""}</body></html>`;

globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  const u = new URL(url);
  const headers = new Headers(init.headers || {});

  if (u.host === "www.klickaud.org") {
    if (u.pathname === "/en17/" || u.pathname === "/") {
      return new Response('<html><body><form action="/download.php"><input name="value"><button>Convert</button></form></body></html>', { status: 200 });
    }
    if (u.pathname === "/csrf-token-endpoint.php") {
      return new Response(JSON.stringify({ csrf_token: "tok123" }), {
        status: 200,
        headers: { "content-type": "application/json", "set-cookie": "PHPSESSID=sess1; Path=/; HttpOnly" },
      });
    }
    if (u.pathname === "/download.php") {
      seen.downloadCookie = headers.get("cookie") || "";
      const body = init.body ? String(init.body) : "";
      seen.downloadValue = new URLSearchParams(body).get("value") || "";
      if (!body.includes("csrf_token=tok123")) return new Response("forbidden", { status: 403 });
      if (seen.downloadValue.includes("direct")) {
        return new Response(
          convertHtml("direct", { direct: "https://media.test/dl/track.mp3", file: "Harvey_KLICKAUD.mp3" }),
          { status: 200, headers: { "content-type": "text/html", "set-cookie": "ka_pref=1; Path=/" } },
        );
      }
      if (seen.downloadValue.includes("nogrant")) {
        return new Response(convertHtml("worker", { file: "No Grant.mp3" }), { status: 200 });
      }
      if (seen.downloadValue.includes("worker")) {
        return new Response(
          convertHtml("worker", { grant: "grant456", file: "Worker Song_forhub_soundcloud_to_mp3.mp3" }),
          { status: 200, headers: { "content-type": "text/html" } },
        );
      }
      if (seen.downloadValue.includes("verifyok")) {
        seen.dlVerifyok = (seen.dlVerifyok || 0) + 1;
        if (seen.dlVerifyok === 1) {
          return new Response(
            '<form method="post" action="/download.php"><input type="hidden" name="verify_token" value="abc"><input type="hidden" name="csrf_token" value="tok123"><button>Continue</button></form>',
            { status: 403, headers: { "content-type": "text/html" } },
          );
        }
        return new Response(convertHtml("worker", { grant: "grant-verify", file: "Verify Song.mp3" }), { status: 200 });
      }
      if (seen.downloadValue.includes("verifycap")) {
        return new Response(
          '<form method="post" action="/download.php"><script src="https://js.hcaptcha.com/1/api.js"></script><div class="h-captcha"></div></form>',
          { status: 403, headers: { "content-type": "text/html" } },
        );
      }
      return new Response("<html><body>could not convert</body></html>", { status: 200 });
    }
    if (u.pathname === "/sse_capability.php") {
      seen.capBody = init.body ? String(init.body) : "";
      return new Response(JSON.stringify({ capability: "cap789" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    if (u.pathname === "/worker_sse.php") {
      seen.sseUrl = url;
      seen.sseCount++;
      const target = u.searchParams.get("url") || "";
      if (!u.searchParams.get("cap")) return new Response("no cap", { status: 403 });
      if (target.includes("failworker")) {
        return sseResponse("event: progress\ndata: {\"pct\":50}\n\nevent: failed\ndata: {}\n\n");
      }
      if (target.includes("emptysse")) {
        return sseResponse("event: progress\ndata: {\"pct\":10}\n\n");
      }
      return sseResponse(
        'event: progress\ndata: {"pct":90}\n\nevent: ready\ndata: {"download_url":"https://media.test/dl/worker.mp3","file_name":"Worker Song_forhub_soundcloud_to_mp3.mp3"}\n\n',
      );
    }
    return new Response("no route", { status: 404 });
  }

  if (u.host === "media.test") {
    if (u.pathname.endsWith("/empty.mp3")) {
      return new Response(new Uint8Array(0), { status: 200, headers: { "content-length": "0" } });
    }
    return new Response(FAKE_MP3, {
      status: 200,
      headers: { "content-type": "audio/mpeg", "content-length": String(FAKE_MP3.length) },
    });
  }

  throw new Error(`unmocked fetch: ${url} ${init.method ?? "GET"}`);
};

const app = (pathAndQuery) =>
  handleRequest(new Request(`https://example.supabase.co/sck${pathAndQuery}`, {
    method: "GET",
    headers: { origin: "https://bufferclick.github.io" },
  }));

// ------------------------------------------------------------------ tests

console.log("# SCK - API of klickaud.org");

test("health", async () => {
  const r = await app("/api/health");
  eq(r.status, 200);
  const body = await r.json();
  eq(body.ok, true);
  eq(body.name, "SCK");
  ok(body.source.includes("klickaud.org"), "names the website it wraps");
});

test("service index describes the flow", async () => {
  const body = await (await app("/api")).json();
  ok(body.description.includes("Convert"), "describes the site flow");
  ok(body.endpoints["/api/audio"], "has the downloader");
});

test("info (direct mode): the site's Convert returns the song immediately", async () => {
  const r = await app("/api/info?url=https://soundcloud.com/alexg232/harvey-direct");
  eq(r.status, 200);
  const body = await r.json();
  eq(body.mode, "direct");
  eq(body.title, "Harvey"); // _KLICKAUD.mp3 cleaned off
  ok(body.source.includes("klickaud.org"));
});

test("info (worker mode): Convert waits on the site's worker", async () => {
  const r = await app("/api/info?url=https://soundcloud.com/thatbandofhers/harvey-worker");
  eq(r.status, 200);
  const body = await r.json();
  eq(body.mode, "worker");
  eq(body.title, "Worker Song"); // _forhub_soundcloud_to_mp3.mp3 cleaned off
});

test("the flow sends cookies and the pasted URL, like a browser", async () => {
  await app("/api/info?url=https://soundcloud.com/alexg232/harvey-direct");
  ok(seen.downloadCookie.includes("PHPSESSID=sess1"), "session cookie carried from the CSRF step");
  eq(seen.downloadValue, "https://soundcloud.com/alexg232/harvey-direct"); // exactly what the user pasted
});

test("audio (direct): presses Download the song and returns the mp3", async () => {
  const r = await app("/api/audio?url=https://soundcloud.com/alexg232/harvey-direct");
  eq(r.status, 200);
  eq(r.headers.get("content-type"), "audio/mpeg");
  eq(r.headers.get("x-sck-source"), "klickaud.org (third-party converter)");
  eq(r.headers.get("x-sck-mode"), "direct");
  const cd = r.headers.get("content-disposition") || "";
  ok(cd.startsWith("inline;"), "serves inline");
  ok(decodeURIComponent(cd.split("filename*=UTF-8''")[1] ?? "").includes("Harvey.mp3"), "filename from the site's title");
  const bytes = new Uint8Array(await r.arrayBuffer());
  eq(bytes.length, FAKE_MP3.length);
});

test("audio (worker): follows the SSE stream to the ready link", async () => {
  const before = seen.sseCount;
  const r = await app("/api/audio?url=https://soundcloud.com/thatbandofhers/harvey-worker");
  eq(r.status, 200);
  eq(r.headers.get("x-sck-mode"), "worker");
  ok(seen.sseCount > before, "worker SSE was opened");
  ok(seen.sseUrl.includes("cap=cap789"), "capability passed to the worker");
  const bytes = new Uint8Array(await r.arrayBuffer());
  eq(bytes.length, FAKE_MP3.length);
});

test("download sends a file disposition", async () => {
  const r = await app("/api/download?url=https://soundcloud.com/alexg232/harvey-direct");
  eq(r.status, 200);
  ok((r.headers.get("content-disposition") || "").startsWith("attachment;"));
});

test("worker failure is reported by name", async () => {
  const r = await app("/api/audio?url=https://soundcloud.com/x/failworker-worker");
  eq(r.status, 502);
  const body = await r.json();
  eq(body.error.code, "worker_failed");
  ok(body.error.message.includes("klickaud.org"), "names the website");
});

test("SSE ending with no link is honest", async () => {
  const r = await app("/api/audio?url=https://soundcloud.com/x/emptysse-worker");
  eq(r.status, 502);
  eq((await r.json()).error.code, "no_result");
});

test("no download link after Convert is honest, with a diagnostic snippet", async () => {
  const r = await app("/api/audio?url=https://soundcloud.com/x/nogrant-worker");
  eq(r.status, 502);
  const body = await r.json();
  eq(body.error.code, "convert_failed");
  ok(body.error.detail && body.error.detail.includes("POST /download.php"), "carries the step + page snippet");
});

test("hidden-field verify interstitial is continued automatically", async () => {
  const r = await app("/api/info?url=https://soundcloud.com/demo/verifyok");
  eq(r.status, 200);
  const body = await r.json();
  eq(body.mode, "worker");
  eq(body.source, "klickaud.org (third-party converter)");
});

test("real captcha on the interstitial stops with verify_required", async () => {
  const r = await app("/api/info?url=https://soundcloud.com/demo/verifycap");
  eq(r.status, 403);
  const body = await r.json();
  eq(body.error.code, "verify_required");
  ok(body.error.message.includes("hcaptcha"), "names the captcha");
  ok(body.error.message.includes("does not solve captchas"), "honest refusal");
});

test("CSRF failure is honest", async () => {
  // break the token endpoint once
  const saved = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const u = new URL(String(input));
    if (u.pathname === "/csrf-token-endpoint.php") return new Response("nope", { status: 500 });
    return saved(input, init);
  };
  try {
    const r = await app("/api/info?url=https://soundcloud.com/alexg232/harvey-direct");
    eq(r.status, 502);
    eq((await r.json()).error.code, "no_token");
  } finally {
    globalThis.fetch = saved;
  }
});

test("empty files are refused, not served", async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const u = new URL(String(input));
    if (u.host === "media.test") {
      return new Response(new Uint8Array(0), { status: 200, headers: { "content-length": "0" } });
    }
    return saved(input, init);
  };
  try {
    const r = await app("/api/audio?url=https://soundcloud.com/alexg232/harvey-direct");
    eq(r.status, 502);
    eq((await r.json()).error.code, "empty_file");
  } finally {
    globalThis.fetch = saved;
  }
});

test("non-SoundCloud links are refused (this API is SoundCloud-only)", async () => {
  const r = await app("/api/audio?url=https://youtube.com/watch?v=x");
  eq(r.status, 400);
  eq((await r.json()).error.code, "bad_url");
});

test("missing url parameter", async () => {
  const r = await app("/api/audio");
  eq(r.status, 400);
  eq((await r.json()).error.code, "missing_url");
});

test("unknown endpoint", async () => {
  const r = await app("/api/nope");
  eq(r.status, 404);
});

test("CORS preflight + GET only", async () => {
  const pre = await handleRequest(new Request("https://example.supabase.co/sck/api/audio", { method: "OPTIONS" }));
  eq(pre.status, 204);
  eq(pre.headers.get("access-control-allow-origin"), "*");
  const post = await handleRequest(new Request("https://example.supabase.co/sck/api/audio", { method: "POST" }));
  eq(post.status, 405);
});

test("debug endpoint shows what each site step answered", async () => {
  const r = await app("/api/debug?url=https://soundcloud.com/alexg232/harvey-direct");
  eq(r.status, 200);
  const body = await r.json();
  eq(body.landing.status, 200);
  ok(body.landing.snippet.includes("Convert"), "landing form visible");
  eq(body.csrf.status, 200);
  eq(body.convert.status, 200);
  ok(body.convert.snippet.includes("downloadMode"), "convert page constants visible");
  ok(body.cookieCount >= 1, "cookies tracked");
});

test("convert() is importable for use outside the HTTP surface", async () => {
  const c = await convert("https://on.soundcloud.com/xyz-direct");
  eq(c.mode, "direct");
  eq(c.downloadUrl, "https://media.test/dl/track.mp3");
  eq(c.title, "Harvey");
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
