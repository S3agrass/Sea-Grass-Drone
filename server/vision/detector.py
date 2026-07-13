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

Run standalone (against a saved test image instead of the live slot):
    DETECT_FRAME=/path/to/test.jpg python3 detector.py
"""

import json
import os
import sys
import time

import cv2
import numpy as np
import onnxruntime

from underwater_filter import apply as underwater_apply

# ---------------- configuration ----------------
_HERE = os.path.dirname(__file__)
MODEL_PATH = os.environ.get("DETECT_MODEL", os.path.join(_HERE, "models", "yolox_nano.onnx"))
LABELS_PATH = os.environ.get("DETECT_LABELS", os.path.join(_HERE, "models", "coco.txt"))
FRAME_PATH = os.environ.get("DETECT_FRAME", "/tmp/seagrass-detect-frame.jpg")
FPS = float(os.environ.get("DETECT_FPS", "5"))
INPUT_SIZE = int(os.environ.get("DETECT_SIZE", "416"))
CONF_THRESH = float(os.environ.get("DETECT_CONF", "0.35"))
NMS_THRESH = float(os.environ.get("DETECT_NMS", "0.45"))
THREADS = int(os.environ.get("DETECT_THREADS", "4"))


def load_labels(path):
    with open(path, "r", encoding="utf-8") as fh:
        return [line.strip() for line in fh if line.strip()]


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
    preds = decode_outputs(raw.copy(), grids, strides)[0]  # (N, 5+num_classes)

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
            f"Detector: model not found at {MODEL_PATH}. Export one with "
            f"training/scripts/export_onnx.sh (or drop yolox_nano.onnx there).",
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

    print(
        f"Detector: {MODEL_PATH} @ {INPUT_SIZE}px, {len(labels)} classes, "
        f"reading {FRAME_PATH} at {FPS}fps",
        file=sys.stderr,
    )

    period = 1.0 / FPS if FPS > 0 else 0.0
    last_mtime = None
    while True:
        start = time.time()
        try:
            mtime = os.path.getmtime(FRAME_PATH)
        except OSError:
            time.sleep(period)
            continue

        # Skip re-running on a frame we already processed.
        if mtime == last_mtime:
            time.sleep(max(0.0, period - (time.time() - start)))
            continue
        last_mtime = mtime

        frame = cv2.imread(FRAME_PATH)  # may briefly be a half-written file
        if frame is None:
            time.sleep(period)
            continue

        frame = underwater_apply(frame)
        frame_h, frame_w = frame.shape[:2]

        tensor, ratio = preprocess(frame, INPUT_SIZE)
        raw = session.run(None, {input_name: tensor})[0]
        boxes = postprocess(raw, grids, strides_full, ratio, frame_w, frame_h, labels)

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
