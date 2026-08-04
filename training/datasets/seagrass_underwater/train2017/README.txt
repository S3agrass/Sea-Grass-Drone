Training images go here.

The directory MUST be named train2017 — YOLOX's COCODataset hardcodes that name
and ignores the Exp's self.name, so a train2024/ built by an older version of
prepare_dataset.py fails at the first batch with "file named .../train2017/x.jpg
not found". The year is a COCO naming artefact, not a date.

Populate it with scripts/prepare_dataset.py rather than by hand — see the
training README.
