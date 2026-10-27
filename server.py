"""Beatcut local server: serves the app and finds character clips on YouTube with yt-dlp.

    .venv\\Scripts\\python server.py       ->  http://localhost:8796

GET /api/ping                    -> {"ok": true}
GET /api/clips/search?q=thorfinn -> clip packs made for editors ("<name> scene pack", "raw clips")
GET /api/clips/fetch?id=VIDEOID  -> starts a download (720p max), returns status
GET /api/clips/status?id=VIDEOID -> {"state": "downloading" | "done" | "error", "progress": 0..1}
GET /cache/VIDEOID.mp4           -> the downloaded file
GET /api/clips/search?q=thorfinn&kind=dialogue -> English dub scenes (for a spoken intro line)
GET /api/transcribe?id=VIDEOID   -> what's said and when (Whisper, word timings; translated to English)
"""
import json
import re
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import subprocess

import imageio_ffmpeg
import numpy as np
import yt_dlp

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / "cache"
CACHE.mkdir(exist_ok=True)
VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
MAX_SECONDS = 900  # skip anything longer: whole files download fast, partial ones crawl
jobs = {}  # video id -> {"state", "progress", "error"}
lock = threading.Lock()


QUERIES = {
    "clips": ("{} scene pack", "{} raw clips for edits"),
    "dialogue": ("{} english dub fight", "{} english dub scene"),
}


def search(q, kind="clips"):
    seen, out = set(), []
    with yt_dlp.YoutubeDL({"quiet": True, "extract_flat": True, "skip_download": True}) as y:
        for query in (t.format(q) for t in QUERIES[kind]):
            for e in y.extract_info(f"ytsearch10:{query}", download=False).get("entries") or []:
                dur = e.get("duration") or 0
                if not e.get("id") or e["id"] in seen or not 15 <= dur <= MAX_SECONDS:
                    continue
                seen.add(e["id"])
                out.append({
                    "id": e["id"], "title": e.get("title") or "", "duration": dur,
                    "channel": e.get("channel") or e.get("uploader") or "",
                    "thumb": f"https://i.ytimg.com/vi/{e['id']}/mqdefault.jpg",
                    "page": f"https://www.youtube.com/watch?v={e['id']}",
                })
    return out


def download(vid):
    def hook(d):
        total = d.get("total_bytes") or d.get("total_bytes_estimate")
        if d.get("status") == "downloading" and total:
            jobs[vid]["progress"] = min(0.99, (d.get("downloaded_bytes") or 0) / total)

    opts = {
        "format": "bv*[height<=720][vcodec^=avc1]+ba[ext=m4a]/b[height<=720][ext=mp4]/bv*[height<=720]+ba/b",
        "merge_output_format": "mp4", "outtmpl": str(CACHE / "%(id)s.%(ext)s"), "noplaylist": True,
        "quiet": True, "no_warnings": True, "ffmpeg_location": imageio_ffmpeg.get_ffmpeg_exe(),
        "progress_hooks": [hook],
    }
    try:
        with yt_dlp.YoutubeDL(opts) as y:
            y.download([f"https://www.youtube.com/watch?v={vid}"])
        jobs[vid].update(state="done", progress=1)
    except Exception as e:  # report to the page instead of dying silently
        jobs[vid].update(state="error", error=str(e).splitlines()[-1][:200])


whisper = {}


def transcribe(vid):
    """Segments with word timings, cached next to the video. Speech in other languages is
    translated to English (the captions are English either way)."""
    out = CACHE / f"{vid}.json"
    if out.exists():
        return json.loads(out.read_text(encoding="utf-8"))
    with lock:
        if "model" not in whisper:
            from faster_whisper import WhisperModel  # first use downloads the model (~150 MB)
            whisper["model"] = WhisperModel("base", device="cpu", compute_type="int8")
    pcm = subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-v", "error", "-i", str(CACHE / f"{vid}.mp4"),
                          "-ac", "1", "-ar", "16000", "-f", "f32le", "-"], capture_output=True, check=True).stdout
    segs, info = whisper["model"].transcribe(np.frombuffer(pcm, np.float32), task="translate",
                                             vad_filter=True, word_timestamps=True)
    data = {"language": info.language, "segments": [
        {"start": s.start, "end": s.end, "text": s.text.strip(), "logprob": s.avg_logprob,
         "words": [[w.start, w.end, w.word.strip()] for w in (s.words or [])]}
        for s in segs]}
    out.write_text(json.dumps(data), encoding="utf-8")
    return data


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def log_message(self, *a):
        pass

    def send_json(self, data, code=200):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urlparse(self.path)
        if not url.path.startswith("/api/"):
            return super().do_GET()
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        if url.path == "/api/ping":
            return self.send_json({"ok": True})
        if url.path == "/api/clips/search":
            if not q.get("q", "").strip():
                return self.send_json({"error": "missing q"}, 400)
            try:
                kind = q.get("kind", "clips") if q.get("kind") in QUERIES else "clips"
                return self.send_json({"results": search(q["q"].strip()[:100], kind)})
            except Exception as e:
                return self.send_json({"error": str(e).splitlines()[-1][:200]}, 502)
        vid = q.get("id", "")
        if not VIDEO_ID.match(vid):
            return self.send_json({"error": "bad id"}, 400)
        if url.path == "/api/clips/fetch":
            with lock:
                if (CACHE / f"{vid}.mp4").exists():
                    jobs[vid] = {"state": "done", "progress": 1}
                elif jobs.get(vid, {}).get("state") != "downloading":
                    jobs[vid] = {"state": "downloading", "progress": 0}
                    threading.Thread(target=download, args=(vid,), daemon=True).start()
            return self.send_json(jobs[vid])
        if url.path == "/api/clips/status":
            return self.send_json(jobs.get(vid, {"state": "unknown"}))
        if url.path == "/api/transcribe":
            if not (CACHE / f"{vid}.mp4").exists():
                return self.send_json({"error": "download it first"}, 404)
            try:
                return self.send_json(transcribe(vid))
            except Exception as e:
                return self.send_json({"error": str(e).splitlines()[-1][:200]}, 500)
        self.send_json({"error": "not found"}, 404)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8796
    print(f"Beatcut on http://localhost:{port}")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
