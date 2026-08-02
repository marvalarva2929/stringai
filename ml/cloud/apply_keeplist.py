#!/usr/bin/env python3
"""
apply_keeplist.py — Build the cleaned training dataset from keeplist.json.

Run on the machine that already has the full dataset/ directory (the pod).
Creates <out>/ with:
  - images/{train,val}/  → SYMLINKS into the existing dataset (no copies,
    nothing moves; pass --copy for real copies if symlinks are a problem)
  - labels/{train,val}/  → freshly written labels containing ONLY the classes
    the keep list retained for that frame (e.g. a full-frame violin box is
    dropped while the bow line survives)
  - data.yaml            → ready for train_detect.py

The original dataset/ is never modified.

Usage (pod):
    cd ml/cloud            # after git pull brought keeplist.json
    python apply_keeplist.py --dataset /workspace/dataset --out /workspace/dataset_clean
    python train_detect.py --data /workspace/dataset_clean/data.yaml --device 0

--dataset may also be an uncompressed dataset.tar (local training without a
full extraction): kept images are extracted, labels written filtered — the
result only needs space for the kept frames, not the whole dataset.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from pathlib import Path

CLASS_IDS = {"bow": 0, "violin": 1}


def main():
    parser = argparse.ArgumentParser(description="Materialize the cleaned dataset from keeplist.json.")
    parser.add_argument("--dataset", required=True, help="Existing full dataset directory")
    parser.add_argument("--keeplist", default="keeplist.json")
    parser.add_argument("--out", default="dataset_clean")
    parser.add_argument("--copy", action="store_true",
                        help="Copy images instead of symlinking")
    args = parser.parse_args()

    ds = Path(args.dataset).resolve()
    out = Path(args.out).resolve()
    tar_backend = None
    if ds.is_dir():
        if not (ds / "images").is_dir() or not (ds / "labels").is_dir():
            sys.exit(f"[ERROR] {ds} does not look like a dataset (needs images/ and labels/)")
        if out == ds:
            sys.exit("[ERROR] --out must differ from --dataset")
    else:
        from review import TarBackend  # same-directory module
        print(f"Indexing {ds.name} …")
        tar_backend = TarBackend(ds)

    # --out persists across runs (e.g. on a pod between orchestrate.py
    # invocations) and this only ever ADDS/overwrites files for frames in
    # the current keep list — it never removes ones that dropped out of an
    # earlier keep list (different thresholds, a filter change, etc.), so
    # without this the dataset silently accumulates stale frames run over
    # run. Always rebuild from scratch instead.
    if out.exists():
        shutil.rmtree(out)

    keeplist = json.loads(Path(args.keeplist).read_text())
    frames = keeplist["frames"]
    print(f"Keep list: {len(frames)} frame(s)  (generated {keeplist.get('generated_at')})")

    for split in ("train", "val"):
        (out / "images" / split).mkdir(parents=True, exist_ok=True)
        (out / "labels" / split).mkdir(parents=True, exist_ok=True)

    stats = {"linked": 0, "labels_written": 0, "lines_dropped": 0,
             "missing_image": 0, "missing_label": 0}

    import time
    t0 = time.time()
    done = 0
    for name, info in frames.items():
        done += 1
        if done % 500 == 0:
            rate = done / (time.time() - t0)
            eta = (len(frames) - done) / rate / 60
            print(f"  [{done}/{len(frames)}]  {rate:.0f} frames/s, ETA {eta:.1f}m", flush=True)
        split = info["split"]
        wanted_ids = {CLASS_IDS[c] for c in info["classes"]}

        if tar_backend is not None:
            img_bytes = tar_backend.read_image(name, split, "raw")
            lbl_bytes = tar_backend._read(f"{tar_backend.prefix}labels/{split}/{name}.txt")
            if img_bytes is None:
                stats["missing_image"] += 1
                continue
            if lbl_bytes is None:
                stats["missing_label"] += 1
                continue
            label_text = lbl_bytes.decode("utf-8", "replace")
        else:
            src_img = ds / "images" / split / f"{name}.jpg"
            src_lbl = ds / "labels" / split / f"{name}.txt"
            if not src_img.exists():
                stats["missing_image"] += 1
                continue
            if not src_lbl.exists():
                stats["missing_label"] += 1
                continue
            label_text = src_lbl.read_text()

        kept_lines = []
        for line in label_text.splitlines():
            parts = line.split()
            if len(parts) == 5 and int(parts[0]) in wanted_ids:
                kept_lines.append(line)
            elif parts:
                stats["lines_dropped"] += 1
        if not kept_lines:  # shouldn't happen — keep list guarantees ≥1 class
            continue

        dst_img = out / "images" / split / f"{name}.jpg"
        dst_lbl = out / "labels" / split / f"{name}.txt"
        dst_lbl.write_text("\n".join(kept_lines) + "\n")
        stats["labels_written"] += 1

        if dst_img.exists() or dst_img.is_symlink():
            dst_img.unlink()
        if tar_backend is not None:
            dst_img.write_bytes(img_bytes)
        elif args.copy:
            shutil.copy2(src_img, dst_img)
        else:
            dst_img.symlink_to(os.path.relpath(src_img, dst_img.parent))
        stats["linked"] += 1

    # The train/val split is decided once, back in autolabel.py (baked into
    # which dir a frame's files land in), then just carried through here —
    # so a small batch or aggressive filtering can easily leave val empty by
    # chance, which crashes train_detect.py outright. Rescue a few frames
    # from train rather than let that happen.
    val_imgs = sorted((out / "images" / "val").glob("*.jpg"))
    train_imgs = sorted((out / "images" / "train").glob("*.jpg"))
    if not val_imgs and not train_imgs:
        sys.exit(
            f"[ERROR] 0 frame(s) linked into {out} from a keep list of {len(frames)} "
            f"({stats['missing_image']} missing image, {stats['missing_label']} missing "
            "label). Nothing to rescue — there's no train split to pull val frames from "
            "either. auto_keeplist.py should have caught an empty keep list before this "
            "point; if you're seeing this, the keeplist and dataset/ are probably out of "
            "sync (e.g. --continue reusing a stale dataset_clean from before a filter "
            "change) — rerun `python orchestrate.py` fresh, not --continue."
        )
    if not val_imgs and train_imgs:
        n_move = max(1, len(train_imgs) // 10)
        rescued = train_imgs[:n_move]
        for img_path in rescued:
            name = img_path.stem
            for kind, ext in (("images", ".jpg"), ("labels", ".txt")):
                src = out / kind / "train" / f"{name}{ext}"
                dst = out / kind / "val" / f"{name}{ext}"
                if src.is_symlink():
                    target = os.readlink(src)
                    src.unlink()
                    dst.symlink_to(target)
                elif src.exists():
                    shutil.move(str(src), str(dst))
        print(f"[WARN] val split was empty after filtering — moved {len(rescued)} "
              "frame(s) from train to val so train_detect.py doesn't crash on an "
              "empty validation set. Expected on small test batches; with more "
              "footage val_fraction=0.1 won't land on zero.")

    yaml_path = out / "data.yaml"
    yaml_path.write_text(
        f"path: {out}\n"
        "train: images/train\n"
        "val: images/val\n"
        "nc: 2\n"
        "names: ['bow', 'violin']\n"
    )

    print(f"\n{'─' * 46}")
    for k, v in stats.items():
        print(f"{k:>16}: {v}")
    n_train = len(list((out / "images" / "train").glob("*.jpg")))
    n_val = len(list((out / "images" / "val").glob("*.jpg")))
    print(f"{'train/val':>16}: {n_train}/{n_val}")
    print(f"\nClean dataset: {out}")
    print(f"\nTrain with:\n  python train_detect.py --data {yaml_path} --device 0")


if __name__ == "__main__":
    main()
