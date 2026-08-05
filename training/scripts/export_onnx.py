"""Export a trained YOLOX checkpoint to ONNX.

This does the same job as `python -m yolox.tools.export_onnx`, and exists because
that tool no longer runs on current PyTorch. It broke twice in a row from one
checkpoint:

  * `torch.load` refused the checkpoint outright — PyTorch 2.6 flipped
    `weights_only` to True and YOLOX does not override it (worked around in
    export_onnx.sh, which now hands us a weights-only copy);
  * `torch.onnx._export` no longer exists — it was private, and PyTorch removed
    it in favour of `torch.onnx.export`.

Both are YOLOX being three years old rather than anything wrong with the model,
and neither is fixable from outside its source. The export itself is a short
piece of code, so owning it is cheaper than continuing to patch around a tool we
do not control. YOLOX is still imported for the model definition — only its CLI
is replaced.

The one thing here that is not boilerplate is `decode_in_inference = False`. It
must stay that way: server/vision/detector.py does the grid decode itself in
postprocess(), and a model exported with decoding baked in produces output that
silently disagrees with it — plausible-looking boxes in the wrong places.
"""

import argparse
import sys

import torch
from torch import nn

from yolox.exp import get_exp


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("-f", "--exp-file", required=True, help="YOLOX Exp config")
    ap.add_argument("-c", "--ckpt", required=True, help="checkpoint to export")
    ap.add_argument("-o", "--output-name", required=True, help="destination .onnx")
    ap.add_argument("--opset", type=int, default=11)
    ap.add_argument("--batch-size", type=int, default=1)
    ap.add_argument("--input", default="images")
    ap.add_argument("--output", default="output")
    args = ap.parse_args()

    exp = get_exp(args.exp_file, None)
    model = exp.get_model()

    # export_onnx.sh reduces the checkpoint to weights first, so this loads under
    # the strict weights_only default on any PyTorch.
    ckpt = torch.load(args.ckpt, map_location="cpu")
    state = ckpt["model"] if isinstance(ckpt, dict) and "model" in ckpt else ckpt
    model.load_state_dict(state)
    model.eval()

    # YOLOX swaps nn.SiLU for its own module because older opsets have no native
    # SiLU. Harmless where it is supported, and skipped rather than fatal if the
    # helper moves again — this is a compatibility nicety, not the export.
    try:
        from yolox.models.network_blocks import SiLU
        from yolox.utils import replace_module

        model = replace_module(model, nn.SiLU, SiLU)
    except Exception as exc:  # pragma: no cover - depends on the YOLOX version
        print(f"note: could not swap SiLU ({exc}); continuing", file=sys.stderr)

    # The decode stays OUT of the graph. See the module docstring.
    model.head.decode_in_inference = False

    dummy = torch.randn(args.batch_size, 3, exp.test_size[0], exp.test_size[1])

    kwargs = dict(
        input_names=[args.input],
        output_names=[args.output],
        opset_version=args.opset,
    )
    try:
        # Pin the long-standing tracing exporter. Newer PyTorch is migrating the
        # default to the dynamo path, which produces a different graph for the
        # same model — not something to discover on the vehicle.
        torch.onnx.export(model, dummy, args.output_name, dynamo=False, **kwargs)
    except TypeError:
        # Older PyTorch has no `dynamo` parameter, and no ambiguity either.
        torch.onnx.export(model, dummy, args.output_name, **kwargs)

    print(f"exported {args.output_name}")

    # Optional: fold the constants the tracer leaves behind. Never fatal — an
    # un-simplified model runs identically, just with a larger graph.
    try:
        import onnx
        import onnxsim

        simplified, ok = onnxsim.simplify(onnx.load(args.output_name))
        if ok:
            onnx.save(simplified, args.output_name)
            print("simplified the ONNX graph")
        else:
            print("onnxsim declined to simplify; keeping the original")
    except Exception as exc:
        print(f"note: skipped onnxsim ({exc})", file=sys.stderr)


if __name__ == "__main__":
    main()
