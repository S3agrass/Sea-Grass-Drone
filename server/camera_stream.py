"""
Seagrass camera stream — runs on the Raspberry Pi 5.

Captures from ArduCam via libcamerasrc (GStreamer) and pushes H.264 over RTSP
to a local MediaMTX instance. MediaMTX then serves the stream to remote
browsers via WebRTC (WHEP endpoint at http://<host>:8889/<STREAM_NAME>/whep).

Architecture:
    ArduCam → libcamerasrc → GStreamer H.264 pipeline → RTSP push → MediaMTX
    Browser  ← WebRTC (WHEP) ← MediaMTX

Setup (run once on the Pi):
    # 1. Install MediaMTX
    #    https://github.com/bluenviron/mediamtx/releases
    #    Unzip and run: ./mediamtx   (default config works out of the box)
    #
    # 2. Install GStreamer + plugins
    #    sudo apt install gstreamer1.0-tools gstreamer1.0-plugins-good \
    #                     gstreamer1.0-plugins-bad gstreamer1.0-libav \
    #                     gstreamer1.0-plugins-ugly
    #
    # 3. Install Tailscale for remote access (replaces Cloudflare Tunnel)
    #    curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up
    #    The Pi's Tailscale IP (100.x.x.x) goes in the fleet camera_url field:
    #    http://100.x.x.x:8889/cam/whep

Environment variables (all optional):
    MEDIAMTX_HOST      MediaMTX RTSP host       default: 127.0.0.1
    MEDIAMTX_RTSP_PORT MediaMTX RTSP port        default: 8554
    STREAM_NAME        Stream path in MediaMTX   default: cam
    CAM_WIDTH          Capture width (px)         default: 1280
    CAM_HEIGHT         Capture height (px)        default: 720
    CAM_FPS            Capture frame rate         default: 30
    CAM_BITRATE        H.264 bitrate (kbps)       default: 2000

Run standalone (for testing without drone_server.py):
    python3 camera_stream.py
"""

import os
import subprocess
import sys

MEDIAMTX_HOST = os.environ.get("MEDIAMTX_HOST", "127.0.0.1")
MEDIAMTX_RTSP_PORT = int(os.environ.get("MEDIAMTX_RTSP_PORT", "8554"))
STREAM_NAME = os.environ.get("STREAM_NAME", "cam")
WIDTH = int(os.environ.get("CAM_WIDTH", "1280"))
HEIGHT = int(os.environ.get("CAM_HEIGHT", "720"))
FPS = int(os.environ.get("CAM_FPS", "30"))
BITRATE = int(os.environ.get("CAM_BITRATE", "2000"))

RTSP_SINK = f"rtsp://{MEDIAMTX_HOST}:{MEDIAMTX_RTSP_PORT}/{STREAM_NAME}"

# GStreamer pipeline:
#   libcamerasrc  — reads from ArduCam via libcamera (Pi 5 / ArduCam IMX519 etc.)
#   videoconvert  — normalise colourspace before encoding
#   x264enc       — software H.264 encoder; swap for v4l2h264enc for Pi HW encoder
#   rtspclientsink — pushes encoded stream to MediaMTX over RTSP/TCP
#
# To use the Pi hardware encoder instead (lower CPU, slightly higher latency):
#   replace "x264enc tune=zerolatency ..." with:
#   "v4l2h264enc extra-controls=\"controls,repeat_sequence_header=1\""
GST_CMD = [
    "gst-launch-1.0", "-e",
    "libcamerasrc", "!",
    f"video/x-raw,width={WIDTH},height={HEIGHT},framerate={FPS}/1", "!",
    "videoconvert", "!",
    "x264enc", "tune=zerolatency", f"bitrate={BITRATE}", "speed-preset=ultrafast", "!",
    "video/x-h264,profile=baseline", "!",
    "rtspclientsink", f"location={RTSP_SINK}", "protocols=tcp",
]


def main():
    print(f"Seagrass camera: {WIDTH}x{HEIGHT}@{FPS}fps  →  {RTSP_SINK}")
    print(f"Browsers connect via WHEP:  http://{MEDIAMTX_HOST}:8889/{STREAM_NAME}/whep")
    try:
        subprocess.run(GST_CMD, check=True)
    except KeyboardInterrupt:
        pass
    except FileNotFoundError:
        print("gst-launch-1.0 not found — install gstreamer1.0-tools", file=sys.stderr)
        sys.exit(1)
    except subprocess.CalledProcessError as exc:
        print(f"GStreamer pipeline exited with code {exc.returncode}", file=sys.stderr)
        sys.exit(exc.returncode)


if __name__ == "__main__":
    main()
