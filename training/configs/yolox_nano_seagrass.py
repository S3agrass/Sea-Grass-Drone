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

        # --- CHANGE THIS to len(labels.txt) ---
        self.num_classes = 4

        # --- dataset (COCO format) ---
        _here = os.path.dirname(os.path.abspath(__file__))
        self.data_dir = os.path.join(_here, "..", "datasets", "seagrass_underwater")
        self.train_ann = "instances_train.json"
        self.val_ann = "instances_val.json"
        self.name = "train2024"       # image sub-dir for training
        # (YOLOX reads val images from a dir named after the val ann by default;
        #  keep val images in val2024/ and adjust here if your layout differs.)

        # --- training schedule (tune for your dataset size) ---
        self.max_epoch = 100
        self.data_num_workers = 4
        self.eval_interval = 5

        # experiment name -> YOLOX_outputs/<exp_name>/
        self.exp_name = os.path.splitext(os.path.basename(__file__))[0]
