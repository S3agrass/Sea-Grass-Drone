"""Tests for the underwater dataset merge (training/scripts/prepare_dataset.py).

Runs on synthetic COCO dicts — no downloads, no GPU. The two things pinned here
both fail SILENTLY on real data, which is why they are worth testing rather than
eyeballing:

  - Substring rule order. "fish" is inside cuttlefish, jellyfish, starfish and
    TrashCan's animal_fish. Get the order wrong and four species quietly become
    one class; nothing errors, the model just learns something wrong.
  - ID re-issuing. Two COCO files both starting at image id 1 will happily merge
    into a file where annotations point at the wrong images. Every box still
    lands on a real photo, just not the one it was drawn on.

    python3 test_dataset_prep.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "training", "scripts"))

import prepare_dataset as pd  # noqa: E402

FAILURES = []


def check(name, condition, detail=""):
    print(f"  [{'PASS' if condition else 'FAIL'}] {name}{'  — ' + detail if detail else ''}")
    if not condition:
        FAILURES.append(name)


def coco(cats, images, anns):
    """Minimal COCO dict. cats is {id: name}; anns is [(image_id, cat_id)]."""
    return {
        "categories": [{"id": i, "name": n} for i, n in cats.items()],
        "images": [{"id": i, "file_name": f, "width": 640, "height": 480}
                   for i, f in images],
        "annotations": [{"id": j + 1, "image_id": im, "category_id": c,
                         "bbox": [1, 2, 3, 4], "area": 12, "iscrowd": 0,
                         "segmentation": [[1, 2, 3, 4, 5, 6]]}
                        for j, (im, c) in enumerate(anns)],
    }


def test_rule_order():
    print("\n=== Species containing 'fish' are not swallowed by 'fish' ===")
    # These three end up in marine_life, but only because their rules come
    # BEFORE the general "fish" one. Reorder and they silently become fish.
    check("cuttlefish", pd.map_category("cuttlefish") == "marine_life")
    check("jellyfish", pd.map_category("jellyfish") == "marine_life")
    check("starfish", pd.map_category("starfish") == "marine_life")
    check("plain fish still maps to fish", pd.map_category("fish") == "fish")
    check("TrashCan's animal_fish maps to fish",
          pd.map_category("animal_fish") == "fish")


def test_survey_species_collapse():
    print("\n=== RUOD's aquaculture species collapse into marine_life ===")
    # RUOD distinguishes ten species because it was built for Chinese fishery
    # surveys. A seagrass drone acts identically on all of them, and collapsing
    # rather than dropping is what stops them becoming background.
    for name in ("holothurian", "echinus", "scallop", "corals", "turtle",
                 "animal_crab", "animal_shells"):
        check(f"{name} -> marine_life", pd.map_category(name) == "marine_life")
    check("case and whitespace ignored",
          pd.map_category("  Holothurian ") == "marine_life")


def test_decision_classes_stay_distinct():
    print("\n=== The classes the drone acts on are never merged ===")
    # diver is safety critical and must never collapse into anything.
    check("diver stays its own class", pd.map_category("diver") == "diver")
    check("rov stays its own class", pd.map_category("rov") == "rov")
    check("trash stays its own class", pd.map_category("trash_bottle") == "trash")
    check("fish is not marine_life", pd.map_category("fish") == "fish")
    check("all five labels are reachable",
          {pd.map_category(n) for n in
           ("diver", "rov", "trash_bag", "animal_fish", "echinus")} == set(pd.LABELS),
          str(sorted(pd.LABELS)))


def test_vegetation_is_not_a_class():
    print("\n=== Vegetation is left unmapped, not bucketed ===")
    # TrashCan's `plant` is ground cover, the same reason seagrass and kelp are
    # absent. Quietly folding it into marine_life would put a box round a
    # texture and teach the model an edge that does not exist.
    check("plant is unmapped", pd.map_category("plant") is None)


def test_trash_collapses():
    print("\n=== Every rubbish subcategory collapses to one class ===")
    for name in ("trash_bottle", "trash_fishing_gear", "trash_plastic",
                 "trash_unknown_instance", "marine debris"):
        check(f"{name} -> trash", pd.map_category(name) == "trash")


def test_unmapped_is_reported_not_hidden():
    print("\n=== Unknown categories are surfaced, never silently dropped ===")
    check("unknown returns None", pd.map_category("sea_squirt") is None)
    merged, stats = pd.merge([("x", coco(
        {1: "fish", 2: "sea_squirt"},
        [(1, "a.jpg")],
        [(1, 1), (1, 2)],
    ))])
    check("the unmapped one is counted", stats["unmapped"]["sea_squirt"] == 1)
    check("the mapped one survives", len(merged["annotations"]) == 1)


def test_ids_are_reissued_across_sources():
    print("\n=== Merging two datasets keeps boxes on their own images ===")
    # Both sources number from 1. Without re-issuing, source B's annotations
    # would attach to source A's images and the error would be invisible.
    a = coco({1: "fish"}, [(1, "a1.jpg"), (2, "a2.jpg")], [(1, 1), (2, 1)])
    b = coco({1: "diver"}, [(1, "b1.jpg"), (2, "b2.jpg")], [(1, 1), (2, 1)])
    merged, _ = pd.merge([("ruod", a), ("trashcan", b)])

    check("all images kept", len(merged["images"]) == 4)
    ids = [i["id"] for i in merged["images"]]
    check("image ids are unique", len(set(ids)) == 4, str(ids))
    ann_ids = [x["id"] for x in merged["annotations"]]
    check("annotation ids are unique", len(set(ann_ids)) == 4, str(ann_ids))

    by_id = {i["id"]: i for i in merged["images"]}
    fish = pd.LABELS.index("fish")
    diver = pd.LABELS.index("diver")
    for ann in merged["annotations"]:
        src = by_id[ann["image_id"]]["file_name"]
        want = fish if src.startswith("ruod_") else diver
        if ann["category_id"] != want:
            check("every box stayed with its own dataset", False, src)
            return
    check("every box stayed with its own dataset", True)


def test_filenames_are_namespaced():
    print("\n=== Identically-named images from two datasets cannot collide ===")
    a = coco({1: "fish"}, [(1, "000001.jpg")], [(1, 1)])
    b = coco({1: "fish"}, [(1, "000001.jpg")], [(1, 1)])
    merged, _ = pd.merge([("ruod", a), ("trashcan", b)])
    names = sorted(i["file_name"] for i in merged["images"])
    check("both survive with distinct names",
          names == ["ruod_000001.jpg", "trashcan_000001.jpg"], str(names))


def test_category_ids_are_contiguous_from_zero():
    print("\n=== Output category ids match the label list exactly ===")
    # YOLOX indexes classes 0..num_classes-1 against labels.txt order; a gap or
    # an off-by-one here mislabels every detection at inference time.
    merged, _ = pd.merge([("x", coco({7: "diver"}, [(1, "a.jpg")], [(1, 7)]))])
    check("remapped to the label index",
          merged["annotations"][0]["category_id"] == pd.LABELS.index("diver"))
    ids = [c["id"] for c in merged["categories"]]
    check("categories are 0..n-1", ids == list(range(len(pd.LABELS))), str(ids[:5]))


def test_drop_unmapped_images_option():
    print("\n=== --drop-unmapped-images trades data for cleanliness ===")
    # An image holding one known and one unknown object: keeping it teaches the
    # unknown thing is background, dropping it loses a usable fish.
    c = coco({1: "fish", 2: "sea_squirt"}, [(1, "a.jpg"), (2, "b.jpg")],
             [(1, 1), (1, 2), (2, 1)])
    kept, _ = pd.merge([("x", c)])
    check("kept by default", len(kept["images"]) == 2)
    dropped, stats = pd.merge([("x", c)], drop_unmapped_images=True)
    check("contaminated image excluded", len(dropped["images"]) == 1)
    check("the clean image survives",
          dropped["images"][0]["file_name"] == "x_b.jpg")
    check("the drop is counted", stats["skipped_images"] == 1)


def test_labels_match_the_shipped_list():
    print("\n=== LABELS stays in step with training/labels.txt ===")
    # These two drifting apart shifts every class index, so the model reports
    # confident boxes under the wrong names.
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        "training", "labels.txt")
    with open(path, encoding="utf-8") as fh:
        from_file = [s for s in (l.strip() for l in fh)
                     if s and not s.startswith("#")]
    check("same order and contents", from_file == pd.LABELS,
          f"file={from_file[:4]}... code={pd.LABELS[:4]}...")


if __name__ == "__main__":
    test_rule_order()
    test_survey_species_collapse()
    test_decision_classes_stay_distinct()
    test_vegetation_is_not_a_class()
    test_trash_collapses()
    test_unmapped_is_reported_not_hidden()
    test_ids_are_reissued_across_sources()
    test_filenames_are_namespaced()
    test_category_ids_are_contiguous_from_zero()
    test_drop_unmapped_images_option()
    test_labels_match_the_shipped_list()

    print()
    if FAILURES:
        raise SystemExit(f"FAILED: {', '.join(FAILURES)}")
    print("All dataset prep checks passed.")
