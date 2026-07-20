#!/usr/bin/env bash
# Fine-tune YOLOX-Nano from COCO-pretrained weights on the custom dataset.
# Run from the training/ directory (or anywhere — paths are resolved relative
# to this script).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="${HERE}/../configs/yolox_nano_seagrass.py"
PRETRAINED="${PRETRAINED:-${HERE}/../yolox_nano.pth}"
BATCH="${BATCH:-8}"
DEVICES="${DEVICES:-1}"   # number of GPUs

python -m yolox.tools.train \
  -f "${CONFIG}" \
  -d "${DEVICES}" \
  -b "${BATCH}" \
  --fp16 \
  -c "${PRETRAINED}"
