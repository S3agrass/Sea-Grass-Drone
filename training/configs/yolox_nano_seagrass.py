"""
YOLOX-Nano fine-tuning experiment for custom underwater classes.

This subclasses YOLOX's own Nano Exp and overrides only what differs for our
dataset: the class count and the COCO-format dataset paths. Run it via
../scripts/train.sh (which YOLOX's tools/train.py loads with `-f`).

Set `num_classes` to the number of entries in ../labels.txt.
"""

import os

from yolox.exp import Exp as MyExp


class Exp(MyExp):
    def __init__(self):
        super().__init__()

        # --- model: match YOLOX-Nano's depth/width so -c yolox_nano.pth loads ---
        self.depth = 0.33
        self.width = 0.25
        self.input_size = (416, 416)
        self.test_size = (416, 416)
        self.enable_mixup = False
        # Mosaic stitches four images per sample on the CPU. A Colab T4 instance
        # has two vCPUs, so at the default 1.0 the data loader — not the GPU —
        # sets the pace. 0.3 keeps most of the regularisation benefit at a
        # fraction of the CPU cost. Raise it on a machine with real cores.
        self.mosaic_prob = 0.3
        # no_aug_epochs is YOLOX's tail of augmentation-free epochs. It defaults
        # to 15, which out of 30 would be half the run; 8 keeps the fine-tuning
        # tail without dominating a short schedule.
        self.no_aug_epochs = 8

        # Must equal the number of entries in ../labels.txt, or training learns
        # the wrong number of heads and every class index shifts.
        # Five: diver, trash, fish, marine_life, rov. RUOD's ten survey species
        # are collapsed rather than dropped — see labels.txt for why.
        self.num_classes = 5

        # --- dataset (COCO format) ---
        _here = os.path.dirname(os.path.abspath(__file__))
        self.data_dir = os.path.join(_here, "..", "datasets", "seagrass_underwater")
        self.train_ann = "instances_train.json"
        self.val_ann = "instances_val.json"
        # Image directories MUST be train2017/ and val2017/, and there is no
        # setting here that changes it. YOLOX's COCODataset defaults to
        # name="train2017" and get_eval_loader passes name="val2017" outright;
        # the base Exp never forwards `self.name` to either. Setting
        # self.name = "train2024" therefore looked correct, did nothing, and
        # training died on "file named .../train2017/x.jpg not found" while the
        # images sat in train2024/. prepare_dataset.py writes 2017 for this
        # reason — the year is a COCO naming artefact, not a date.

        # --- training schedule (tune for your dataset size) ---
        # 30, not YOLOX's default 100. Most of the learning happens early, and a
        # finished 30-epoch model beats a 100-epoch one killed at hour three by a
        # Colab disconnect. Raise it once a run is known to survive end to end.
        self.max_epoch = 30
        # 2, not 4: a Colab T4 instance has 2 vCPUs, and PyTorch warns that
        # over-subscribing workers can slow the loader down or freeze it. Raise
        # it on a machine with more cores.
        self.data_num_workers = 2
        # Evaluate more often than the default: at 30 epochs a 5-epoch interval
        # gives six chances to write best_ckpt.pth, so an interrupted run still
        # leaves a usable model behind rather than only latest_ckpt.
        self.eval_interval = 3

        # experiment name -> YOLOX_outputs/<exp_name>/
        self.exp_name = os.path.splitext(os.path.basename(__file__))[0]
