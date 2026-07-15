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

python -m yolox.tools.export_onnx \
  -f "${CONFIG}" \
  -c "${CKPT}" \
  --output-name "${OUT}"

echo "Exported ONNX model -> ${OUT}"
echo "Deploy it and labels.txt to the Pi, then set DETECT_MODEL / DETECT_LABELS."
