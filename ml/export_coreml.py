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
    parser.add_argument("--no-nms",  action="store_true",
                        help="Skip baking NMS into model (not recommended — requires manual NMS in Swift)")
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

    print(f"Exporting to CoreML INT8 (imgsz={args.imgsz}, nms={not args.no_nms})...")
    export_path = model.export(
        format="coreml",
        imgsz=args.imgsz,
        nms=not args.no_nms,   # bake NMS into model — simplifies Swift post-processing
        int8=True,             # INT8 quantization: ~2 MB vs ~14 MB fp32
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

    answer = input("Copy to modules/pose-camera/ios/ now? [y/N] ").strip().lower()
    if answer == "y":
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
