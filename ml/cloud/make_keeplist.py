#!/usr/bin/env python3
"""
make_keeplist.py — Turn the review-app export into a committable keep list.

Reads the dataset (tar or dir) + review_flagged.json (written by the Export
button in review.py) and reproduces the review UI's filter logic exactly —
same frame ordering, group splits, ★ references, and thresholds — then applies
the salvage rules to decide, per frame, which boxes survive:

  • unflagged frame                 → keep with all its boxes
  • violin-size outlier (flag2)     → drop entirely
  • full-frame VIOLIN box           → drop the violin box, keep the bow
  • full-frame BOW box              → drop the bow box; keep the violin only
                                      if it is within the group ratio limit
  • nothing survives                → drop the frame

Output: keeplist.json — { frame name → {split, classes} } plus the thresholds
and stats. Small enough to commit; the pod then rebuilds the clean dataset
from its existing copy with apply_keeplist.py (no images move anywhere).

Usage:
    cd ml/cloud
    python3 make_keeplist.py --dataset dataset.tar --review review_flagged.json
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from review import DirBackend, TarBackend, load_frames


def compute_keeplist(frames: list[dict], review: dict) -> tuple[dict, dict]:
    th = review["thresholds"]
    full_t = float(th["full_frame_area"])
    ratio_k = float(th["violin_ratio"])
    use_median = th.get("baseline") == "median"
    refs = [n for n in review.get("references", [])]
    splits = {c: set(v) for c, v in review.get("splits", {}).items()}

    # Group frames per clip in the SAME order the UI displayed them
    # (load_frames yields train split first, then val — matching data.json).
    clips: dict[str, list[dict]] = {}
    by_name: dict[str, dict] = {}
    for f in frames:
        clips.setdefault(f["clip"], []).append(f)
        by_name[f["name"]] = f

    # Segment (group) assignment from user splits
    for clip, lst in clips.items():
        sp = splits.get(clip, set())
        seg = 0
        for idx, f in enumerate(lst):
            if idx > 0 and f["name"] in sp:
                seg += 1
            f["segKey"] = f"{clip}#{seg}"

    # Filter 1: full-frame boxes
    for f in frames:
        f["bow_full"] = f["bow"] is not None and f["bow"] >= full_t
        f["vio_full"] = f["violin"] is not None and f["violin"] >= full_t
        f["flag1"] = f["bow_full"] or f["vio_full"]

    # Per-group violin baseline: ★ reference wins, else smallest/median over
    # the group's non-flag1 frames (identical to the UI, including the
    # median-low convention areas[len >> 1]).
    areas_by_seg: dict[str, list[float]] = {}
    for f in frames:
        if not f["flag1"] and f["violin"] is not None:
            areas_by_seg.setdefault(f["segKey"], []).append(f["violin"])
    base: dict[str, float] = {}
    for key, areas in areas_by_seg.items():
        areas.sort()
        base[key] = areas[len(areas) >> 1] if use_median else areas[0]
    for n in refs:
        rf = by_name.get(n)
        if rf and rf["violin"] is not None:
            base[rf["segKey"]] = rf["violin"]

    # Filter 2 + salvage decisions
    keep: dict[str, dict] = {}
    stats = {"total": len(frames), "kept_clean": 0, "salvaged_bow_only": 0,
             "salvaged_violin_only": 0, "dropped_flag2": 0,
             "dropped_full_frame": 0}

    for f in frames:
        b = base.get(f["segKey"])
        ratio = (f["violin"] / b) if (f["violin"] is not None and b) else None
        flag2 = (not f["flag1"]) and ratio is not None and ratio > ratio_k

        if flag2:
            stats["dropped_flag2"] += 1
            continue

        if not f["flag1"]:
            classes = [c for c in ("bow", "violin") if f[c] is not None]
            keep[f["name"]] = {"split": f["split"], "classes": classes}
            stats["kept_clean"] += 1
            continue

        # Full-frame salvage
        classes = []
        if f["bow"] is not None and not f["bow_full"]:
            classes.append("bow")
        if f["violin"] is not None and not f["vio_full"]:
            # If the BOW was the full-frame box, the violin must additionally
            # be within the group ratio limit to be trusted.
            if not f["bow_full"] or (ratio is not None and ratio <= ratio_k):
                classes.append("violin")

        if not classes:
            stats["dropped_full_frame"] += 1
            continue
        keep[f["name"]] = {"split": f["split"], "classes": classes}
        if classes == ["bow"]:
            stats["salvaged_bow_only"] += 1
        else:
            stats["salvaged_violin_only"] += 1

    return keep, stats


def main():
    parser = argparse.ArgumentParser(description="Build keeplist.json from the review export.")
    parser.add_argument("--dataset", default="dataset.tar",
                        help="dataset.tar or extracted dataset/ directory")
    parser.add_argument("--review", default="review_flagged.json",
                        help="Export from the review app")
    parser.add_argument("--out", default="keeplist.json")
    args = parser.parse_args()

    ds = Path(args.dataset)
    review = json.loads(Path(args.review).read_text())
    backend = DirBackend(ds) if ds.is_dir() else TarBackend(ds)
    frames = load_frames(backend)
    print(f"{len(frames)} labeled frame(s) loaded from {ds.name}")

    keep, stats = compute_keeplist(frames, review)

    out = {
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "thresholds": review["thresholds"],
        "references": review.get("references", []),
        "splits": review.get("splits", {}),
        "stats": stats,
        "frames": keep,
    }
    Path(args.out).write_text(json.dumps(out, indent=1))

    print(f"\n{'─' * 46}")
    for k, v in stats.items():
        print(f"{k:>22}: {v}")
    print(f"{'kept total':>22}: {len(keep)}")
    print(f"\nWrote {args.out}")
    print("Sanity check: kept_clean should equal the UI's 'kept' count at the")
    print("same thresholds (the 'unflagged only' view).")
    print("\nNext: commit keeplist.json, then on the pod:")
    print("  git pull && python apply_keeplist.py --dataset <dataset dir> --out dataset_clean")


if __name__ == "__main__":
    main()
