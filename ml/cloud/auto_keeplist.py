#!/usr/bin/env python3
"""
auto_keeplist.py — Non-interactive keeplist.json generator.

Same output as the review.py (browser) -> make_keeplist.py hand-off, minus
the human: no eyeballing frames, no star references, no group splits. Applies
the same outlier filters (full-frame box / violin-area outlier / violin-width
outlier) at fixed thresholds and writes keeplist.json in the exact schema
apply_keeplist.py already consumes.

Defaults (full_frame_area=0.85, violin_ratio=2.0, baseline=min) are the
thresholds already validated in the last manual review — see the committed
ml/cloud/keeplist.json ("thresholds"). Override via flags if they ever need
retuning.

Clips get no ★ reference and no manual group-split in this mode, so the
per-clip violin-size/width baseline always falls back to "smallest/median
violin box in the clip" — the same fallback compute_keeplist() already uses
for any clip with no reference.

Usage:
    python auto_keeplist.py --dataset dataset/ --out keeplist.json
    python auto_keeplist.py --dataset dataset.tar --full-frame 0.85 --violin-ratio 2.0
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from make_keeplist import compute_keeplist
from review import DirBackend, TarBackend, load_frames


def main():
    parser = argparse.ArgumentParser(description="Build keeplist.json with no human review step.")
    parser.add_argument("--dataset", default="dataset", help="dataset dir or dataset.tar")
    parser.add_argument("--out", default="keeplist.json")
    parser.add_argument("--full-frame", type=float, default=0.85,
                        help="Full-frame box area threshold (default: 0.85, matches last manual review)")
    parser.add_argument("--violin-ratio", type=float, default=2.0,
                        help="Violin-size outlier ratio vs. group baseline (default: 2.0)")
    parser.add_argument("--baseline", default="min", choices=["min", "median"],
                        help="Per-group violin-size baseline for --violin-ratio (default: min)")
    parser.add_argument("--violin-width-low", type=float, default=0.75,
                        help="Drop frames where the violin box width is below this fraction "
                             "of the group's median width (default: 0.75). 0 disables the "
                             "width filter entirely.")
    parser.add_argument("--violin-width-high", type=float, default=None,
                        help="Drop frames where the violin box width is above this multiple "
                             "of the group's median width (default: reciprocal of "
                             "--violin-width-low, e.g. 1.33 for 0.75)")
    args = parser.parse_args()

    ds = Path(args.dataset)
    backend = DirBackend(ds) if ds.is_dir() else TarBackend(ds)
    frames = load_frames(backend)
    print(f"{len(frames)} labeled frame(s) loaded from {ds.name}")

    width_low = args.violin_width_low or None
    width_high = args.violin_width_high or (1 / width_low if width_low else None)

    review = {
        "thresholds": {
            "full_frame_area": args.full_frame,
            "violin_ratio": args.violin_ratio,
            "baseline": args.baseline,
            "violin_width_low": width_low,
            "violin_width_high": width_high,
        },
        "references": [],
        "splits": {},
    }

    keep, stats = compute_keeplist(frames, review)

    if frames and not keep:
        breakdown = ", ".join(f"{k}={v}" for k, v in stats.items() if k != "total")
        raise SystemExit(
            f"[ERROR] 0 of {len(frames)} frame(s) survived filtering ({breakdown}). "
            "Nothing to train on. Likely too aggressive for a small/uniform test batch — "
            "try relaxing --violin-width-low (or 0 to disable), --violin-ratio, or --full-frame, "
            "and rerun `python orchestrate.py` (not --continue, which won't re-filter)."
        )

    out = {
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "thresholds": review["thresholds"],
        "references": [],
        "splits": {},
        "stats": stats,
        "frames": keep,
    }
    Path(args.out).write_text(json.dumps(out, indent=1))

    print(f"\n{'─' * 46}")
    for k, v in stats.items():
        print(f"{k:>22}: {v}")
    print(f"{'kept total':>22}: {len(keep)}")
    print(f"\nWrote {args.out}  (no manual review — fixed thresholds, no references/splits)")


if __name__ == "__main__":
    main()
