#!/usr/bin/env python3
"""SSDA - SlopCloud Song Downloader API.

Small Flask service that resolves a SoundCloud link and serves the track
audio. The audio is passed through untouched (no re-encode), so quality is
exactly what the uploader provided; `format=auto` prefers the most
storage-efficient rendition (opus, then m4a, then mp3).

Endpoints:
    GET /                       service index (JSON), or the static site when --static is used
    GET /api                    service index (JSON)
    GET /api/health             liveness + capabilities
    GET /api/info?url=...       track metadata
    GET /api/audio?url=...      audio bytes (Range requests supported)
    GET /api/download?url=...   audio bytes as an attachment

Environment:
    SSDA_DEMO=1       serve generated demo tones instead of fetching SoundCloud
    SSDA_CACHE_DIR    disk cache directory (default: system temp /ssda-cache)
    SSDA_CACHE_MAX    max cached tracks (default: 32)
    PORT              default listen port (default: 8000)
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import os
import re
import shutil
import struct
import sys
import tempfile
import threading
import time
import wave
from pathlib import Path
from urllib.parse import urlparse

from flask import Flask, abort, jsonify, request, send_file

try:
    import yt_dlp
    YTDLP_VERSION = yt_dlp.version.__version__
except Exception:  # pragma: no cover - demo mode must work without yt-dlp
    yt_dlp = None
    YTDLP_VERSION = None

VERSION = "1.0.0"
SERVICE_NAME = "SSDA"

DEMO = os.environ.get("SSDA_DEMO", "") not in ("", "0", "false", "False")
CACHE_DIR = Path(os.environ.get("SSDA_CACHE_DIR") or Path(tempfile.gettempdir()) / "ssda-cache")
CACHE_MAX = max(1, int(os.environ.get("SSDA_CACHE_MAX", "32")))

ALLOWED_HOSTS = {
    "soundcloud.com",
    "www.soundcloud.com",
    "m.soundcloud.com",
    "on.soundcloud.com",
    "snd.sc",
}

# format=auto keeps full source quality and prefers the codec that stores it
# most cheaply (opus > m4a > mp3). Explicit formats pick the matching
# rendition first and only re-encode (via ffmpeg) when nothing matches.
FORMAT_SELECTOR = {
    "auto": "bestaudio[acodec=opus]/bestaudio[ext=m4a]/bestaudio[ext=mp3]/bestaudio/best",
    "opus": "bestaudio[acodec=opus]/bestaudio",
    "m4a": "bestaudio[ext=m4a]/bestaudio[acodec*=mp4a]/bestaudio",
    "mp3": "bestaudio[ext=mp3]/bestaudio",
}
MIME_BY_EXT = {
    "mp3": "audio/mpeg",
    "m4a": "audio/mp4",
    "aac": "audio/aac",
    "opus": "audio/ogg",
    "ogg": "audio/ogg",
    "oga": "audio/ogg",
    "wav": "audio/wav",
    "flac": "audio/flac",
    "webm": "audio/webm",
}

app = Flask(__name__)
STATIC_DIR: Path | None = None

_locks_guard = threading.Lock()
_entry_locks: dict[str, threading.Lock] = {}


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


@app.errorhandler(ApiError)
def handle_api_error(err: ApiError):
    return jsonify({"error": {"code": err.code, "message": err.message}}), err.status


@app.errorhandler(404)
def handle_404(_err):
    if request.path.startswith("/api/"):
        return jsonify({"error": {"code": "not_found", "message": "No such endpoint or resource."}}), 404
    return "Not found", 404


@app.after_request
def add_cors(resp):
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Methods"] = "GET, HEAD, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Range, Content-Type"
    resp.headers["Access-Control-Expose-Headers"] = (
        "Content-Length, Content-Range, Content-Disposition, "
        "X-SSDA-Extension, X-SSDA-Format-Note"
    )
    return resp


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------

def validate_soundcloud_url(url: str) -> str:
    url = (url or "").strip()
    if not url:
        raise ApiError(400, "missing_url", "Pass a SoundCloud track link in the url= parameter.")
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ApiError(400, "invalid_url", "url must start with http:// or https://")
    host = (parsed.hostname or "").lower()
    if host not in ALLOWED_HOSTS:
        raise ApiError(400, "invalid_url", "url host must be a SoundCloud domain (soundcloud.com, on.soundcloud.com, snd.sc).")
    if parsed.username or parsed.password:
        raise ApiError(400, "invalid_url", "url must not contain credentials.")
    if parsed.port not in (None, 80, 443):
        raise ApiError(400, "invalid_url", "url must use the default http/https port.")
    return url


def sanitize_filename(name: str) -> str:
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "", name).strip(" .")
    name = re.sub(r"\s+", " ", name)
    return name[:120] or "track"


def track_id(url: str) -> str:
    return hashlib.sha1(url.encode("utf-8")).hexdigest()[:16]


def entry_lock(key: str) -> threading.Lock:
    with _locks_guard:
        lock = _entry_locks.get(key)
        if lock is None:
            lock = _entry_locks[key] = threading.Lock()
        return lock


def cache_lookup(key: str):
    meta_path = CACHE_DIR / f"{key}.json"
    bin_path = CACHE_DIR / f"{key}.bin"
    if meta_path.exists() and bin_path.exists():
        try:
            meta = json.loads(meta_path.read_text("utf-8"))
        except Exception:
            return None
        now = time.time()
        os.utime(meta_path, (now, now))
        return {"path": bin_path, "meta": meta, "key": key}
    return None


def cache_store(key: str, meta: dict, data: bytes):
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    (CACHE_DIR / f"{key}.bin").write_bytes(data)
    (CACHE_DIR / f"{key}.json").write_text(json.dumps(meta, ensure_ascii=False), "utf-8")
    prune_cache()


def prune_cache():
    bins = sorted(CACHE_DIR.glob("*.bin"), key=lambda p: p.stat().st_mtime, reverse=True)
    for stale in bins[CACHE_MAX:]:
        stale.unlink(missing_ok=True)
        (CACHE_DIR / f"{stale.stem}.json").unlink(missing_ok=True)


def cache_count() -> int:
    return len(list(CACHE_DIR.glob("*.bin"))) if CACHE_DIR.exists() else 0


# --------------------------------------------------------------------------
# demo mode (no network needed)
# --------------------------------------------------------------------------

def demo_audio(seed: str) -> tuple[bytes, dict]:
    """Generate a short tone chord whose pitch depends on the seed (the url)."""
    h = int(hashlib.sha256(seed.encode("utf-8")).hexdigest(), 16)
    root = 174.6 * (2 ** ((h % 17) / 12.0))
    chord = (1.0, 1.25, 1.5, 2.0)
    sr, dur = 22050, 8
    n = sr * dur
    frames = bytearray()
    sin = math.sin
    tau = 2.0 * math.pi
    for i in range(n):
        t = i / sr
        fade = min(1.0, t / 0.7, (dur - t) / 1.1)
        v = 0.0
        for k, ratio in enumerate(chord):
            v += sin(tau * root * ratio * t) * (0.24 / (k + 1))
        v += 0.03 * sin(tau * root * 4 * t) * sin(tau * 0.3 * t)
        sample = v * fade
        frames += struct.pack("<h", int(max(-1.0, min(1.0, sample)) * 31000))
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(bytes(frames))

    slug = urlparse(seed).path.rstrip("/").rsplit("/", 1)[-1]
    title = re.sub(r"[-_]+", " ", slug).strip().title() or "Demo track"
    info = {
        "id": track_id(seed),
        "title": title,
        "artist": "SSDA demo tone",
        "duration": dur,
        "artwork_url": None,
        "permalink_url": seed,
    }
    return buf.getvalue(), info


# --------------------------------------------------------------------------
# SoundCloud fetch (yt-dlp)
# --------------------------------------------------------------------------

def yt_dlp_fetch(url: str, fmt: str) -> tuple[bytes, dict, str, str, str | None]:
    """Download the track, return (data, info, ext, mime, format_note)."""
    if yt_dlp is None:
        raise ApiError(503, "yt_dlp_missing", "yt-dlp is not installed on the server.")

    tmpdir = Path(tempfile.mkdtemp(prefix="ssda-dl-"))
    try:
        opts = {
            "quiet": True,
            "no_warnings": True,
            "noplaylist": True,
            "format": FORMAT_SELECTOR.get(fmt, FORMAT_SELECTOR["auto"]),
            "outtmpl": str(tmpdir / "%(id)s.%(ext)s"),
            "cachedir": False,
            "socket_timeout": 30,
        }
        if fmt != "auto" and shutil.which("ffmpeg"):
            opts["postprocessors"] = [{
                "key": "FFmpegExtractAudio",
                "preferredcodec": fmt,
                "preferredquality": "0",
            }]
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(url, download=True)
        except yt_dlp.utils.DownloadError as err:
            raise ApiError(502, "fetch_failed", f"Could not fetch this track: {str(err)[:300]}")

        files = [p for p in tmpdir.iterdir() if p.is_file() and not p.name.endswith(".part")]
        if not files:
            raise ApiError(502, "fetch_failed", "The downloader produced no audio file.")
        path = max(files, key=lambda p: p.stat().st_size)

        requested = None
        try:
            requested = (info.get("requested_downloads") or [{}])[0].get("filepath")
        except Exception:
            pass
        if requested and Path(requested).exists():
            path = Path(requested)

        ext = path.suffix.lstrip(".").lower() or "bin"
        mime = MIME_BY_EXT.get(ext, "application/octet-stream")

        artist = info.get("artist") or info.get("uploader") or info.get("channel") or "Unknown artist"
        meta = {
            "id": info.get("id") or track_id(url),
            "title": info.get("title") or "Untitled",
            "artist": artist,
            "duration": info.get("duration"),
            "artwork_url": info.get("thumbnail"),
            "permalink_url": info.get("webpage_url") or url,
        }

        note = None
        if fmt != "auto" and ext != fmt:
            note = f"source format kept as .{ext} (requested {fmt}; install ffmpeg on the server to convert)"

        data = path.read_bytes()
        return data, meta, ext, mime, note
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def resolve_audio(url: str, fmt: str):
    key = hashlib.sha1(f"{url}|{fmt}".encode("utf-8")).hexdigest()
    with entry_lock(key):
        hit = cache_lookup(key)
        if hit:
            return hit

        if DEMO:
            data, info = demo_audio(url)
            ext, mime, note = "wav", "audio/wav", "demo tone generated by SSDA (no SoundCloud fetch)"
        else:
            data, info, ext, mime, note = yt_dlp_fetch(url, fmt)

        meta = {
            **info,
            "source_url": url,
            "requested_format": fmt,
            "ext": ext,
            "mime": mime,
            "size": len(data),
            "format_note": note,
            "saved_at": int(time.time()),
        }
        cache_store(key, meta, data)
        return {"path": CACHE_DIR / f"{key}.bin", "meta": meta, "key": key}


def filename_for(meta: dict) -> str:
    base = sanitize_filename(f"{meta.get('artist', 'Unknown')} - {meta.get('title', 'track')}")
    return f"{base}.{meta.get('ext', 'bin')}"


# --------------------------------------------------------------------------
# routes
# --------------------------------------------------------------------------

def service_index() -> dict:
    return {
        "name": SERVICE_NAME,
        "description": "SoundCloud song downloader API. Pass a track link to /api/audio and get the audio bytes back.",
        "version": VERSION,
        "demo": DEMO,
        "endpoints": {
            "/api/health": "GET - liveness and capabilities",
            "/api/info": "GET - ?url=<soundcloud-link> track metadata",
            "/api/audio": "GET - ?url=<soundcloud-link>&format=auto|m4a|mp3|opus audio bytes",
            "/api/download": "GET - same as /api/audio but saved as a file",
        },
    }


@app.route("/api")
def api_index():
    return jsonify(service_index())


@app.route("/api/health")
def health():
    return jsonify({
        "ok": True,
        "name": SERVICE_NAME,
        "version": VERSION,
        "demo": DEMO,
        "yt_dlp": YTDLP_VERSION,
        "ffmpeg": bool(shutil.which("ffmpeg")),
        "cached_tracks": cache_count(),
    })


@app.route("/api/info")
def info():
    url = validate_soundcloud_url(request.args.get("url", ""))
    if DEMO:
        _, meta = demo_audio(url)
        meta = {**meta, "source_url": url, "demo": True}
        return jsonify(meta)
    if yt_dlp is None:
        raise ApiError(503, "yt_dlp_missing", "yt-dlp is not installed on the server.")
    try:
        with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True, "noplaylist": True, "skip_download": True}) as ydl:
            data = ydl.extract_info(url, download=False)
    except yt_dlp.utils.DownloadError as err:
        raise ApiError(502, "fetch_failed", f"Could not resolve this track: {str(err)[:300]}")
    return jsonify({
        "id": data.get("id") or track_id(url),
        "title": data.get("title") or "Untitled",
        "artist": data.get("artist") or data.get("uploader") or data.get("channel") or "Unknown artist",
        "duration": data.get("duration"),
        "artwork_url": data.get("thumbnail"),
        "permalink_url": data.get("webpage_url") or url,
        "source_url": url,
    })


def _serve_audio(attachment: bool):
    url = validate_soundcloud_url(request.args.get("url", ""))
    fmt = request.args.get("format", "auto").lower()
    if fmt not in FORMAT_SELECTOR:
        raise ApiError(400, "invalid_format", f"format must be one of: {', '.join(FORMAT_SELECTOR)}")
    entry = resolve_audio(url, fmt)
    meta = entry["meta"]
    resp = send_file(
        entry["path"],
        mimetype=meta.get("mime", "application/octet-stream"),
        as_attachment=attachment,
        download_name=filename_for(meta),
        conditional=True,   # enables Range requests (seeking)
        max_age=0,
    )
    resp.headers["X-SSDA-Extension"] = meta.get("ext", "bin")
    if meta.get("format_note"):
        resp.headers["X-SSDA-Format-Note"] = str(meta["format_note"])[:200].encode("ascii", "replace").decode()
    return resp


@app.route("/api/audio")
def audio():
    return _serve_audio(attachment=False)


@app.route("/api/download")
def download():
    return _serve_audio(attachment=True)


@app.route("/", defaults={"p": ""})
@app.route("/<path:p>")
def static_or_index(p: str):
    if STATIC_DIR is None:
        return jsonify(service_index())
    root = STATIC_DIR.resolve()
    target = (root / p).resolve() if p else root / "index.html"
    if not str(target).startswith(str(root)):
        abort(404)
    if target.is_dir():
        target = target / "index.html"
    if not target.is_file():
        abort(404)
    return send_file(target)


# --------------------------------------------------------------------------

def main():
    global STATIC_DIR, DEMO
    parser = argparse.ArgumentParser(description="SSDA - SlopCloud Song Downloader API")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8000")))
    parser.add_argument("--static", help="serve a static site directory from / (e.g. ../site)")
    parser.add_argument("--demo", action="store_true", help="serve generated demo tones (no network)")
    args = parser.parse_args()

    if args.demo:
        DEMO = True
    if args.static:
        STATIC_DIR = Path(args.static).resolve()
        if not STATIC_DIR.is_dir():
            sys.exit(f"--static directory not found: {STATIC_DIR}")
    CACHE_DIR.mkdir(parents=True, exist_ok=True)

    print(f"{SERVICE_NAME} v{VERSION} | demo={DEMO} | cache={CACHE_DIR} | ffmpeg={'yes' if shutil.which('ffmpeg') else 'no'}")
    app.run(host=args.host, port=args.port, threaded=True)


if __name__ == "__main__":
    main()
