#!/usr/bin/env python3
"""Merge public underwater COCO datasets into the layout train.sh expects.

Public underwater datasets do not agree on anything: RUOD calls a sea cucumber
`holothurian`, TrashCan splits rubbish across a dozen `trash_*` categories, and
both number their category ids from 1 with no relation to each other. Training
on more than one means unifying the label space first, and doing that by hand
across ~80k annotations is exactly the sort of job that quietly goes wrong.

    python3 training/scripts/prepare_dataset.py \\
        --source ruod:/data/RUOD/annotations/instances_train.json:/data/RUOD/train \\
        --source trashcan:/data/trashcan/instances_train.trashcan.json:/data/trashcan/train \\
        --split train

Each --source is NAME:ANNOTATIONS_JSON:IMAGE_DIR. Run it once per split.

Two things this is careful about:

  * IDs are re-issued. Merging two COCO files that both start at image id 1
    silently associates annotations with the wrong images, and the result looks
    plausible — boxes land on real pictures, just the wrong ones.

  * Dropped categories are reported loudly. An object left unlabelled does not
    become neutral, it becomes BACKGROUND, actively teaching the model that a
    sea urchin is nothing worth reporting. --drop-unmapped-images excludes those
    images instead, which costs data but does not poison it.
"""
import argparse
import json
import os
import shutil
import sys
from collections import Counter

# Unified label set. Order defines the class index used by the model, the
# detector and the overlay, so it must match labels.txt exactly.
LABELS = [
    "fish",
    "diver",
    "trash",
    "jellyfish",
    "turtle",
    "starfish",
    "urchin",
    "sea_cucumber",
    "scallop",
    "coral",
    "cuttlefish",
    "rov",
]

# Substring rules against the lowercased source category name, FIRST MATCH WINS.
#
# Order is load-bearing and is the whole reason this is a list and not a dict:
# "fish" is a substring of cuttlefish, jellyfish, starfish and TrashCan's
# animal_fish. Put the general rule first and three species collapse into one
# class without a word of complaint. The specific names therefore come first,
# and test_dataset_prep.py pins that ordering so it cannot be tidied away.
RULES = [
    ("cuttlefish", "cuttlefish"),
    ("jellyfish", "jellyfish"),
    ("starfish", "starfish"),
    ("holothurian", "sea_cucumber"),   # RUOD's name for it
    ("sea cucumber", "sea_cucumber"),
    ("echinus", "urchin"),             # RUOD's name for it
    ("urchin", "urchin"),
    ("scallop", "scallop"),
    ("turtle", "turtle"),
    ("coral", "coral"),
    ("diver", "diver"),
    ("rov", "rov"),
    # Every TrashCan rubbish category — trash_bottle, trash_fishing_gear,
    # trash_plastic and the rest — collapses to one class. The distinctions are
    # far finer than a nano model can hold, and "there is debris here" is the
    # actionable fact for an ROV either way.
    ("trash", "trash"),
    ("debris", "trash"),
    # Last two: only reached by names no more specific rule claimed.
    ("eel", "fish"),   # an eel is a fish; TrashCan lists them separately
    ("fish", "fish"),
]

# Rules stop here deliberately. TrashCan also carries animal_crab,
# animal_shells, animal_etc and plant, and guessing at those would be inventing
# classes with unknown data behind them — a class with thirty examples trains
# worse than no class at all. Run with --dry-run first: the UNMAPPED list tells
# you exactly what the datasets you downloaded actually contain and how much of
# it, which is the only sound basis for extending this list.


def map_category(name):
    """Source category name -> unified label, or None if nothing claims it."""
    low = name.strip().lower()
    for pattern, label in RULES:
        if pattern in low:
            return label
    return None


def load_coco(path):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def merge(sources, drop_unmapped_images=False):
    """Merge COCO dicts into one with a unified, re-indexed label space.

    `sources` is [(name, coco_dict)]. Returns (merged, stats).
    """
    label_index = {name: i for i, name in enumerate(LABELS)}
    out_images, out_anns = [], []
    per_class = Counter()
    unmapped = Counter()
    skipped_images = 0
    next_image_id = 1
    next_ann_id = 1

    for source_name, coco in sources:
        cats = {c["id"]: c["name"] for c in coco.get("categories", [])}
        by_image = {}
        for ann in coco.get("annotations", []):
            by_image.setdefault(ann["image_id"], []).append(ann)

        for img in coco.get("images", []):
            anns = by_image.get(img["id"], [])
            mapped, has_unmapped = [], False
            for ann in anns:
                label = map_category(cats.get(ann["category_id"], ""))
                if label is None:
                    unmapped[cats.get(ann["category_id"], "?")] += 1
                    has_unmapped = True
                    continue
                mapped.append((ann, label))

            # An image whose only content is unmapped teaches nothing but
            # background, so it is dropped either way.
            if not mapped:
                skipped_images += 1
                continue
            if has_unmapped and drop_unmapped_images:
                skipped_images += 1
                continue

            image_id = next_image_id
            next_image_id += 1
            out_images.append({
                **img,
                "id": image_id,
                # Namespaced so two datasets containing "000001.jpg" cannot
                # overwrite each other when the images are copied.
                "file_name": f"{source_name}_{os.path.basename(img['file_name'])}",
                "_src_file": img["file_name"],
                "_src": source_name,
            })
            for ann, label in mapped:
                out_anns.append({
                    **ann,
                    "id": next_ann_id,
                    "image_id": image_id,
                    "category_id": label_index[label],
                    # Segmentation is dropped: these are detection labels, and
                    # TrashCan's polygons would otherwise bloat the file for a
                    # box-only trainer that ignores them.
                    "segmentation": [],
                })
                next_ann_id += 1
                per_class[label] += 1

    merged = {
        "images": out_images,
        "annotations": out_anns,
        "categories": [{"id": i, "name": n, "supercategory": "underwater"}
                       for i, n in enumerate(LABELS)],
    }
    stats = {"per_class": per_class, "unmapped": unmapped,
             "skipped_images": skipped_images, "images": len(out_images)}
    return merged, stats


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", action="append", required=True,
                    metavar="NAME:ANNOTATIONS_JSON:IMAGE_DIR")
    ap.add_argument("--split", choices=["train", "val"], required=True)
    ap.add_argument("--out", default=None,
                    help="dataset root (default: training/datasets/seagrass_underwater)")
    ap.add_argument("--drop-unmapped-images", action="store_true",
                    help="exclude images containing unmapped objects rather than "
                         "letting those objects become background")
    ap.add_argument("--symlink", action="store_true",
                    help="link images instead of copying (saves disk, needs the "
                         "source to stay put)")
    ap.add_argument("--dry-run", action="store_true",
                    help="report what would be written without touching disk")
    args = ap.parse_args()

    here = os.path.dirname(os.path.abspath(__file__))
    root = args.out or os.path.join(here, "..", "datasets", "seagrass_underwater")

    sources, image_dirs = [], {}
    for spec in args.source:
        parts = spec.split(":")
        if len(parts) != 3:
            sys.exit(f"--source must be NAME:ANNOTATIONS_JSON:IMAGE_DIR, got {spec!r}")
        name, ann_path, img_dir = parts
        if not os.path.exists(ann_path):
            sys.exit(f"no annotations at {ann_path}")
        sources.append((name, load_coco(ann_path)))
        image_dirs[name] = img_dir

    merged, stats = merge(sources, drop_unmapped_images=args.drop_unmapped_images)

    print(f"\n{stats['images']} images, {len(merged['annotations'])} annotations")
    print("\nper class:")
    for label in LABELS:
        n = stats["per_class"][label]
        # Flagged because a class the model never sees cannot be detected, and
        # an always-silent class is indistinguishable from a broken detector.
        flag = "   <-- NO DATA" if n == 0 else ""
        print(f"  {label:14s} {n:7d}{flag}")
    if stats["unmapped"]:
        print("\nUNMAPPED categories — these objects became BACKGROUND, which "
              "teaches the model to ignore them.\nAdd a rule in RULES, or re-run "
              "with --drop-unmapped-images:")
        for name, n in stats["unmapped"].most_common():
            print(f"  {name:24s} {n:7d}")
    if stats["skipped_images"]:
        print(f"\nskipped {stats['skipped_images']} images with no mappable objects")

    if args.dry_run:
        print("\n(dry run — nothing written)")
        return

    # 2017, not 2024. YOLOX's COCODataset hardcodes name="train2017" and
    # get_eval_loader passes name="val2017"; the Exp's `self.name` is never
    # forwarded to either, so setting it does nothing and training dies with
    # "file named .../train2017/x.jpg not found" while the images sit in a
    # directory named after the year you actually built them. Matching YOLOX's
    # expectation is far less fragile than overriding its data loaders.
    img_out = os.path.join(root, f"{args.split}2017")
    ann_out = os.path.join(root, "annotations")
    os.makedirs(img_out, exist_ok=True)
    os.makedirs(ann_out, exist_ok=True)

    missing = 0
    for img in merged["images"]:
        src = os.path.join(image_dirs[img["_src"]], img.pop("_src_file"))
        dst = os.path.join(img_out, img["file_name"])
        img.pop("_src")
        if os.path.exists(dst):
            continue
        if not os.path.exists(src):
            missing += 1
            continue
        if args.symlink:
            os.symlink(os.path.abspath(src), dst)
        else:
            shutil.copy2(src, dst)
    if missing:
        print(f"\nWARNING: {missing} images listed in the annotations were not "
              f"found on disk")

    ann_path = os.path.join(ann_out, f"instances_{args.split}.json")
    with open(ann_path, "w", encoding="utf-8") as fh:
        json.dump(merged, fh)
    print(f"\nwrote {ann_path}")
    print(f"wrote images -> {img_out}")
    print(f"\nSet num_classes = {len(LABELS)} in configs/yolox_nano_seagrass.py, "
          f"and keep labels.txt in this exact order.")


if __name__ == "__main__":
    main()
