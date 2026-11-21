# SlopCloud

SoundCloud song downloader API (SSDA) plus a static website that stores songs in
the browser cache and plays them back. The API is a Supabase Edge Function —
SlopCloud itself is the API, there is no separate server to run.

Live: https://bufferclick.github.io/SlopCloud/site/

Repository layout:

| Path | What it is |
| --- | --- |
| `index.html` | Root page for GitHub Pages. It points everything to `/site`. |
| `site/` | The website: enter a SoundCloud link, save the song to the browser cache, or download it to files. Lists cached songs and plays them. |
| `site/slopcloud.js` | The SlopCloud API — browser-side storage. Audio goes into the site's Cache API, metadata into IndexedDB. Nothing touches the downloads folder unless you press "Download song to files". |
| `supabase/functions/ssda/index.ts` | The SSDA API, deployed as a Supabase Edge Function in the SlopCloud Supabase project. |
| `tools/test-ssda.mjs` | Local tests for the API (mocked SoundCloud, no network needed). |

## How the pieces fit

1. The website calls the SSDA API (`/api/info`, `/api/audio`) on Supabase:
   `https://zfshvxknthgzlgzulpuq.supabase.co/functions/v1/ssda`.
2. SSDA resolves the SoundCloud link server-side and passes the audio through
   **without re-encoding**, so quality is exactly what the uploader provided.
   `format=auto` prefers the progressive mp3 (smallest standard rendition,
   plays everywhere), then m4a (AAC), then opus. When you explicitly ask for
   `format=mp3`, `m4a` or `opus` and the track has no file in that format, the
   best available rendition is decoded and re-encoded to the format you asked
   for. Some tracks are only offered as DRM-wrapped streams that cannot play
   outside a licensed player; for those, when the artist allows downloads, the
   official download file is served instead.
3. The SlopCloud API in the browser stores the bytes in the site's own cache
   (Cache API) and the track info in IndexedDB. The song is now in the website,
   not in your downloads folder. Clear this site's stored data and the songs are
   gone. Audio files you already have (for example downloaded elsewhere when
   SoundCloud blocks a track) can be saved into the cache the same way with
   "Save file to cache".
4. "Download song to files" is the alternative: it saves the audio to your
   device the normal way.

The API URL is built into the site — nothing to configure. For local
development against another instance:

```js
localStorage.setItem('ssda.api', 'http://localhost:8787')
```

## The SSDA API

```
GET /api/health                              status
GET /api/info?url=<soundcloud-link>          track metadata (JSON)
GET /api/audio?url=<link>&format=auto|m4a|mp3|opus   audio bytes
GET /api/download?url=<link>                 audio bytes as a file download
```

Base URL (live, CORS open — call it from anywhere):

```
https://zfshvxknthgzlgzulpuq.supabase.co/functions/v1/ssda
```

Quick try (any SoundCloud track link, short or full):

```sh
curl "https://zfshvxknthgzlgzulpuq.supabase.co/functions/v1/ssda/api/health"
curl "https://zfshvxknthgzlgzulpuq.supabase.co/functions/v1/ssda/api/info?url=https://soundcloud.com/alexg232/harvey"
curl -o song.mp3 "https://zfshvxknthgzlgzulpuq.supabase.co/functions/v1/ssda/api/audio?url=https://soundcloud.com/alexg232/harvey&format=mp3"
```

Add `&debug=1` to `/api/info` (or `&debug=probe` to `/api/audio`) for diagnostics.

- `url` must be a SoundCloud link (`soundcloud.com`, `on.soundcloud.com`,
  `snd.sc`); short links are resolved. Playlists and profiles are rejected.
- `format=auto` picks the progressive mp3 first, then m4a, then opus, and is
  never re-encoded. An explicit `format` prefers that rendition; when the
  track has no file in the requested format, the best available rendition is
  decoded and re-encoded to it (`X-SSDA-Format-Note: converted from ... to ...`).
- Audio responses carry `X-SSDA-Extension` and a `Content-Disposition` filename
  (`Artist - Title.ext`). When an explicit format is requested and cannot be
  produced, the API returns a clear `415 conversion_failed` error instead of
  silently serving a different format; `X-SSDA-Format-Note` reports
  conversions that did happen.
- Renditions are container-validated before serving: HLS fMP4/Ogg are
  assembled as-is (styp-headed fragments included), MPEG-TS is demuxed to ADTS
  AAC, DRM-wrapped (cbcs/cenc) streams are skipped, and two fallbacks cover
  "blocked" tracks: the artist's official download file, and the legacy
  `api.soundcloud.com/tracks/{id}/stream` endpoint (a plain mp3 — the same
  source long-lived downloader tools use).
- CORS is open (`Access-Control-Allow-Origin: *`), so any website can use it.
- Errors are JSON: `{"error": {"code": "...", "message": "..."}}`.

The function is deployed in the Supabase project `SlopCloud`
(`zfshvxknthgzlgzulpuq`) with `verify_jwt = false`. To update it: edit
`supabase/functions/ssda/index.ts` and deploy with the Supabase CLI
(`supabase functions deploy ssda --no-verify-jwt`) or through the connected
Supabase app.

## Use SlopCloud in your own site

Two integration levels.

### A. Raw HTTP calls (any language)

The API is stateless and CORS-open, so any page can fetch the bytes and keep
them however it likes. A minimal save-to-cache flow in plain JS:

```js
const API = 'https://zfshvxknthgzlgzulpuq.supabase.co/functions/v1/ssda';
const info  = await (await fetch(API + '/api/info?url=' + encodeURIComponent(link))).json();
const audio = await fetch(API + '/api/audio?url=' + encodeURIComponent(link) + '&format=mp3');
// audio.headers has Content-Type, X-SSDA-Extension, X-SSDA-Format-Note
const blob = await audio.blob();
```

### B. Drop-in browser library (cache + library + playback)

`site/slopcloud.js` is the storage layer this site uses — standalone, no
dependencies. Include it and you get the same "save to cache" behaviour:
audio bytes live in the visitor's browser (Cache API + IndexedDB) under
**your** origin, so clearing your site's data deletes the songs and nothing is
stored on any server. There is no API endpoint that can write into a visitor's
browser cache — the browser does the storing, this library does the work.

```html
<script src="https://bufferclick.github.io/SlopCloud/site/slopcloud.js"></script>
<script>
  const API = 'https://zfshvxknthgzlgzulpuq.supabase.co/functions/v1/ssda';
  await SlopCloud.init();

  // save a song into this visitor's browser cache
  const song = await SlopCloud.fetchAndCache(API, 'https://on.soundcloud.com/dQ3hr5TOmTdN99qMje', {
    format: 'auto',                                   // or 'mp3' / 'm4a' / 'opus'
    onProgress: (loaded, total) => console.log(loaded, total),
  });

  // list, play, delete
  const songs = await SlopCloud.listSongs();
  const url = await SlopCloud.createObjectURL(song.id);
  new Audio(url).play();
  await SlopCloud.deleteSong(song.id);
</script>
```

| function | what it does |
| --- | --- |
| `init()` | open storage; safe to call repeatedly |
| `fetchAndCache(apiBase, url, opts)` | download a SoundCloud link into the cache; `opts = { format='auto', onProgress(loaded,total), skipIfCached=false }`; returns the song record |
| `importFile(file)` | store a local audio file in the cache |
| `listSongs()` | all cached song records, newest first |
| `getSong(id)` / `getSongBlob(id)` | one record / its audio Blob |
| `createObjectURL(id)` / `releaseObjectURL(url)` | playback URLs |
| `deleteSong(id)` / `clearAll()` | remove one / all songs |
| `usage()` | `{ used, quota, songs }` |
| `saveFile(blob, filename)` | trigger a browser download of a Blob |

A complete working example page lives at
[`site/embed-demo.html`](site/embed-demo.html)
(runnable copy: `https://bufferclick.github.io/SlopCloud/site/embed-demo.html`).

## Run the site locally

The site is plain static files — any static server works:

```sh
python3 -m http.server 8000 --directory site
```

## Tests

```sh
npm install          # mirrors the function's npm: imports for Node
node tools/test-ssda.mjs
```

66 tests covering routing, format selection, format conversion (real
decode/re-encode through wasm codecs, including styp-headed fMP4 HLS),
HLS assembly, container validation, DRM handling, the legacy-stream and
official-download fallbacks, explicit-format fidelity, short-link expansion,
resolve-body validation, error shapes, CORS, and resilience (challenge-page
retries, flaky upstream, oEmbed fallback) — all against a mocked SoundCloud,
no network needed.

## Notes

- Songs live in the site's browser cache. Clearing site data (or the
  "Delete all cached songs" button) removes them. Browsers may also evict
  cached data under storage pressure.
- Keep the audio you are allowed to keep: your own uploads, tracks the artist
  offers for download, Creative Commons licensed audio, and so on. Respect
  SoundCloud's terms and copyright law.
- The API retries through SoundCloud's occasional bot-challenge pages and
  region-dependent responses, but a heavily blocked request returns a clear
  error — trying again usually works.
