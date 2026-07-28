"""
Seagrass object detector — runs on the Raspberry Pi 5.

Standalone process (mirrors camera_stream.py's env-var-driven style) that:

    1. Reads the latest camera frame from a JPEG "slot" file that
       camera_stream.py's GStreamer `tee` branch continuously overwrites.
    2. Runs the underwater filter (vision/underwater_filter.py) over it.
    3. Runs a YOLOX ONNX model on it via ONNX Runtime (CPU).
    4. Prints one JSON line of detections per cycle to stdout — drone_server.py
       reads those lines and relays them to the browser over the WebSocket.

Output line shape (coordinates normalised 0-1 against the frame, so the
frontend never needs to know the model's input size):

    {"boxes": [{"cls": "person", "conf": 0.87,
                "x": 0.42, "y": 0.31, "w": 0.10, "h": 0.22}],
     "ts": 1752421200.12}

x,y is the top-left corner; w,h the size — all as fractions of frame width/height.

Labels are loaded from a plain text file (one class per line), chosen by the
DETECT_LABELS env var. Ship coco.txt for the pretrained-COCO smoke test; point
it at training/labels.txt once you deploy a fine-tuned underwater model. Nothing
in this file hardcodes a class list.

Environment variables (all optional):
    DETECT_MODEL    Path to the YOLOX .onnx model   default: vision/models/yolox_nano.onnx
    DETECT_LABELS   Path to the labels text file     default: vision/models/coco.txt
    DETECT_FRAME    Path to the JPEG frame slot      default: /tmp/seagrass-detect-frame.jpg
    DETECT_FPS      Max inference rate (Hz)          default: 5
    DETECT_SIZE     Model input square size (px)     default: 416
    DETECT_CONF     Confidence threshold             default: 0.35
    DETECT_NMS      NMS IoU threshold                default: 0.45
    DETECT_THREADS  ONNX Runtime intra-op threads    default: 4
    DETECT_UNDERWATER  Apply the underwater colour filter   default: 1
                    Set 0 for dry bench testing — the filter corrects a
                    blue-green cast that isn't there in air, and skews the
                    colour statistics a COCO model expects.
    DETECT_DECODE   Apply the YOLOX grid decode      default: 1
                    Set 0 only for a model exported WITH decode_in_inference.
                    Decoding twice gives tiny boxes bunched at the origin.
    DETECT_STALE_S  Emit empty boxes after this long without a fresh frame
                                                     default: 3.0

Run standalone (against a saved test image instead of the live slot):
    DETECT_UNDERWATER=0 DETECT_FRAME=/path/to/test.jpg python3 detector.py
"""

import json
import os
import sys
import time

import cv2
import numpy as np
import onnxruntime

_HERE = os.path.dirname(os.path.abspath(__file__))
# This module is launched by absolute path (drone_server spawns
# "python3 <repo>/server/vision/detector.py"), which puts its own directory on
# sys.path and makes the bare import below resolve. That is incidental, not
# guaranteed — running it any other way broke it — so put the directory there
# deliberately rather than relying on how it happened to be invoked.
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from underwater_filter import apply as underwater_apply  # noqa: E402


# ---------------- configuration ----------------
def _env_num(name, default, cast):
    """Parse a numeric env var, or exit with a line saying which one is wrong.

    Left at import scope on purpose, but never allowed to raise: an unparseable
    value used to surface as a ValueError traceback before main() ran, which is
    both ugly and — once drone_server discards this process's stderr — invisible.
    """
    raw = os.environ.get(name, default)
    try:
        return cast(raw)
    except (TypeError, ValueError):
        print(f"Detector: {name}={raw!r} is not a valid number", file=sys.stderr)
        sys.exit(2)


def _env_flag(name, default="1"):
    """Repo convention for booleans — see PING_PROFILE in sonar_reader.py."""
    return os.environ.get(name, default) not in ("0", "false", "False", "")


MODEL_PATH = os.environ.get("DETECT_MODEL", os.path.join(_HERE, "models", "yolox_nano.onnx"))
LABELS_PATH = os.environ.get("DETECT_LABELS", os.path.join(_HERE, "models", "coco.txt"))
FRAME_PATH = os.environ.get("DETECT_FRAME", "/tmp/seagrass-detect-frame.jpg")
FPS = _env_num("DETECT_FPS", "5", float)
INPUT_SIZE = _env_num("DETECT_SIZE", "416", int)
CONF_THRESH = _env_num("DETECT_CONF", "0.35", float)
NMS_THRESH = _env_num("DETECT_NMS", "0.45", float)
THREADS = _env_num("DETECT_THREADS", "4", int)
# Gray-world white balance + CLAHE. Right underwater, wrong in air: it rewrites
# the colour statistics a COCO model was trained on, so a dry bench test wants
# it off.
UNDERWATER = _env_flag("DETECT_UNDERWATER")
# YOLOX can export with the grid decode baked into the graph or left out.
# postprocess() below does the decode itself, which is correct only for the
# latter — and it is what this repo's own export_onnx.sh produces. If a model
# from elsewhere already decodes, doing it twice yields tiny boxes bunched at
# the origin; this is the escape hatch, and the startup banner prints the raw
# output shape so the case is recognisable without reading the exporter.
DECODE = _env_flag("DETECT_DECODE")
# No fresh frame for this long and one empty result is emitted, so the overlay
# clears rather than leaving stale boxes floating over a dead feed.
STALE_S = _env_num("DETECT_STALE_S", "3.0", float)
# Repeat-suppression for the "nothing to read" warnings: a missing frame slot is
# normal for as long as the camera is off, so it must be sayable once without
# then flooding the log for the rest of the session.
_WARN_EVERY_S = 30.0


def load_labels(path):
    if not os.path.exists(path):
        print(f"Detector: labels file not found at {path}. Ship models/coco.txt "
              f"for the COCO smoke test, or point DETECT_LABELS at your own.",
              file=sys.stderr)
        sys.exit(1)
    # '#' lines are skipped so a labels file can carry its own instructions.
    # Without this they became classes 0..n, silently shifting every real class
    # index and mislabelling every detection — and training/labels.txt shipped
    # with four comment lines at the top.
    with open(path, "r", encoding="utf-8") as fh:
        return [s for s in (line.strip() for line in fh)
                if s and not s.startswith("#")]


# ---------------- YOLOX pre/post-processing ----------------
# Adapted from YOLOX's own demo/ONNXRuntime reference implementation
# (Megvii-BaseDetection/YOLOX, Apache-2.0).

def preprocess(img, size):
    """Letterbox-resize a BGR frame to (size, size) keeping aspect ratio.

    Returns the CHW float32 tensor and the resize ratio (so boxes can be mapped
    back to the original frame afterwards).
    """
    padded = np.ones((size, size, 3), dtype=np.uint8) * 114
    ratio = min(size / img.shape[0], size / img.shape[1])
    resized = cv2.resize(
        img,
        (int(img.shape[1] * ratio), int(img.shape[0] * ratio)),
        interpolation=cv2.INTER_LINEAR,
    )
    padded[: resized.shape[0], : resized.shape[1]] = resized
    # HWC BGR uint8 -> CHW float32 (YOLOX ingests raw 0-255, no normalisation).
    tensor = padded.transpose(2, 0, 1).astype(np.float32)
    tensor = np.ascontiguousarray(tensor[None])  # add batch dim
    return tensor, ratio


def _make_grids(size, strides=(8, 16, 32)):
    """Precompute the anchor grid/stride arrays for decoding YOLOX output."""
    grids, expanded = [], []
    for stride in strides:
        hsize = wsize = size // stride
        xv, yv = np.meshgrid(np.arange(wsize), np.arange(hsize))
        grid = np.stack((xv, yv), 2).reshape(1, -1, 2)
        grids.append(grid)
        expanded.append(np.full((1, grid.shape[1], 1), stride))
    return np.concatenate(grids, 1), np.concatenate(expanded, 1)


def decode_outputs(outputs, grids, strides):
    """Turn raw YOLOX output into [x, y, w, h, obj, cls...] in input-pixel space."""
    outputs[..., :2] = (outputs[..., :2] + grids) * strides
    outputs[..., 2:4] = np.exp(outputs[..., 2:4]) * strides
    return outputs


def nms(boxes, scores, iou_thresh):
    """Plain single-class NMS. boxes are [x1, y1, x2, y2]."""
    x1, y1, x2, y2 = boxes[:, 0], boxes[:, 1], boxes[:, 2], boxes[:, 3]
    areas = (x2 - x1) * (y2 - y1)
    order = scores.argsort()[::-1]
    keep = []
    while order.size > 0:
        i = order[0]
        keep.append(i)
        xx1 = np.maximum(x1[i], x1[order[1:]])
        yy1 = np.maximum(y1[i], y1[order[1:]])
        xx2 = np.minimum(x2[i], x2[order[1:]])
        yy2 = np.minimum(y2[i], y2[order[1:]])
        w = np.maximum(0.0, xx2 - xx1)
        h = np.maximum(0.0, yy2 - yy1)
        inter = w * h
        iou = inter / (areas[i] + areas[order[1:]] - inter)
        order = order[1:][iou <= iou_thresh]
    return keep


def postprocess(raw, grids, strides, ratio, frame_w, frame_h, labels):
    """Decode + threshold + NMS one image's raw output into normalised boxes."""
    preds = (decode_outputs(raw.copy(), grids, strides) if DECODE else raw)[0]

    boxes_cxcywh = preds[:, :4]
    obj_conf = preds[:, 4]
    cls_scores = preds[:, 5:]
    cls_ids = cls_scores.argmax(1)
    cls_conf = cls_scores[np.arange(cls_scores.shape[0]), cls_ids]
    scores = obj_conf * cls_conf

    keep_mask = scores >= CONF_THRESH
    boxes_cxcywh = boxes_cxcywh[keep_mask]
    scores = scores[keep_mask]
    cls_ids = cls_ids[keep_mask]
    if boxes_cxcywh.shape[0] == 0:
        return []

    # cx,cy,w,h (input-pixel space) -> x1,y1,x2,y2, then undo the letterbox ratio.
    xy = boxes_cxcywh[:, :2]
    wh = boxes_cxcywh[:, 2:4]
    x1y1 = (xy - wh / 2) / ratio
    x2y2 = (xy + wh / 2) / ratio
    xyxy = np.concatenate([x1y1, x2y2], 1)

    keep = nms(xyxy, scores, NMS_THRESH)

    results = []
    for i in keep:
        x1, y1, x2, y2 = xyxy[i]
        cls_id = int(cls_ids[i])
        name = labels[cls_id] if 0 <= cls_id < len(labels) else str(cls_id)
        # Clamp to frame and normalise to 0-1.
        x1 = max(0.0, min(x1, frame_w))
        y1 = max(0.0, min(y1, frame_h))
        x2 = max(0.0, min(x2, frame_w))
        y2 = max(0.0, min(y2, frame_h))
        results.append({
            "cls": name,
            "conf": round(float(scores[i]), 3),
            "x": round(float(x1 / frame_w), 4),
            "y": round(float(y1 / frame_h), 4),
            "w": round(float((x2 - x1) / frame_w), 4),
            "h": round(float((y2 - y1) / frame_h), 4),
        })
    return results


# ---------------- main loop ----------------
def main():
    if not os.path.exists(MODEL_PATH):
        print(
            f"Detector: model not found at {MODEL_PATH}. Fetch the stock COCO "
            f"one with scripts/fetch-model.sh, or export a trained model with "
            f"training/scripts/export_onnx.sh.",
            file=sys.stderr,
        )
        sys.exit(1)

    labels = load_labels(LABELS_PATH)
    strides_full = None  # filled once we know the grid, tied to INPUT_SIZE

    opts = onnxruntime.SessionOptions()
    opts.intra_op_num_threads = THREADS
    session = onnxruntime.InferenceSession(
        MODEL_PATH, sess_options=opts, providers=["CPUExecutionProvider"]
    )
    input_name = session.get_inputs()[0].name
    grids, strides_full = _make_grids(INPUT_SIZE)

    # Output shape is printed because it is the one thing that identifies a
    # decode mismatch at a glance: a YOLOX export at 416px yields 3549 anchors,
    # and postprocess() only decodes correctly for a graph that left the decode
    # out. See DETECT_DECODE.
    out_shape = session.get_outputs()[0].shape
    print(
        f"Detector: {MODEL_PATH} @ {INPUT_SIZE}px, {len(labels)} classes, "
        f"out={out_shape}, decode={'on' if DECODE else 'off'}, "
        f"underwater filter={'on' if UNDERWATER else 'off'}, "
        f"reading {FRAME_PATH} at {FPS}fps",
        file=sys.stderr,
    )

    period = 1.0 / FPS if FPS > 0 else 0.0
    last_mtime = None
    emitted_boxes = False   # have we sent a non-empty result since going stale?
    _STARTED_AT = time.time()  # see the staleness check below
    warned_at = {}          # message key -> last time it was printed

    def warn(key, message):
        """Say it once, then at most every _WARN_EVERY_S.

        A missing frame slot is the normal state whenever the camera is off, so
        the loop cannot stay silent about it (it used to, forever) and equally
        cannot repeat it five times a second.
        """
        now = time.time()
        if now - warned_at.get(key, 0.0) < _WARN_EVERY_S:
            return
        warned_at[key] = now
        print(f"Detector: {message}", file=sys.stderr)

    while True:
        start = time.time()
        try:
            mtime = os.path.getmtime(FRAME_PATH)
        except OSError:
            warn("no-frame", f"no frame at {FRAME_PATH} — is the camera running?")
            if emitted_boxes:
                emitted_boxes = False
                print(json.dumps({"boxes": [], "ts": round(time.time(), 3)}), flush=True)
            time.sleep(period)
            continue

        # A frame that has stopped being refreshed is not a frame. Without this
        # the last detections simply persist, and boxes hang over a dead feed
        # looking every bit as live as real ones.
        #
        # Only for a slot written since we started, though. Pointed at a saved
        # image — the standalone recipe in the docstring, and the only way to
        # test any of this without a camera — the file's mtime is older than the
        # process and never moves, so a plain wall-clock check calls it stale
        # forever and the documented workflow returns nothing. A live slot is
        # rewritten continuously, so its mtime always overtakes _STARTED_AT;
        # anything that never does is a static input, not a stalled feed.
        if mtime > _STARTED_AT and time.time() - mtime > STALE_S:
            warn("stale", f"frame at {FRAME_PATH} is stale (>{STALE_S:g}s old)")
            if emitted_boxes:
                emitted_boxes = False
                print(json.dumps({"boxes": [], "ts": round(time.time(), 3)}), flush=True)
            time.sleep(period)
            continue

        # Skip re-running on a frame we already processed.
        if mtime == last_mtime:
            time.sleep(max(0.0, period - (time.time() - start)))
            continue
        last_mtime = mtime

        frame = cv2.imread(FRAME_PATH)  # may briefly be a half-written file
        if frame is None:
            warn("unreadable", f"could not decode {FRAME_PATH} (partial write?)")
            time.sleep(period)
            continue

        # One bad frame must cost one frame, not the session. Before this, any
        # exception in here escaped main() and killed the process outright —
        # with its traceback going to a stderr the server was discarding, so
        # detection simply stopped and nothing anywhere said why.
        try:
            if UNDERWATER:
                frame = underwater_apply(frame)
            frame_h, frame_w = frame.shape[:2]

            tensor, ratio = preprocess(frame, INPUT_SIZE)
            raw = session.run(None, {input_name: tensor})[0]
            boxes = postprocess(raw, grids, strides_full, ratio, frame_w, frame_h, labels)
        except Exception as exc:  # noqa: BLE001 — KeyboardInterrupt still escapes
            warn("inference", f"inference failed ({exc!r}) — skipping this frame")
            time.sleep(period)
            continue

        emitted_boxes = True
        print(json.dumps({"boxes": boxes, "ts": round(time.time(), 3)}), flush=True)

        # Cap the rate; inference itself is usually the limiter on the Pi CPU.
        elapsed = time.time() - start
        if elapsed < period:
            time.sleep(period - elapsed)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
