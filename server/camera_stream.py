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

Detection frame tap (all optional — only active when DETECT_FRAME is set):
    DETECT_FRAME       JPEG "latest frame" slot the detector reads
                       (e.g. /tmp/seagrass-detect-frame.jpg). Unset = no tap.
    DETECT_TAP_SIZE    Square size of the tapped frames (px)   default: 320
    DETECT_TAP_FPS     Frame-rate of the tap branch            default: 5

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

# Detection frame tap: when DETECT_FRAME is set, a second (low-res, low-fps)
# GStreamer branch is teed off the same camera source and continuously
# overwrites a single JPEG file that the detector polls. libcamera only lets one
# process hold the camera, so tapping the existing pipeline is how the detector
# gets frames without opening a second capture. The operator's H.264 branch is
# untouched, so this adds no latency to the live video.
DETECT_FRAME = os.environ.get("DETECT_FRAME", "")
DETECT_TAP_SIZE = int(os.environ.get("DETECT_TAP_SIZE", "320"))
DETECT_TAP_FPS = int(os.environ.get("DETECT_TAP_FPS", "5"))

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
def build_gst_cmd():
    """Build the GStreamer pipeline.

    Without DETECT_FRAME it is a single H.264 branch to MediaMTX (unchanged
    original behaviour). With DETECT_FRAME set, a `tee` fans the camera source
    into that same H.264 branch plus a low-res JPEG branch whose `multifilesink
    max-files=1` continuously overwrites one file — the detector's frame slot.
    """
    src = [
        "libcamerasrc", "!",
        f"video/x-raw,format=NV12,width={WIDTH},height={HEIGHT},framerate={FPS}/1", "!",
    ]
    h264_branch = [
        "videoconvert", "!",
        "x264enc", "tune=zerolatency", f"bitrate={BITRATE}", "speed-preset=ultrafast", "!",
        "video/x-h264,profile=baseline", "!",
        "rtspclientsink", f"location={RTSP_SINK}", "protocols=tcp",
    ]

    if not DETECT_FRAME:
        return ["gst-launch-1.0", "-e", *src, *h264_branch]

    # tee → (queue → H.264 → MediaMTX) and (queue → scale → JPEG slot file)
    return [
        "gst-launch-1.0", "-e",
        *src,
        "tee", "name=t",
        "t.", "!", "queue", "!", *h264_branch,
        "t.", "!", "queue", "!",
        "videorate", "!", f"video/x-raw,framerate={DETECT_TAP_FPS}/1", "!",
        "videoscale", "!",
        f"video/x-raw,width={DETECT_TAP_SIZE},height={DETECT_TAP_SIZE}", "!",
        "videoconvert", "!",
        "jpegenc", "!",
        "multifilesink", f"location={DETECT_FRAME}", "max-files=1",
    ]


def main():
    print(f"Seagrass camera: {WIDTH}x{HEIGHT}@{FPS}fps  →  {RTSP_SINK}")
    print(f"Browsers connect via WHEP:  http://{MEDIAMTX_HOST}:8889/{STREAM_NAME}/whep")
    if DETECT_FRAME:
        print(
            f"Detection tap: {DETECT_TAP_SIZE}x{DETECT_TAP_SIZE}@{DETECT_TAP_FPS}fps  →  {DETECT_FRAME}"
        )
    gst_cmd = build_gst_cmd()
    try:
        subprocess.run(gst_cmd, check=True)
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
