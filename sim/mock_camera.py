#!/usr/bin/env python3
"""Mock of the Pi's camera_stream.py for LOCAL testing (no camera hardware).

Serves the same HTTP surface as the real camera_stream.py so the GCS UI can be
driven end-to-end on a laptop:
  GET  /                     test page
  GET  /stream.mjpg          synthetic MJPEG stream (PIL-drawn moving frames)
  GET  /health               {"status","streaming"}
  GET  /record/status        {"recording","started_at","elapsed_s","current_file"}
  POST /record/start|stop    toggles an in-memory recording, writes a .mp4 stub
  POST /photo                writes a .jpg to the media dir
  GET  /media                list media
  GET  /media/<name>         download
  DELETE /media/<name>       delete
Mutations honour SEAGRASS_TOKEN (Bearer) when set, like the real server.

This reproduces the wire contract only — it does not use picamera2.
"""
import io
import json
import os
import threading
import time
from http import server
from urllib.parse import unquote

from PIL import Image, ImageDraw

PORT = int(os.environ.get("MOCK_CAMERA_PORT", "8000"))
MEDIA_DIR = os.environ.get("MOCK_MEDIA_DIR", os.path.join(os.path.dirname(__file__), "media"))
TOKEN = os.environ.get("SEAGRASS_TOKEN", "")
W, H = 640, 480
MEDIA_TYPES = {".mp4": "video/mp4", ".jpg": "image/jpeg"}

os.makedirs(MEDIA_DIR, exist_ok=True)

# RLock: _start/_stop hold the lock and then call _status(), which re-acquires it.
_rec = {"recording": False, "started_at": None, "file": None}
_lock = threading.RLock()

PAGE = b"<!doctype html><html><body style='background:#0a0a0a'><img src='stream.mjpg' width='640'></body></html>"


def make_frame(n):
    """A distinctly 'live' frame: cycling hue bar, a moving box, frame counter,
    and wall-clock — so a screenshot proves the stream is actually updating."""
    hue = (n * 4) % 360
    img = Image.new("RGB", (W, H), _hsv(hue, 0.35, 0.18))
    d = ImageDraw.Draw(img)
    # moving box
    x = (n * 6) % (W - 80)
    d.rectangle([x, 200, x + 80, 280], fill=_hsv((hue + 120) % 360, 0.7, 0.9))
    d.text((20, 20), "SIM CAMERA (mock)", fill=(0, 255, 136))
    d.text((20, 40), f"frame {n}", fill=(220, 230, 242))
    d.text((20, 60), time.strftime("%H:%M:%S"), fill=(220, 230, 242))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=70)
    return buf.getvalue()


def _hsv(h, s, v):
    import colorsys
    r, g, b = colorsys.hsv_to_rgb(h / 360.0, s, v)
    return (int(r * 255), int(g * 255), int(b * 255))


def safe_media_path(name):
    name = os.path.basename(unquote(name))
    if not name or os.path.splitext(name)[1].lower() not in MEDIA_TYPES:
        return None
    path = os.path.join(MEDIA_DIR, name)
    if os.path.dirname(os.path.abspath(path)) != os.path.abspath(MEDIA_DIR):
        return None
    return path


class Handler(server.BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")

    def _authed(self):
        if not TOKEN:
            return True
        return self.headers.get("Authorization", "") == f"Bearer {TOKEN}"

    def _json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path == "/":
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(PAGE)
        elif self.path == "/stream.mjpg":
            self.send_response(200)
            self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=FRAME")
            self._cors()
            self.end_headers()
            n = 0
            try:
                while True:
                    frame = make_frame(n)
                    n += 1
                    self.wfile.write(b"--FRAME\r\n")
                    self.send_header("Content-Type", "image/jpeg")
                    self.send_header("Content-Length", str(len(frame)))
                    self.end_headers()
                    self.wfile.write(frame)
                    self.wfile.write(b"\r\n")
                    time.sleep(1 / 15)
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
        elif self.path == "/health":
            self._json({"status": "ok", "streaming": True})
        elif self.path == "/record/status":
            self._json(self._status())
        elif self.path == "/media":
            self._json({"media": self._list()})
        elif self.path.startswith("/media/"):
            self._serve(self.path[len("/media/"):])
        else:
            self.send_error(404)

    def do_POST(self):
        if not self._authed():
            return self._json({"error": "unauthorized"}, 401)
        if self.path == "/record/start":
            self._json(self._start())
        elif self.path == "/record/stop":
            self._json(self._stop())
        elif self.path == "/photo":
            name = self._photo()
            self._json({"name": name, "url": f"/media/{name}"})
        else:
            self.send_error(404)

    def do_DELETE(self):
        if not self._authed():
            return self._json({"error": "unauthorized"}, 401)
        if self.path.startswith("/media/"):
            path = safe_media_path(self.path[len("/media/"):])
            if not path or not os.path.isfile(path):
                return self._json({"error": "not found"}, 404)
            os.remove(path)
            self._json({"deleted": os.path.basename(path)})
        else:
            self.send_error(404)

    # ---- recording / media ops ----
    def _status(self):
        with _lock:
            r = _rec["recording"]
            return {
                "recording": r,
                "started_at": _rec["started_at"],
                "elapsed_s": (time.time() - _rec["started_at"]) if r else 0,
                "current_file": _rec["file"],
            }

    def _start(self):
        with _lock:
            if not _rec["recording"]:
                _rec.update(recording=True, started_at=time.time(),
                            file=f"rec-{time.strftime('%Y%m%d-%H%M%S')}.mp4")
            return self._status()

    def _stop(self):
        with _lock:
            if _rec["recording"]:
                # write a tiny placeholder mp4 so the gallery has something to list
                path = os.path.join(MEDIA_DIR, _rec["file"])
                with open(path, "wb") as fh:
                    fh.write(b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 64)
                _rec.update(recording=False, started_at=None, file=None)
            return self._status()

    def _photo(self):
        name = f"photo-{time.strftime('%Y%m%d-%H%M%S')}.jpg"
        with open(os.path.join(MEDIA_DIR, name), "wb") as fh:
            fh.write(make_frame(0))
        return name

    def _list(self):
        items = []
        for name in os.listdir(MEDIA_DIR):
            ext = os.path.splitext(name)[1].lower()
            if ext not in MEDIA_TYPES:
                continue
            st = os.stat(os.path.join(MEDIA_DIR, name))
            items.append({
                "name": name,
                "type": "video" if ext == ".mp4" else "photo",
                "size": st.st_size,
                "mtime": st.st_mtime,
                "url": f"/media/{name}",
            })
        items.sort(key=lambda m: m["mtime"], reverse=True)
        return items

    def _serve(self, name):
        path = safe_media_path(name)
        if not path or not os.path.isfile(path):
            return self.send_error(404)
        ext = os.path.splitext(path)[1].lower()
        data = open(path, "rb").read()
        self.send_response(200)
        self.send_header("Content-Type", MEDIA_TYPES[ext])
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Content-Disposition", f'attachment; filename="{os.path.basename(path)}"')
        self._cors()
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    httpd = server.ThreadingHTTPServer(("", PORT), Handler)
    print(f"mock camera on http://localhost:{PORT}  (media: {MEDIA_DIR}, token={'set' if TOKEN else 'none'})")
    httpd.serve_forever()
