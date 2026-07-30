"""
Seagrass media server — runs on the Raspberry Pi 5, alongside (not inside) the
camera process.

The WebRTC camera path (server/camera_stream.py -> GStreamer -> MediaMTX) only
ever pushes video to MediaMTX; it has no HTTP server of its own, unlike the
legacy MJPEG camera_stream.py which bundled photo capture, recording, and media
browsing into the same process as the video feed. This script splits that
media-facing half out into its own always-on process, independent of whether
the camera pipeline is currently running, so the Media page keeps working
regardless of camera state, and drone_server.py's existing /photo, /media
calls (CAMERA_HTTP) need no changes at all — they just now reach this process
instead of the old combined one.

Recording is NOT implemented here. The GStreamer pipeline only produces a
live RTSP push to MediaMTX and a low-fps JPEG snapshot tap (see
server/camera_stream.py's SNAPSHOT_FRAME) — there is no second on-Pi H.264
encoder to draw an mp4 from, unlike Picamera2's dual-encoder setup. /record/start
and /record/stop both return 501 so callers get a clear, immediate answer
instead of a silent no-op. Revisit if/when MediaMTX's own recording feature
(or a real second encoder) is wired up.

Environment variables:
    MEDIA_HTTP_PORT   Port to listen on                default: 8000
    MEDIA_DIR         Where photos/recordings live      default: ~/seagrass-media
    SNAPSHOT_FRAME    JPEG file camera_stream.py's snapshot tap continuously
                      overwrites; /photo copies whatever is there right now.
                      default: /tmp/seagrass-camera-snapshot.jpg
    SEAGRASS_TOKEN    Shared secret for mutating endpoints (photo/delete).
                      Empty = LAN-trust mode (matches drone_server.py).
    TURN_KEY_ID           Cloudflare Realtime TURN key ID.
    TURN_KEY_API_TOKEN    Its secret — never sent to the browser; kept here,
                           server-side, to mint short-lived credentials per
                           /turn-credentials request. Both unset = no TURN
                           (browser falls back to STUN-only, which doesn't
                           traverse most home routers' NAT for inbound video).

Run standalone (for testing without drone_server.py):
    python3 server/media_server.py
"""

import json
import os
import shutil
import time
import urllib.error
import urllib.request
from http import server
from urllib.parse import unquote

MEDIA_HTTP_PORT = int(os.environ.get("MEDIA_HTTP_PORT", "8000"))
MEDIA_DIR = os.environ.get("MEDIA_DIR", os.path.expanduser("~/seagrass-media"))
SNAPSHOT_FRAME = os.environ.get("SNAPSHOT_FRAME", "/tmp/seagrass-camera-snapshot.jpg")
TOKEN = os.environ.get("SEAGRASS_TOKEN", "")

# Cloudflare Realtime TURN — see module docstring. Short-lived (1 hour) so a
# leaked credential from a single /turn-credentials response is only useful
# for about as long as the viewing session it was minted for.
TURN_KEY_ID = os.environ.get("TURN_KEY_ID", "")
TURN_KEY_API_TOKEN = os.environ.get("TURN_KEY_API_TOKEN", "")
TURN_TTL_S = 3600

# Used when TURN isn't configured (or its API call fails) — STUN only helps
# the browser discover its own public address; it does not traverse a router
# that blocks unsolicited inbound UDP, so this is a degraded-but-not-broken
# fallback rather than a real fix.
_STUN_FALLBACK = {"iceServers": [{"urls": "stun:stun.l.google.com:19302"}]}


def _fetch_turn_credentials():
    if not (TURN_KEY_ID and TURN_KEY_API_TOKEN):
        return _STUN_FALLBACK
    req = urllib.request.Request(
        f"https://rtc.live.cloudflare.com/v1/turn/keys/{TURN_KEY_ID}/credentials/generate-ice-servers",
        method="POST",
        data=json.dumps({"ttl": TURN_TTL_S}).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {TURN_KEY_API_TOKEN}",
            "Content-Type": "application/json",
            # Cloudflare's edge blocks requests carrying urllib's default
            # "Python-urllib/x.y" User-Agent as a bot signature (403, even with
            # valid credentials) — curl sails through with its own default UA.
            "User-Agent": "seagrass-drone/1.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError) as exc:
        print(f"TURN credential fetch failed, falling back to STUN-only: {exc}")
        return _STUN_FALLBACK

os.makedirs(MEDIA_DIR, exist_ok=True)

MEDIA_TYPES = {".mp4": "video/mp4", ".jpg": "image/jpeg"}


def capture_photo():
    """Copy whatever camera_stream.py's snapshot tap most recently wrote.
    Returns the new filename, or None if no snapshot exists yet (camera just
    started, or isn't running at all)."""
    if not os.path.isfile(SNAPSHOT_FRAME):
        return None
    name = f"photo-{time.strftime('%Y%m%d-%H%M%S', time.gmtime())}.jpg"
    path = os.path.join(MEDIA_DIR, name)
    try:
        # Copy rather than move — the tap file is being continuously
        # overwritten by GStreamer and must stay in place for the next shot.
        shutil.copyfile(SNAPSHOT_FRAME, path)
    except OSError:
        return None
    return name


def list_media():
    items = []
    try:
        names = os.listdir(MEDIA_DIR)
    except OSError:
        names = []
    for name in names:
        ext = os.path.splitext(name)[1].lower()
        if ext not in MEDIA_TYPES:
            continue
        path = os.path.join(MEDIA_DIR, name)
        try:
            st = os.stat(path)
        except OSError:
            continue
        items.append({
            "name": name,
            "type": "video" if ext == ".mp4" else "photo",
            "size": st.st_size,
            "mtime": st.st_mtime,
            "url": f"/media/{name}",
        })
    items.sort(key=lambda m: m["mtime"], reverse=True)
    return items


def safe_media_path(name):
    """Resolve a request path segment to a file inside MEDIA_DIR, or None if it
    escapes the directory (path traversal) or isn't a recognised media file."""
    name = os.path.basename(unquote(name))
    if not name or os.path.splitext(name)[1].lower() not in MEDIA_TYPES:
        return None
    path = os.path.join(MEDIA_DIR, name)
    if os.path.dirname(os.path.abspath(path)) != os.path.abspath(MEDIA_DIR):
        return None
    return path


class MediaHandler(server.BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")

    def _authed(self):
        if not TOKEN:
            return True  # LAN-trust mode
        header = self.headers.get("Authorization", "")
        return header == f"Bearer {TOKEN}"

    def _send_json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _deny(self):
        self._send_json({"error": "unauthorized"}, status=401)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path == '/health':
            self._send_json({"status": "ok"})
        elif self.path == '/turn-credentials':
            self._send_json(_fetch_turn_credentials())
        elif self.path == '/media':
            self._send_json({"media": list_media()})
        elif self.path.startswith('/media/'):
            self._serve_media(self.path[len('/media/'):])
        else:
            self.send_error(404)

    def do_POST(self):
        if not self._authed():
            return self._deny()
        if self.path == '/photo':
            name = capture_photo()
            if name:
                self._send_json({"name": name, "url": f"/media/{name}"})
            else:
                self._send_json({"error": "no snapshot available yet"}, status=503)
        elif self.path in ('/record/start', '/record/stop'):
            self._send_json(
                {"error": "recording is not supported on the WebRTC camera path"},
                status=501,
            )
        else:
            self.send_error(404)

    def do_DELETE(self):
        if not self._authed():
            return self._deny()
        if self.path.startswith('/media/'):
            path = safe_media_path(self.path[len('/media/'):])
            if not path or not os.path.isfile(path):
                return self._send_json({"error": "not found"}, status=404)
            try:
                os.remove(path)
            except OSError as exc:
                return self._send_json({"error": str(exc)}, status=500)
            self._send_json({"deleted": os.path.basename(path)})
        else:
            self.send_error(404)

    def _serve_media(self, name):
        path = safe_media_path(name)
        if not path or not os.path.isfile(path):
            return self.send_error(404)
        ext = os.path.splitext(path)[1].lower()
        try:
            size = os.path.getsize(path)
            with open(path, "rb") as fh:
                self.send_response(200)
                self.send_header("Content-Type", MEDIA_TYPES[ext])
                self.send_header("Content-Length", str(size))
                self.send_header(
                    "Content-Disposition",
                    f'attachment; filename="{os.path.basename(path)}"',
                )
                self._cors()
                self.end_headers()
                while True:
                    chunk = fh.read(64 * 1024)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        except (OSError, BrokenPipeError):
            pass

    def log_message(self, format, *args):
        pass  # suppresses terminal spam


def main():
    address = ('', MEDIA_HTTP_PORT)
    httpd = server.ThreadingHTTPServer(address, MediaHandler)
    print(f"Media server listening on http://0.0.0.0:{MEDIA_HTTP_PORT}  (dir={MEDIA_DIR})")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
