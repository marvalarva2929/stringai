#!/usr/bin/env python3
"""
sample_annotated.py — bundle a bounded, evenly-spread sample of
dataset/annotated/ preview images (bow+violin boxes drawn) into a small
tarball, so orchestrate.py can pull back something reviewable after the
label stage without dragging every frame across the wire.

With --keeplist, samples only from frames that survived filtering (i.e.
what train_detect.py will actually train on) rather than every raw
auto-labeled frame — the point of the preview is to sanity-check the
combination of auto-labeling AND the filter's decisions, not just the model.

Usage (run on the pod):
    python3 sample_annotated.py --dataset dataset --keeplist keeplist.json \\
        --cap 60 --out _label_preview.tgz
"""

import argparse
import json
import tarfile
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", default="dataset")
    parser.add_argument("--keeplist", default=None,
                        help="If given, sample only frames that survived this "
                             "keeplist.json's filtering")
    parser.add_argument("--cap", type=int, default=60, help="Max frames to sample")
    parser.add_argument("--out", default="_label_preview.tgz")
    args = parser.parse_args()

    all_annotated = sorted(Path(args.dataset, "annotated").glob("*.jpg"))
    if args.keeplist:
        kept_names = set(json.loads(Path(args.keeplist).read_text())["frames"].keys())
        annotated = [p for p in all_annotated if p.stem in kept_names]
        label = "kept (post-filter)"
    else:
        annotated = all_annotated
        label = "annotated"

    step = max(1, len(annotated) // args.cap) if annotated else 1
    sample = annotated[::step][: args.cap]

    with tarfile.open(args.out, "w:gz") as tf:
        for p in sample:
            tf.add(p, arcname=p.name)

    print(f"{len(sample)} of {len(annotated)} {label} frames sampled -> {args.out}")


if __name__ == "__main__":
    main()
