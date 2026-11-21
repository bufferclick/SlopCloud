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
   plays everywhere), then m4a (AAC), then opus. Some tracks are only offered
   as DRM-wrapped streams that cannot play outside a licensed player; for
   those, when the artist allows downloads, the official download file is
   served instead.
3. The SlopCloud API in the browser stores the bytes in the site's own cache
   (Cache API) and the track info in IndexedDB. The song is now in the website,
   not in your downloads folder. Clear this site's stored data and the songs are
   gone.
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

- `url` must be a SoundCloud link (`soundcloud.com`, `on.soundcloud.com`,
  `snd.sc`); short links are resolved. Playlists and profiles are rejected.
- `format=auto` picks the progressive mp3 first, then m4a, then opus; an
  explicit `format` prefers that rendition and falls back to the closest one.
- Audio responses carry `X-SSDA-Extension` and a `Content-Disposition` filename
  (`Artist - Title.ext`). When the requested format does not exist for a track,
  the closest rendition is served and `X-SSDA-Format-Note` explains.
- Renditions are container-validated before serving: HLS fMP4/Ogg are
  assembled as-is, MPEG-TS is demuxed to ADTS AAC, DRM-wrapped (cbcs/cenc)
  streams are skipped, and the artist's official download file is used when
  that is the only playable audio.
- CORS is open (`Access-Control-Allow-Origin: *`), so any website can use it.
- Errors are JSON: `{"error": {"code": "...", "message": "..."}}`.

The function is deployed in the Supabase project `SlopCloud`
(`zfshvxknthgzlgzulpuq`) with `verify_jwt = false`. To update it: edit
`supabase/functions/ssda/index.ts` and deploy with the Supabase CLI
(`supabase functions deploy ssda --no-verify-jwt`) or through the connected
Supabase app.

## Run the site locally

The site is plain static files — any static server works:

```sh
python3 -m http.server 8000 --directory site
```

## Tests

```sh
node tools/test-ssda.mjs
```

43 tests covering routing, format selection, HLS assembly, container
validation, DRM handling, the official-download fallback, error shapes, CORS,
and resilience (challenge-page retries, flaky upstream, oEmbed fallback) — all
against a mocked SoundCloud, no network needed.

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
