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

        # Must equal the number of entries in ../labels.txt. Currently the 12
        # classes that RUOD + TrashCan between them actually provide; change it
        # if you change that file, or training silently learns the wrong number
        # of heads and every class index shifts.
        self.num_classes = 12

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
        self.max_epoch = 100
        # 2, not 4: a Colab T4 instance has 2 vCPUs, and PyTorch warns that
        # over-subscribing workers can slow the loader down or freeze it. Raise
        # it on a machine with more cores.
        self.data_num_workers = 2
        self.eval_interval = 5

        # experiment name -> YOLOX_outputs/<exp_name>/
        self.exp_name = os.path.splitext(os.path.basename(__file__))[0]
