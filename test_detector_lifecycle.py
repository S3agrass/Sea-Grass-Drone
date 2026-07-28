"""Lifecycle tests for the YOLOX detector subprocess.

Runs with no camera and no Pi: it spawns the real detector against the real
model and drives drone_server's real start/stop code. Needs the model present —
run scripts/fetch-model.sh first, or these skip.

The failures being pinned here are the ones that made detection look like it
simply didn't exist:

  - a detector that died on startup still reported as RUNNING, because
    asyncio.Process.returncode stays None until the child is reaped, so the UI
    toggle latched on for a corpse
  - the reason it died went to stderr, and stderr was DEVNULL, so nothing
    anywhere said "there is no model file"
  - a missing frame slot must NOT be fatal; the camera is often off

    python3 test_detector_lifecycle.py
"""
import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "server"))

os.environ.setdefault("SEAGRASS_TOKEN", "test-token-not-used")

import drone_server as ds  # noqa: E402

FAILURES = []
MODEL = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                     "server", "vision", "models", "yolox_nano.onnx")


def check(name, condition, detail=""):
    print(f"  [{'PASS' if condition else 'FAIL'}] {name}{'  — ' + detail if detail else ''}")
    if not condition:
        FAILURES.append(name)


async def test_missing_model_fails_loudly():
    print("\n=== A missing model fails, says why, and does not look alive ===")
    os.environ["DETECT_MODEL"] = "/nonexistent/missing.onnx"
    try:
        ok, detail = await ds.start_detector()
        check("start_detector reports failure", ok is False)
        check("does not report as running", ds.detector_running() is False)
        check("detail quotes the detector's own diagnosis",
              "model not found" in detail, detail[:70])
    finally:
        await ds.stop_detector()
        os.environ.pop("DETECT_MODEL", None)


async def test_healthy_detector_survives_a_missing_frame():
    print("\n=== A healthy detector starts and tolerates no frames ===")
    os.environ["DETECT_MODEL"] = MODEL
    ds.DETECT_FRAME_PATH = "/nonexistent/frame.jpg"
    try:
        ok, detail = await ds.start_detector()
        check("starts cleanly", ok is True, detail)
        check("reports as running", ds.detector_running() is True)
        # The camera is off far more often than not; a detector that exited
        # because it had nothing to read would be useless.
        await asyncio.sleep(1.0)
        check("still running a second later with no frame slot",
              ds.detector_running() is True)
    finally:
        await ds.stop_detector()
    check("not running after stop", ds.detector_running() is False)
    check("detections cleared on stop", ds.latest_detections["boxes"] == [])
    os.environ.pop("DETECT_MODEL", None)


async def test_detections_flow_from_a_still_image():
    print("\n=== Real inference reaches latest_detections ===")
    import cv2
    import numpy as np
    # A synthetic frame is enough: this asserts the plumbing (spawn -> stdout ->
    # JSON -> latest_detections), not that anything is recognisable in it.
    tmp = "/tmp/seagrass-detector-lifecycle-test.jpg"
    cv2.imwrite(tmp, np.full((240, 320, 3), 127, dtype=np.uint8))
    os.environ["DETECT_MODEL"] = MODEL
    ds.DETECT_FRAME_PATH = tmp
    try:
        ok, detail = await ds.start_detector()
        check("starts with a readable frame", ok is True, detail)
        for _ in range(60):  # up to ~6s for model load + first inference
            await asyncio.sleep(0.1)
            if ds.latest_detections.get("ts"):
                break
        check("published a result", bool(ds.latest_detections.get("ts")),
              str(ds.latest_detections)[:70])
        check("result has a boxes list",
              isinstance(ds.latest_detections.get("boxes"), list))
    finally:
        await ds.stop_detector()
        os.environ.pop("DETECT_MODEL", None)
        try:
            os.remove(tmp)
        except OSError:
            pass


async def main():
    if not os.path.exists(MODEL):
        print(f"SKIP: no model at {MODEL}\n      run scripts/fetch-model.sh first")
        return
    await test_missing_model_fails_loudly()
    await test_healthy_detector_survives_a_missing_frame()
    await test_detections_flow_from_a_still_image()

    print()
    if FAILURES:
        raise SystemExit(f"FAILED: {', '.join(FAILURES)}")
    print("All detector lifecycle checks passed.")


if __name__ == "__main__":
    asyncio.run(main())
