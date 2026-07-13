# camera_stream.py
from picamera2 import Picamera2
from picamera2.encoders import MJPEGEncoder
from picamera2.outputs import FileOutput
import io
import os
import threading
import time
from http import server

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

PAGE = """
<html>
<head>
<title>Seagrass Live Feed</title>
<style>
    body { background: #0a0a0a; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    h1 { color: #00ff88; font-family: Arial; }
    img { border: 2px solid #00ff88; border-radius: 8px; }
</style>
</head>
<body>
<h1>Seagrass Camera Feed</h1>
<img src="stream.mjpg" width="640" height="480">
</body>
</html>
"""

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

class StreamHandler(server.BaseHTTPRequestHandler):
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

    def log_message(self, format, *args):
        pass  # suppresses terminal spam

output = StreamOutput(tap_path=DETECT_FRAME, tap_fps=DETECT_TAP_FPS)
camera = Picamera2()
camera.configure(camera.create_video_configuration(main={"size": (640, 480)}))
camera.start_recording(MJPEGEncoder(), FileOutput(output))

print("Stream live at http://raspberrypi.local:8000")
if DETECT_FRAME:
    print(f"Detection tap: latest frame -> {DETECT_FRAME} @ {DETECT_TAP_FPS:g}fps")
address = ('', 8000)
httpd = server.HTTPServer(address, StreamHandler)
httpd.serve_forever()