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
# --fp16 is CUDA automatic mixed precision. It was hardcoded, which made this
# script CUDA-only in a way that only shows up as a confusing failure elsewhere:
# on anything without CUDA it does not fall back, it breaks. Off by default now
# on machines with no NVIDIA GPU, so the same script runs (slowly, but runs)
# wherever it lands.
if [ -z "${FP16:-}" ]; then
    if command -v nvidia-smi >/dev/null 2>&1; then FP16=1; else FP16=0; fi
fi

ARGS=(-f "${CONFIG}" -d "${DEVICES}" -b "${BATCH}" -c "${PRETRAINED}")
[ "${FP16}" = "1" ] && ARGS+=(--fp16)
# Resume a run that was interrupted — long trainings on preemptible cloud GPUs
# get cut off, and starting from epoch 0 again wastes the whole session.
[ -n "${RESUME:-}" ] && ARGS+=(--resume -c "${RESUME}")

echo "yolox.tools.train ${ARGS[*]}"
python -m yolox.tools.train "${ARGS[@]}"
