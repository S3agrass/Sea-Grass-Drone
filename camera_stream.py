# camera_stream.py
from picamera2 import Picamera2
from picamera2.encoders import MJPEGEncoder
from picamera2.outputs import FileOutput
import io
import threading
from http import server

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
    def __init__(self):
        self.frame = None
        self.condition = threading.Condition()

    def write(self, buf):
        with self.condition:
            self.frame = buf
            self.condition.notify_all()

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

output = StreamOutput()
camera = Picamera2()
camera.configure(camera.create_video_configuration(main={"size": (640, 480)}))
camera.start_recording(MJPEGEncoder(), FileOutput(output))

print("Stream live at http://raspberrypi.local:8000")
address = ('', 8000)
httpd = server.HTTPServer(address, StreamHandler)
httpd.serve_forever()