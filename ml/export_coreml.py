#!/usr/bin/env python3
"""
export_coreml.py — Export trained bow detector to CoreML INT8 for iOS.

Run this after evaluate.py confirms OKS targets are met.

Usage:
    cd ml/
    python export_coreml.py --weights runs/bow/train/weights/best.pt

Output:
    runs/bow/train/weights/best.mlpackage   (~2 MB INT8 quantized)

Then copy to the app:
    cp -r runs/bow/train/weights/best.mlpackage ../modules/pose-camera/ios/bow_detector.mlpackage
"""

import argparse
import shutil
import sys
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description="Export bow detector to CoreML INT8.")
    parser.add_argument("--weights", required=True,      help="Path to best.pt")
    parser.add_argument("--imgsz",   type=int, default=640)
    parser.add_argument("--conf",    type=float, default=0.10,
                        help="NMS confidence floor baked into the CoreML pipeline. Ultralytics "
                             "defaults this to 0.25, which is fine for the bow (BowDetector reports "
                             "at 0.40 anyway) but throws away violin candidates before Swift ever "
                             "sees them — the violin head is calibrated much lower than the bow's "
                             "(see BowDetector.violinConfidenceThreshold). Keep this at/below the "
                             "lowest per-class threshold used on the Swift side.")
    parser.add_argument("--no-nms",  action="store_true",
                        help="Skip baking NMS into model (not recommended — requires manual NMS in Swift)")
    parser.add_argument("--copy",    action="store_true",
                        help="Copy to modules/pose-camera/ios/ without prompting (for automated runs)")
    args = parser.parse_args()

    try:
        from ultralytics import YOLO
    except ImportError:
        print("[ERROR] ultralytics not installed. Run: pip install -r requirements.txt")
        sys.exit(1)

    weights = Path(args.weights)
    if not weights.exists():
        print(f"[ERROR] Weights not found: {weights}", file=sys.stderr)
        sys.exit(1)

    print(f"Loading {weights}...")
    model = YOLO(str(weights))

    print(f"Exporting to CoreML INT8 (imgsz={args.imgsz}, nms={not args.no_nms}, conf={args.conf})...")
    export_path = model.export(
        format="coreml",
        imgsz=args.imgsz,
        nms=not args.no_nms,   # bake NMS into model — simplifies Swift post-processing
        int8=True,             # INT8 quantization: ~2 MB vs ~14 MB fp32
        conf=args.conf,        # NMS confidence floor — see --conf help above
    )

    mlpackage = Path(str(export_path))
    if not mlpackage.exists():
        print(f"[ERROR] Export failed — {mlpackage} not found", file=sys.stderr)
        sys.exit(1)

    size_mb = sum(f.stat().st_size for f in mlpackage.rglob("*") if f.is_file()) / 1e6
    print(f"\nExport complete: {mlpackage.resolve()}")
    print(f"Size: {size_mb:.1f} MB")

    # Compute the copy destination
    repo_root = Path(__file__).parent.parent
    dest = repo_root / "modules" / "pose-camera" / "ios" / "bow_detector.mlpackage"

    print(f"\nTo integrate into the app, run:")
    print(f"  cp -r {mlpackage.resolve()} {dest}")
    print(f"\nOr run automatically:")

    if args.copy:
        do_copy = True
    elif not sys.stdin.isatty():
        # Non-interactive (e.g. orchestrate.py) — don't hang on input(), just skip.
        do_copy = False
        print("Non-interactive run — skipping the copy prompt. Pass --copy to copy automatically.")
    else:
        do_copy = input("Copy to modules/pose-camera/ios/ now? [y/N] ").strip().lower() == "y"

    if do_copy:
        if dest.exists():
            print(f"  Removing existing {dest}...")
            shutil.rmtree(dest)
        shutil.copytree(mlpackage, dest)
        print(f"  Copied to {dest}")
        print(f"\nDone. Rebuild the app in Xcode to pick up the new model.")
    else:
        print("Skipped. Copy manually when ready.")


if __name__ == "__main__":
    main()
