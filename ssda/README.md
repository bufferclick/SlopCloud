# SSDA — SlopCloud Song Downloader API

Small Flask service. You give it a SoundCloud track link, it gives you the
audio bytes. No database, no accounts. Audio is never re-encoded by default:
what the uploader provided is what you get, in the most storage-efficient
format SoundCloud offers for it (opus, then m4a, then mp3).

## Requirements

- Python 3.10+
- `pip install -r requirements.txt` (flask, yt-dlp)
- outbound internet access to SoundCloud
- `ffmpeg` (optional) — only needed to convert to a requested format; without
  it the source format is kept and the response notes that

## Run

```sh
pip install -r requirements.txt
python server.py                 # listens on 0.0.0.0:8000
python server.py --port 9000 --static ../site   # also serve the website
python server.py --demo          # generated demo tones, no internet needed
```

Docker:

```sh
docker build -t ssda .
docker run -p 8000:8000 ssda
```

## Endpoints

All responses allow CORS (`Access-Control-Allow-Origin: *`). Errors look like
`{"error": {"code": "...", "message": "..."}}` with a matching HTTP status.

### `GET /api/health`

```json
{"ok": true, "name": "SSDA", "version": "1.0.0", "demo": false,
 "yt_dlp": "2026.10.26", "ffmpeg": true, "cached_tracks": 3}
```

### `GET /api/info?url=<soundcloud-link>`

Track metadata. `url` must be a SoundCloud link (`soundcloud.com`,
`on.soundcloud.com`, `snd.sc`); short links are resolved.

```json
{"id": "...", "title": "...", "artist": "...", "duration": 213,
 "artwork_url": "...", "permalink_url": "...", "source_url": "..."}
```

### `GET /api/audio?url=<soundcloud-link>&format=auto|m4a|mp3|opus`

Audio bytes. `format` defaults to `auto`:

- `auto` — full source quality, most storage-efficient rendition
  (opus > m4a > mp3). No conversion.
- `m4a` / `mp3` / `opus` — prefer a rendition already in that format; convert
  with ffmpeg only if the server has it and nothing matches. Otherwise the
  source format is returned and `X-SSDA-Format-Note` explains why.

Supports `Range` requests (HTTP 206), so players can seek. Response headers:

| Header | Meaning |
| --- | --- |
| `Content-Disposition` | `inline`, with a suggested `Artist - Title.ext` filename |
| `X-SSDA-Extension` | actual file extension (`mp3`, `m4a`, `ogg`, `wav`, ...) |
| `X-SSDA-Format-Note` | only present when the requested format could not be honored |

### `GET /api/download?url=<soundcloud-link>&format=...`

Same as `/api/audio` but with `Content-Disposition: attachment`.

## Configuration

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `SSDA_DEMO` | off | `1` = serve generated demo tones instead of fetching SoundCloud |
| `SSDA_CACHE_DIR` | system temp `/ssda-cache` | server-side cache directory |
| `SSDA_CACHE_MAX` | `32` | number of tracks kept in the server-side cache |
| `PORT` | `8000` | default listen port |

The server-side cache is an LRU of the most recent tracks so repeated requests
do not hit SoundCloud again. The browser keeps its own copy (see
`site/slopcloud.js`); the two are independent.

## Being a good citizen

This exists for audio you are allowed to download (your own uploads, tracks
offered for download, Creative Commons audio). If you expose the API publicly,
put a rate limit in front of it and respect SoundCloud's terms and copyright
law.
