#!/usr/bin/env bash
# Export a trained checkpoint to ONNX for deployment to the Pi.
# Pass the checkpoint path as $1, or it defaults to the best_ckpt YOLOX writes.
# Output lands in server/vision/models/seagrass_nano.onnx.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="${HERE}/../configs/yolox_nano_seagrass.py"
CKPT="${1:-YOLOX_outputs/yolox_nano_seagrass/best_ckpt.pth}"
OUT="${HERE}/../../server/vision/models/seagrass_nano.onnx"

mkdir -p "$(dirname "${OUT}")"

# Check the checkpoint up front. YOLOX's own failure for a missing one is a
# forty-line loguru traceback ending in FileNotFoundError, which buries the one
# fact that matters.
if [ ! -f "${CKPT}" ]; then
    echo "No checkpoint at: ${CKPT}" >&2
    echo "  (relative paths resolve from $(pwd))" >&2
    D="$(dirname "${CKPT}")"
    if [ -d "${D}" ]; then
        echo "  ${D} contains:" >&2
        ls -la "${D}" >&2
    else
        echo "  ${D} does not exist — training has not produced output yet." >&2
        echo "  best_ckpt.pth is only written after the first evaluation pass" >&2
        echo "  (every eval_interval epochs), so a run that died early leaves none." >&2
    fi
    exit 1
fi

# Deliberately NOT trusting the exit status. yolox.tools.export_onnx wraps main()
# in loguru's @logger.catch, which logs the traceback and then exits 0 — so a
# failed export looks exactly like a successful one to `set -e`, and this script
# used to print "Exported ONNX model -> ..." directly underneath a
# FileNotFoundError. The artefact existing is the only trustworthy signal.
rm -f "${OUT}"
python -m yolox.tools.export_onnx \
  -f "${CONFIG}" \
  -c "${CKPT}" \
  --output-name "${OUT}" || true

if [ ! -s "${OUT}" ]; then
    echo >&2
    echo "Export FAILED — no model at ${OUT}" >&2
    echo "See the traceback above; yolox swallows the exit code, so this check" >&2
    echo "is what caught it." >&2
    exit 1
fi

echo "Exported ONNX model -> ${OUT} ($(du -h "${OUT}" | cut -f1))"
echo "Deploy it and labels.txt to the Pi, then set DETECT_MODEL / DETECT_LABELS."
