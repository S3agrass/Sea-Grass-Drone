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

# Re-save the checkpoint as weights and nothing else, and export from that.
#
# PyTorch 2.6 changed torch.load's `weights_only` default from False to True, and
# YOLOX's export_onnx.py calls torch.load without overriding it. Our checkpoints
# carry more than tensors — the trainer records the best AP alongside the weights
# as a numpy scalar — and numpy._core.multiarray.scalar is not on the unpickler's
# allowlist. So the export dies in torch.load with UnpicklingError before it ever
# looks at the model, on a checkpoint that is completely fine.
#
# The fix is not to pass weights_only=False (we cannot: the call is inside
# YOLOX), nor to allowlist the global (that needs a code change in the same
# place). Instead, load it here — trusted, since we just trained it — and write a
# slim copy holding only the state dict. That copy contains nothing but tensors,
# so it loads under weights_only=True on any version, and YOLOX only ever reads
# ckpt["model"] anyway.
SLIM="$(dirname "${CKPT}")/.export-slim.pth"
trap 'rm -f "${SLIM}"' EXIT

python - "${CKPT}" "${SLIM}" <<'PY'
import sys
import torch

src, dst = sys.argv[1], sys.argv[2]
try:
    ckpt = torch.load(src, map_location="cpu", weights_only=False)
except TypeError:
    # torch < 1.13 has no weights_only parameter, and no problem either.
    ckpt = torch.load(src, map_location="cpu")

state = ckpt["model"] if isinstance(ckpt, dict) and "model" in ckpt else ckpt
torch.save({"model": state}, dst)
print(f"checkpoint reduced to weights only -> {dst}")
PY

# Deliberately NOT trusting the exit status. yolox.tools.export_onnx wraps main()
# in loguru's @logger.catch, which logs the traceback and then exits 0 — so a
# failed export looks exactly like a successful one to `set -e`, and this script
# used to print "Exported ONNX model -> ..." directly underneath a
# FileNotFoundError. The artefact existing is the only trustworthy signal.
rm -f "${OUT}"
python -m yolox.tools.export_onnx \
  -f "${CONFIG}" \
  -c "${SLIM}" \
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
