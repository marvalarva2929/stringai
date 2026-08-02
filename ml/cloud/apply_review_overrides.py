#!/usr/bin/env python3
"""
apply_review_overrides.py — Apply review.py's manual exclusions/box edits
(review_flagged.json) onto a materialized dataset (e.g. dataset_clean/):

  - "excluded" frames: image + label removed from every split they're in.
  - "manual_labels" frames: label file overwritten with the hand-edited
    boxes; if the frame isn't already present in --dataset (e.g. the
    auto-filter dropped it and the reviewer manually rescued it via the box
    editor), the raw image is pulled in from --source.

Edits --dataset in place by default; pass --out for a copy instead.

Usage:
    python3 apply_review_overrides.py --dataset dataset_clean \
        --review review_flagged.json --source dataset.tar
    python3 train_detect.py --data dataset_clean/data.yaml --device 0
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path


def write_label(path: Path, boxes: list[dict]) -> None:
    lines = [f"{b['cls']} {b['cx']:.6f} {b['cy']:.6f} {b['w']:.6f} {b['h']:.6f}" for b in boxes]
    path.write_text("\n".join(lines) + ("\n" if lines else ""))


def main():
    parser = argparse.ArgumentParser(description="Apply review.py's manual exclusions/edits to a dataset.")
    parser.add_argument("--dataset", required=True, help="Materialized dataset dir (e.g. dataset_clean)")
    parser.add_argument("--review", default="review_flagged.json")
    parser.add_argument("--source", help="Raw dataset dir or dataset.tar — needed to pull in images "
                                          "for manually re-labeled frames not already in --dataset")
    parser.add_argument("--out", help="Write to a copy instead of editing --dataset in place")
    args = parser.parse_args()

    ds = Path(args.dataset).resolve()
    if not (ds / "images").is_dir() or not (ds / "labels").is_dir():
        sys.exit(f"[ERROR] {ds} does not look like a dataset (needs images/ and labels/)")

    review = json.loads(Path(args.review).read_text())
    excluded = review.get("excluded", [])
    manual = review.get("manual_labels", {})
    if not excluded and not manual:
        sys.exit("[ERROR] review file has no excluded frames or manual_labels — nothing to apply.")

    if args.out:
        out = Path(args.out).resolve()
        if out.exists():
            shutil.rmtree(out)
        shutil.copytree(ds, out)
        ds = out
    print(f"Applying to: {ds}")

    source_backend = None
    if args.source:
        src = Path(args.source)
        if src.is_dir():
            from review import DirBackend
            source_backend = DirBackend(src)
        else:
            from review import TarBackend
            print(f"Indexing {src.name} …")
            source_backend = TarBackend(src)

    n_removed = 0
    for name in excluded:
        for split in ("train", "val"):
            img = ds / "images" / split / f"{name}.jpg"
            lbl = ds / "labels" / split / f"{name}.txt"
            if img.exists() or img.is_symlink():
                img.unlink()
                n_removed += 1
            if lbl.exists():
                lbl.unlink()

    n_written = n_added = n_missing = 0
    for name, info in manual.items():
        if name in excluded:
            continue  # exclusion wins over a stale manual edit
        split = info.get("split", "train")
        boxes = info.get("boxes", [])
        img = ds / "images" / split / f"{name}.jpg"
        lbl = ds / "labels" / split / f"{name}.txt"
        if not boxes:
            # no boxes left after manual edit — drop the frame entirely
            if img.exists() or img.is_symlink():
                img.unlink()
            if lbl.exists():
                lbl.unlink()
            continue
        lbl.parent.mkdir(parents=True, exist_ok=True)
        img.parent.mkdir(parents=True, exist_ok=True)
        write_label(lbl, boxes)
        n_written += 1
        if not img.exists() and not img.is_symlink():
            if source_backend is None:
                n_missing += 1
                continue
            img_bytes = source_backend.read_image(name, split, "raw")
            if img_bytes is None:
                n_missing += 1
                continue
            img.write_bytes(img_bytes)
            n_added += 1

    n_train = len(list((ds / "images" / "train").glob("*.jpg")))
    n_val = len(list((ds / "images" / "val").glob("*.jpg")))
    print(f"\n{'─' * 46}")
    print(f"{'excluded removed':>20}: {n_removed}")
    print(f"{'labels rewritten':>20}: {n_written}")
    print(f"{'images added':>20}: {n_added}")
    if n_missing:
        print(f"{'images MISSING':>20}: {n_missing}  (pass --source to pull these in)")
    print(f"{'train/val now':>20}: {n_train}/{n_val}")


if __name__ == "__main__":
    main()
