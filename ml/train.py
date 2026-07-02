#!/usr/bin/env python3
"""
train.py — Train YOLOv8n-pose bow keypoint detector.

Requires labeled data exported from Roboflow in YOLOv8 Pose format.
Place exported dataset in ml/data/ (should contain images/train, images/val,
labels/train, labels/val).

Usage:
    cd ml/
    python train.py

    # Resume interrupted run:
    python train.py --resume runs/bow/train/weights/last.pt

    # Quick smoke-test with fewer epochs:
    python train.py --epochs 10 --name smoke_test
"""

import argparse
import sys
from pathlib import Path


def main():
    try:
        from ultralytics import YOLO
    except ImportError:
        print("[ERROR] ultralytics not installed. Run: pip install -r requirements.txt")
        sys.exit(1)

    parser = argparse.ArgumentParser(description="Train YOLOv8-pose bow keypoint detector.")
    parser.add_argument("--model",   default="yolov8n-pose.pt", help="Base model weights (e.g. yolov8s-pose.pt)")
    parser.add_argument("--resume",  default=None,        help="Resume from checkpoint .pt file")
    parser.add_argument("--epochs",  type=int, default=150)
    parser.add_argument("--batch",   type=int, default=16, help="Batch size (-1 = auto)")
    parser.add_argument("--name",    default="train",     help="Run name under runs/bow/")
    parser.add_argument("--device",  default=None,        help="Device: cpu, mps, 0 (GPU). Default: auto")
    args = parser.parse_args()

    data_yaml = Path(__file__).parent / "data.yaml"
    if not data_yaml.exists():
        print(f"[ERROR] data.yaml not found at {data_yaml}", file=sys.stderr)
        sys.exit(1)

    # Check that training data exists
    train_images = Path(__file__).parent / "data" / "images" / "train"
    if not train_images.exists() or not any(train_images.iterdir()):
        print(f"[ERROR] No training images found at {train_images}", file=sys.stderr)
        print("Export your Roboflow dataset in YOLOv8 Pose format and place it in ml/data/")
        sys.exit(1)

    if args.resume:
        print(f"Resuming from {args.resume}")
        model = YOLO(args.resume)
        results = model.train(resume=True)
    else:
        model = YOLO(args.model)

        train_kwargs = dict(
            data=str(data_yaml),
            epochs=args.epochs,
            imgsz=640,
            batch=args.batch,
            optimizer="AdamW",
            lr0=0.001,
            lrf=0.01,           # final LR = lr0 * lrf
            warmup_epochs=3,
            augment=True,
            fliplr=0.5,         # horizontal flip (tip/frog swap handled by flip_idx in data.yaml)
            degrees=10,         # bow angles vary; small rotation is valid augmentation
            hsv_v=0.4,          # brightness variation for different lighting conditions
            mosaic=1.0,
            project="runs/bow",
            name=args.name,
            exist_ok=False,
            save=True,
            save_period=10,     # save checkpoint every 10 epochs
            val=True,
            plots=True,
        )

        if args.device is not None:
            train_kwargs["device"] = args.device

        print(f"Training {args.model} for {args.epochs} epochs on {data_yaml}")
        print(f"Output: runs/bow/{args.name}/\n")

        results = model.train(**train_kwargs)

    best_path = Path(f"runs/bow/{args.name}/weights/best.pt")
    print(f"\nTraining complete.")
    print(f"Best weights: {best_path.resolve()}")
    print(f"\nNext steps:")
    print(f"  1. Evaluate:  python evaluate.py --weights {best_path}")
    print(f"  2. Export:    python export_coreml.py --weights {best_path}")


if __name__ == "__main__":
    main()
