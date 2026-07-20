#!/usr/bin/env bash
# Evaluate the fine-tuned checkpoint (mAP) on the validation split.
# Pass the checkpoint path as $1, or it defaults to the best_ckpt YOLOX writes.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="${HERE}/../configs/yolox_nano_seagrass.py"
CKPT="${1:-YOLOX_outputs/yolox_nano_seagrass/best_ckpt.pth}"
BATCH="${BATCH:-8}"
DEVICES="${DEVICES:-1}"

python -m yolox.tools.eval \
  -f "${CONFIG}" \
  -d "${DEVICES}" \
  -b "${BATCH}" \
  --fp16 \
  -c "${CKPT}"
