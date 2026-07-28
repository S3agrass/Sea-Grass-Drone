#!/usr/bin/env bash
# Fetch a YOLOX ONNX model into server/vision/models/.
#
# The model is deliberately NOT in git (.gitignore excludes
# server/vision/models/*.onnx — it is a ~9 MB binary), so a fresh clone has no
# detector and the AI toggle does nothing. This is how you get one.
#
# The default is stock COCO YOLOX-Nano: 80 land classes, useless underwater, and
# exactly right as a TEST INSTRUMENT — point the camera at a person, see a box,
# and you have proven camera -> frame tap -> inference -> WebSocket -> overlay in
# one go. Swap in a trained model later by setting DETECT_MODEL; nothing else
# changes.
#
# Usage:
#   ./scripts/fetch-model.sh                 # COCO YOLOX-Nano
#   ./scripts/fetch-model.sh --force         # re-download over an existing file
#   ./scripts/fetch-model.sh <url>           # some other .onnx
#   MODEL_URL=... ./scripts/fetch-model.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST_DIR="${HERE}/../server/vision/models"

# 416px input, which matches detector.py's DETECT_SIZE default, and exported by
# the same yolox.tools.export_onnx that training/scripts/export_onnx.sh uses —
# so the grid decode detector.py applies is the right one. See DETECT_DECODE if
# you substitute a model from elsewhere.
DEFAULT_URL="https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_nano.onnx"

FORCE=0
URL="${MODEL_URL:-$DEFAULT_URL}"
for arg in "$@"; do
    case "$arg" in
        --force) FORCE=1 ;;
        -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}"; exit 0 ;;
        *) URL="$arg" ;;
    esac
done

# Name the file after what was actually downloaded. Hardcoding yolox_nano.onnx
# meant fetching yolox_tiny or yolox_s — the obvious next thing to try when the
# nano model proves too weak — saved it under the nano name, leaving no way to
# tell which model was deployed and making DETECT_SIZE mismatches (nano/tiny are
# 416, s and up are 640) very hard to diagnose.
BASENAME="$(basename "${URL%%\?*}")"
case "$BASENAME" in
    *.onnx) ;;
    *) BASENAME="yolox_nano.onnx" ;;  # URL without a usable filename
esac
DEST="${DEST_DIR}/${BASENAME}"

if [ -f "$DEST" ] && [ "$FORCE" -eq 0 ]; then
    echo "Model already present: $DEST"
    echo "  (re-run with --force to replace it)"
    exit 0
fi

mkdir -p "$DEST_DIR"
TMP="${DEST}.part.$$"
trap 'rm -f "$TMP"' EXIT

echo "Fetching $URL"
# -f so an HTTP error is a failure rather than a saved error page; -L to follow
# GitHub's redirect to its asset CDN.
curl -fL --retry 3 --retry-delay 2 -o "$TMP" "$URL"

# Size check, not just exit status: a captive portal or proxy can answer 200
# with an HTML page, and a truncated or bogus .onnx fails much later and far
# less clearly, inside InferenceSession.
SIZE=$(wc -c < "$TMP")
if [ "$SIZE" -lt 1000000 ]; then
    echo "Downloaded only ${SIZE} bytes — that is not a YOLOX model." >&2
    echo "Check the URL, or whether something intercepted the request." >&2
    exit 1
fi

# Move into place only once it is known-good, so an interrupted run never
# leaves a half-written model for the detector to choke on.
mv "$TMP" "$DEST"
trap - EXIT
echo "Saved $DEST ($((SIZE / 1024 / 1024)) MB)"
if [ "$BASENAME" != "yolox_nano.onnx" ]; then
    echo
    echo "Not the default filename, so point the detector at it:"
    echo "  DETECT_MODEL=$DEST"
    echo "Check the input size too — nano and tiny are 416, s and larger are 640:"
    echo "  DETECT_SIZE=640"
fi
echo
echo "Verify it before wiring anything up — this prints straight to your"
echo "terminal, where the server would otherwise swallow the output:"
echo "  DETECT_UNDERWATER=0 DETECT_FRAME=/path/to/photo.jpg python3 server/vision/detector.py"
