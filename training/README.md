# Seagrass detector fine-tuning

This directory trains a custom underwater object detector by fine-tuning
**YOLOX-Nano** (Apache-2.0) from its COCO-pretrained weights onto your own
labelled classes (e.g. seagrass, debris, fish, diver). The exported ONNX model
is then deployed to the Pi at `server/vision/models/`.

> **Runs on a dev machine with a GPU — not on the Raspberry Pi.** The Pi only
> runs inference (`server/vision/detector.py`). Training a model on the Pi CPU
> is impractically slow.

Everything here is permissively licensed (YOLOX Apache-2.0, CVAT MIT / Label
Studio Apache-2.0), so a fine-tuned model and this pipeline can ship inside a
closed product with no copyleft obligation.

---

## 0. One-time setup

```bash
cd training
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
# YOLOX itself (training scripts live in its repo):
git clone https://github.com/Megvii-BaseDetection/YOLOX yolox_src
pip install -e ./yolox_src
```

Download the COCO-pretrained checkpoint you will fine-tune *from*:

```bash
# YOLOX-Nano weights (see the YOLOX GitHub "Benchmark" table for the URL)
wget -O yolox_nano.pth <yolox_nano.pth release URL from YOLOX repo>
```

---

## 1. Collect and annotate footage

1. Pull video/stills off the ROV and extract frames (e.g. `ffmpeg -i dive.mp4 -vf fps=2 frames/%05d.jpg`).
2. Annotate bounding boxes. Recommended tool: **CVAT** (MIT, self-hosted via
   Docker) — it does video-frame annotation and exports COCO natively.
   Alternative: **Label Studio** (Apache-2.0).
3. Export as **COCO 1.0** and drop the result into:

```
datasets/seagrass_underwater/
├── train2024/                       # training images
├── val2024/                         # validation images
└── annotations/
    ├── instances_train.json         # COCO-format boxes
    └── instances_val.json
```

4. List your class names, one per line, in [`labels.txt`](./labels.txt) — the
   order defines the class indices used everywhere downstream.

---

## 2. Configure the experiment

Edit [`configs/yolox_nano_seagrass.py`](./configs/yolox_nano_seagrass.py) and set
`self.num_classes` to the number of lines in `labels.txt`. The dataset paths are
already wired to the layout above.

---

## 3. Train, evaluate, export

```bash
./scripts/train.sh        # fine-tune from yolox_nano.pth
./scripts/eval.sh         # mAP on the val split
./scripts/export_onnx.sh  # -> ../server/vision/models/seagrass_nano.onnx
```

`train.sh` passes `-c yolox_nano.pth`, which loads the COCO weights as the
starting point (transfer learning) rather than training from scratch.

---

## 4. Deploy to the Pi

```bash
# copy the exported model and label list to the Pi
scp ../server/vision/models/seagrass_nano.onnx pi@seagrass-pi.local:~/Sea-Grass-Drone/server/vision/models/
scp labels.txt pi@seagrass-pi.local:~/Sea-Grass-Drone/server/vision/models/seagrass.txt
```

Point the detector at them (e.g. in the systemd unit or shell):

```bash
export DETECT_MODEL=~/Sea-Grass-Drone/server/vision/models/seagrass_nano.onnx
export DETECT_LABELS=~/Sea-Grass-Drone/server/vision/models/seagrass.txt
```

The detector loads labels from `DETECT_LABELS`, so no code change is needed to
swap the COCO smoke-test model for your fine-tuned underwater one.

---

## Notes

- **Model size:** upgrade to YOLOX-Tiny (`yolox_tiny.pth` + a Tiny config) if you
  need more accuracy and can afford the extra Pi CPU cost (~6× FLOPs). The
  workflow is identical — just a different base checkpoint and config.
- **Input size:** if you export at a size other than 416, set `DETECT_SIZE` to
  match on the Pi.
