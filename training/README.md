# Seagrass detector fine-tuning

This directory trains a custom underwater object detector by fine-tuning
**YOLOX-Nano** (Apache-2.0) from its COCO-pretrained weights onto your own
labelled classes (e.g. seagrass, debris, fish, diver). The exported ONNX model
is then deployed to the Pi at `server/vision/models/`.

> **Runs on a dev machine with a GPU — not on the Raspberry Pi.** The Pi only
> runs inference (`server/vision/detector.py`). Training a model on the Pi CPU
> is impractically slow.
>
> **No CUDA machine?** Use [`colab_train.ipynb`](./colab_train.ipynb) — open it
> in Google Colab, set the runtime to a T4 GPU, and it installs YOLOX, prepares
> the dataset, trains, and exports the ONNX for you. A free T4 does ~100 epochs
> over 15k images in roughly 2–4 hours.
>
> An Apple Silicon Mac cannot do this locally: YOLOX has no Metal backend, and
> even patched, an M3 would take 17+ hours against the T4's 2–4.

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

> ### Faster: start from a public dataset
>
> Annotating from scratch is the slow path — roughly 500–2000 images for a
> usable fine-tune, at 5–20 s each, so several hours of labelling on top of a
> dive day. If you need something working sooner, fine-tune on published
> underwater detection data instead and only add your own footage afterwards.
>
> All of these are box-labelled and export or convert to **COCO 1.0**, which is
> exactly what `train.sh` consumes — drop them into the layout below and skip
> steps 1–3:
>
> | Dataset | Size | Classes |
> |---|---|---|
> | **[RUOD](https://github.com/xiaoDetection/RUOD)** | 13,112 images / 71,935 boxes | holothurian, echinus, scallop, starfish, fish, corals, diver, cuttlefish, turtle, jellyfish |
> | **[TrashCan](https://arxiv.org/pdf/2007.08097)** | 7,212 images | trash (many subtypes), rov, animals — from JAMSTEC deep-sea footage |
> | **[Shallow-water debris](https://www.nature.com/articles/s41597-024-03759-2)** | — | Marine debris in shallow water — a closer environmental match than TrashCan |
> | **[Roboflow Universe](https://universe.roboflow.com/search?q=class%3Aunderwater)** | varies | Search "underwater"; exports COCO directly in the browser |
>
> **`scripts/prepare_dataset.py` merges them for you.** These datasets disagree
> on everything — RUOD calls a sea cucumber `holothurian`, TrashCan splits
> rubbish across a dozen `trash_*` categories, and both number their category
> ids from 1 with no relation to each other. The script unifies the label space,
> re-issues image and annotation ids (merging two files that both start at id 1
> otherwise attaches boxes to the wrong images, and every box still lands on a
> real photo so the damage is invisible), and writes the layout below.
>
> ```bash
> # Look before you write — reports what the datasets actually contain
> python3 scripts/prepare_dataset.py --dry-run --split train \
>     --source ruod:/data/RUOD/annotations/instances_train.json:/data/RUOD/train \
>     --source trashcan:/data/trashcan/instances_train.trashcan.json:/data/trashcan/train
> ```
>
> Read the **UNMAPPED** section of that output before going further. Anything
> listed there became *background*, which does not mean "ignored" — it actively
> teaches the model that a sea urchin is nothing worth reporting. Either add a
> rule to `RULES` in the script, or re-run with `--drop-unmapped-images` to
> exclude those images instead. Then drop `--dry-run` and repeat for
> `--split val`.
>
> Keep `labels.txt`, `LABELS` in the script, and `num_classes` in the config in
> step — `test_dataset_prep.py` fails if the first two drift apart, because a
> mismatch shifts every class index and the model then reports confident boxes
> under the wrong names.
>
> **Expect a domain gap.** A model trained on someone else's water, camera and
> species will underperform in yours — different turbidity, different colour
> cast, different fauna. Treat a public-data model as a strong starting point,
> then fine-tune it again on a few hundred of your own frames once you have
> them. That second pass is far cheaper than annotating from zero.
>
> **Seagrass is not on this list on purpose.** See the note in
> [`labels.txt`](./labels.txt): it is ground cover rather than discrete objects,
> so it wants classification or segmentation, not boxes. The relevant public
> work — DeepSeagrass (66k images, patch labels, pretrained CSIRO models) and
> *Image Labels Are All You Need for Coarse Seagrass Segmentation* (WACV 2024) —
> is a separate model with a separate inference path, not a class here.

### Collecting your own

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
