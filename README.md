# SlopCloud

SoundCloud song downloader API (SSDA) plus a static website that stores songs in
the browser cache and plays them back.

Repository layout:

| Path | What it is |
| --- | --- |
| `index.html` | Root page for GitHub Pages. It points everything to `/site`. |
| `site/` | The website: enter a SoundCloud link, save the song to the browser cache, or download it to files. Lists cached songs and plays them. |
| `site/slopcloud.js` | The SlopCloud API — browser-side storage. Audio goes into the site's Cache API, metadata into IndexedDB. Nothing touches the downloads folder unless you press "Download song to files". |
| `ssda/` | The SSDA server — resolves a SoundCloud link and returns the audio bytes. Small Flask app, two dependencies (`flask`, `yt-dlp`). |

## How the pieces fit

1. The website asks SSDA for the audio of a SoundCloud link (`/api/info`, `/api/audio`).
2. SSDA downloads the track and passes the audio through **without re-encoding**,
   so quality is exactly what the uploader provided. `format=auto` keeps full
   source quality and prefers the most storage-efficient rendition
   (opus, then m4a, then mp3).
3. The SlopCloud API in the browser stores the bytes in the site's own cache
   (Cache API) and the track info in IndexedDB. The song is now in the website,
   not in your downloads folder. Clear this site's stored data and the songs are
   gone.
4. "Download song to files" is the alternative: it saves the audio to your
   device the normal way.

## Run everything locally

```sh
python3 -m venv .venv
.venv/bin/pip install -r ssda/requirements.txt

# demo mode: serves generated tones, no internet needed
.venv/bin/python ssda/server.py --demo --static site --port 8000
# then open http://localhost:8000
```

For real downloads, drop `--demo` (server needs outbound internet; `ffmpeg` on
the server enables optional format conversion — without it, the source format is
kept untouched):

```sh
.venv/bin/python ssda/server.py --static site --port 8000
```

## Deploy

**Website (GitHub Pages):** enable Pages for this repository, branch `main`,
root folder. The root `index.html` redirects to `/site`, where the site lives.
Pages serves static files only, so it cannot run the SSDA server.

**SSDA server:** deploy the `ssda/` folder to any host that runs Python and has
outbound internet (Render, Railway, Fly.io, a VPS, ...). A `Dockerfile` is
included. Then open the website settings ("SSDA API settings") and paste the
server URL — the field is stored in the browser. The API sends
`Access-Control-Allow-Origin: *`, so any website can call it.

## SSDA API

See [`ssda/README.md`](ssda/README.md) for endpoints and parameters.

```
GET /api/health                     status and capabilities
GET /api/info?url=<soundcloud-link> track metadata (JSON)
GET /api/audio?url=<link>&format=auto|m4a|mp3|opus   audio bytes (Range supported)
GET /api/download?url=<link>        audio bytes as a file download
```

## Notes

- Songs live in the site's browser cache. Clearing site data (or the
  "Delete all cached songs" button) removes them. Browsers may also evict
  cached data under storage pressure.
- Keep the audio you are allowed to keep: your own uploads, tracks the artist
  offers for download, Creative Commons licensed audio, and so on. Respect
  SoundCloud's terms and copyright law.
- SSDA caches the last 32 tracks server-side (configurable with
  `SSDA_CACHE_DIR` / `SSDA_CACHE_MAX`) so repeat requests are fast and light.
