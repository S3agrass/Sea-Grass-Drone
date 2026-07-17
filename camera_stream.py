# camera_stream.py
from picamera2 import Picamera2
from picamera2.encoders import MJPEGEncoder, H264Encoder
from picamera2.outputs import FileOutput, FfmpegOutput
import io
import json
import os
import signal
import sys
import threading
import time
from http import server
from urllib.parse import unquote

# Detection frame tap: MJPEGEncoder hands StreamOutput.write() a fully-encoded
# JPEG for every captured frame. In addition to fanning those out to browsers,
# we drop the latest frame onto a single "slot" file that server/vision/detector.py
# polls (via os.path.getmtime + cv2.imread). Because the encoder already gives us
# JPEG bytes, the tap is a raw byte copy — no decode/re-encode — so it costs
# almost nothing and does not touch the streaming path's latency.
#
#   DETECT_FRAME    JPEG slot the detector reads. Default matches detector.py's
#                   own default. Set to empty ("") to disable the tap entirely.
#   DETECT_TAP_FPS  How often (Hz) to refresh the slot. The detector polls at 5.
DETECT_FRAME = os.environ.get("DETECT_FRAME", "/tmp/seagrass-detect-frame.jpg")
DETECT_TAP_FPS = float(os.environ.get("DETECT_TAP_FPS", "5"))

# Capture configuration. (server/camera_stream.py — the MediaMTX pusher — uses
# CAM_* names; these are CAMERA_* so the two scripts' configs stay independent.)
#
#   CAMERA_WIDTH    Capture width (px)    default: 640
#   CAMERA_HEIGHT   Capture height (px)   default: 480
#   CAMERA_FPS      Frame rate; unset leaves Picamera2's own default untouched
CAMERA_WIDTH = int(os.environ.get("CAMERA_WIDTH", "640"))
CAMERA_HEIGHT = int(os.environ.get("CAMERA_HEIGHT", "480"))
CAMERA_FPS = os.environ.get("CAMERA_FPS", "")

# Recording / media storage.
#   MEDIA_DIR      Where photos + recordings are written on the SD card. These
#                  survive an autonomous run with no operator connected — the
#                  recorder is a second encoder on the same camera pipeline, so
#                  it keeps writing regardless of whether anyone is streaming.
#   REC_BITRATE    H.264 bitrate for recordings (bits/s).
#   SEAGRASS_TOKEN Shared secret; when set, the mutating endpoints (record/photo/
#                  delete) require an "Authorization: Bearer <token>" header, so an
#                  open :8000 can't be used to wipe media. Empty = LAN-trust mode
#                  (matches drone_server.py's auth model).
MEDIA_DIR = os.environ.get("MEDIA_DIR", os.path.expanduser("~/seagrass-media"))
REC_BITRATE = int(os.environ.get("REC_BITRATE", "4000000"))
TOKEN = os.environ.get("SEAGRASS_TOKEN", "")

os.makedirs(MEDIA_DIR, exist_ok=True)

# Recognised media extensions, mapped to the Content-Type used for downloads.
MEDIA_TYPES = {".mp4": "video/mp4", ".jpg": "image/jpeg"}

# No '%' may appear in this template except the two size placeholders.
PAGE = """\
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Seagrass Live Feed</title>
<style>
    body { background: #0a0a0a; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    h1 { color: #00ff88; font-family: Arial; }
    img { border: 2px solid #00ff88; border-radius: 8px; }
</style>
</head>
<body>
<h1>Seagrass Camera Feed</h1>
<img src="stream.mjpg" width="%d" height="%d">
</body>
</html>
""" % (CAMERA_WIDTH, CAMERA_HEIGHT)

class StreamOutput(io.BufferedIOBase):
    def __init__(self, tap_path="", tap_fps=5.0):
        self.frame = None
        self.condition = threading.Condition()
        # Detector frame tap (see module header). Empty tap_path disables it.
        self.tap_path = tap_path
        self.tap_interval = 1.0 / tap_fps if tap_fps > 0 else 0.0
        # Write to a sibling temp file then os.replace() — an atomic rename on
        # the same filesystem — so the detector never cv2.imread()s a half-written
        # JPEG. PID-suffixed so two camera processes can't clobber each other.
        self.tap_tmp = f"{tap_path}.tmp.{os.getpid()}" if tap_path else ""
        self._last_tap = 0.0

    def write(self, buf):
        # Serve the streaming clients first and get off the lock immediately;
        # the tap write below then happens outside the condition so disk I/O
        # can never stall an MJPEG viewer.
        with self.condition:
            self.frame = buf
            self.condition.notify_all()
        self._maybe_tap(buf)

    def _maybe_tap(self, buf):
        if not self.tap_path:
            return
        now = time.monotonic()
        if now - self._last_tap < self.tap_interval:
            return
        self._last_tap = now
        try:
            with open(self.tap_tmp, "wb") as fh:
                fh.write(buf)
            # close() above flushed the full JPEG to the OS; replace is atomic.
            os.replace(self.tap_tmp, self.tap_path)
        except OSError:
            pass  # a transient FS hiccup must never kill the live stream


# ---------------- recording ----------------
# A second encoder (H.264 -> mp4 via ffmpeg) runs off the same camera as the
# MJPEG stream. Picamera2 supports multiple simultaneous encoders, so recording
# and live-viewing are fully independent: the recorder keeps writing even with no
# streaming client, which is exactly what an autonomous underwater run needs.
class Recorder:
    def __init__(self, camera):
        self.camera = camera
        self.lock = threading.Lock()
        self.encoder = None
        self.output = None
        self.started_at = None
        self.file = None

    def is_recording(self):
        return self.encoder is not None

    def _timestamp(self):
        return time.strftime("%Y%m%d-%H%M%S", time.gmtime())

    def start(self):
        with self.lock:
            if self.encoder is not None:
                return self.status_locked()
            name = f"rec-{self._timestamp()}.mp4"
            path = os.path.join(MEDIA_DIR, name)
            encoder = H264Encoder(bitrate=REC_BITRATE)
            output = FfmpegOutput(path)
            # Adds a second encoder to the already-running camera; the MJPEG
            # stream encoder is untouched.
            self.camera.start_encoder(encoder, output)
            self.encoder = encoder
            self.output = output
            self.file = name
            self.started_at = time.time()
            return self.status_locked()

    def stop(self):
        with self.lock:
            if self.encoder is None:
                return self.status_locked()
            try:
                # Stops just this encoder (and finalises the mp4 via ffmpeg),
                # leaving the MJPEG stream encoder running.
                self.camera.stop_encoder(self.encoder)
            except Exception:  # noqa: BLE001
                pass
            self.encoder = None
            self.output = None
            self.started_at = None
            self.file = None
            return self.status_locked()

    def status(self):
        with self.lock:
            return self.status_locked()

    def status_locked(self):
        recording = self.encoder is not None
        return {
            "recording": recording,
            "started_at": self.started_at,
            "elapsed_s": (time.time() - self.started_at) if self.started_at else 0,
            "current_file": self.file,
        }


def capture_photo():
    """Save the latest streamed JPEG frame straight to disk. Reusing the already-
    encoded frame means a snapshot never interrupts the live stream or recording."""
    frame = output.frame
    if not frame:
        return None
    name = f"photo-{time.strftime('%Y%m%d-%H%M%S', time.gmtime())}.jpg"
    path = os.path.join(MEDIA_DIR, name)
    try:
        with open(path, "wb") as fh:
            fh.write(frame)
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
    # Newest first.
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


class StreamHandler(server.BaseHTTPRequestHandler):
    # ---- helpers ----
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

    # ---- verbs ----
    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path == '/':
            self.send_response(200)
            self.send_header('Content-Type', 'text/html')
            self.end_headers()
            self.wfile.write(PAGE.encode('utf-8'))
        elif self.path == '/stream.mjpg':
            self.send_response(200)
            self.send_header('Content-Type', 'multipart/x-mixed-replace; boundary=FRAME')
            self.end_headers()
            try:
                while True:
                    with output.condition:
                        output.condition.wait()
                        frame = output.frame
                    self.wfile.write(b'--FRAME\r\n')
                    self.send_header('Content-Type', 'image/jpeg')
                    self.send_header('Content-Length', len(frame))
                    self.end_headers()
                    self.wfile.write(frame)
                    self.wfile.write(b'\r\n')
            except Exception:
                pass
        elif self.path == '/health':
            self._send_json({"status": "ok", "streaming": output.frame is not None})
        elif self.path == '/record/status':
            self._send_json(recorder.status())
        elif self.path == '/media':
            # Read-only listing; left open so a plain <a download> link works.
            self._send_json({"media": list_media()})
        elif self.path.startswith('/media/'):
            self._serve_media(self.path[len('/media/'):])
        else:
            self.send_error(404)

    def do_POST(self):
        if not self._authed():
            return self._deny()
        if self.path == '/record/start':
            self._send_json(recorder.start())
        elif self.path == '/record/stop':
            self._send_json(recorder.stop())
        elif self.path == '/photo':
            name = capture_photo()
            if name:
                self._send_json({"name": name, "url": f"/media/{name}"})
            else:
                self._send_json({"error": "no frame available"}, status=503)
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

output = StreamOutput(tap_path=DETECT_FRAME, tap_fps=DETECT_TAP_FPS)
try:
    camera = Picamera2()
    controls = {"FrameRate": float(CAMERA_FPS)} if CAMERA_FPS else {}
    camera.configure(camera.create_video_configuration(
        main={"size": (CAMERA_WIDTH, CAMERA_HEIGHT)}, controls=controls))
    camera.start_recording(MJPEGEncoder(), FileOutput(output))
except Exception as exc:
    print(f"Camera init failed ({exc}) — check the ribbon cable is seated, the camera "
          "appears in `libcamera-hello --list-cameras`, and no other process "
          "(e.g. server/camera_stream.py) is already using it", file=sys.stderr)
    sys.exit(1)

recorder = Recorder(camera)

print("Stream live at http://raspberrypi.local:8000")
print(f"Media dir: {MEDIA_DIR}")
if DETECT_FRAME:
    print(f"Detection tap: latest frame -> {DETECT_FRAME} @ {DETECT_TAP_FPS:g}fps")
address = ('', 8000)
# ThreadingHTTPServer: each request gets its own daemon thread, so multiple
# viewers and /health checks never block each other (or process exit).
httpd = server.ThreadingHTTPServer(address, StreamHandler)

# systemd `stop` sends SIGTERM; turn it into SystemExit so it unwinds
# serve_forever() the same way Ctrl+C's KeyboardInterrupt does. (Calling
# httpd.shutdown() from a handler on this thread would deadlock — it blocks
# until serve_forever() returns, and serve_forever() is paused beneath us.)
signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))

try:
    httpd.serve_forever()
except KeyboardInterrupt:
    pass
finally:
    # Finalise any in-progress recording (flushes the mp4 via ffmpeg) before the
    # camera goes down, so a clip is never left truncated on shutdown.
    recorder.stop()
    camera.stop_recording()
    httpd.server_close()
    print("Camera stream stopped cleanly")
