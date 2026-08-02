#!/usr/bin/env python3
"""
train_detect.py — Train the on-device YOLOv8n bow + violin detector.

Trains on the 2-class detect dataset produced by autolabel.py (class 0 = bow,
class 1 = violin). This replaces the old 3-keypoint pose model: keypoints
(tip/frog/contact) are now derived geometrically in the app from the two boxes
plus pose landmarks.

Usage (GPU instance):
    python train_detect.py --device 0

    # Mac (MPS) — slower but fine for yolov8n:
    python train_detect.py --device mps

    # Quick smoke test:
    python train_detect.py --epochs 10 --name smoke

Writes train_output_dir.txt containing ultralytics' ACTUAL resolved output
directory once training completes — don't assume it's runs/bow_detect/<name>/
(project=/name= are hints, not guarantees; observed on RunPod pods landing at
runs/detect/runs/bow_detect/<name>/ instead, likely from a settings.yaml
runs_dir override). orchestrate.py reads this file rather than hardcoding a
path. If running by hand, check the printed "Best weights:" line instead.

Then export on the Mac:
    python ../export_coreml.py --weights <path from the "Best weights:" line>
"""

import argparse
import sys
from pathlib import Path


def main():
    try:
        from ultralytics import YOLO
    except ImportError:
        print("[ERROR] ultralytics not installed. Run: pip install ultralytics")
        sys.exit(1)

    parser = argparse.ArgumentParser(description="Train YOLOv8 bow+violin detector.")
    parser.add_argument("--model", default="yolov8n.pt", help="Base weights (yolov8n.pt / yolov8s.pt)")
    parser.add_argument("--data", default=None, help="Dataset yaml (default: data_detect.yaml next to this file)")
    parser.add_argument("--resume", default=None, help="Resume from checkpoint .pt")
    parser.add_argument("--epochs", type=int, default=100)
    parser.add_argument("--batch", type=int, default=16)
    parser.add_argument("--name", default="train", help="Requested run name (see train_output_dir.txt "
                        "after training for where ultralytics actually put it)")
    parser.add_argument("--device", default=None, help="cpu, mps, or CUDA index like 0")
    parser.add_argument("--workers", type=int, default=8,
                        help="Dataloader workers (ultralytics defaults to 0 on MPS, "
                             "which starves the GPU — 8 keeps an M-series busy)")
    args = parser.parse_args()

    data_yaml = Path(args.data) if args.data else Path(__file__).parent / "data_detect.yaml"
    if not data_yaml.exists():
        print(f"[ERROR] Dataset config not found: {data_yaml}", file=sys.stderr)
        sys.exit(1)

    # Ultralytics force-zeroes workers for cpu/mps devices (engine/trainer.py:
    # "faster CPU training as time dominated by inference") — backwards on
    # Apple-silicon GPUs, where single-threaded dataloading starves the GPU
    # (~2 s/it observed vs GPU-bound compute). Restore the requested count
    # right after trainer init, before dataloaders are built.
    if args.workers > 0:
        from ultralytics.engine.trainer import BaseTrainer
        orig_init = BaseTrainer.__init__

        def patched_init(self, *a, **kw):
            orig_init(self, *a, **kw)
            self.args.workers = args.workers

        BaseTrainer.__init__ = patched_init

    if args.resume:
        model = YOLO(args.resume)
        model.train(resume=True)
    else:
        model = YOLO(args.model)
        train_kwargs = dict(
            data=str(data_yaml),
            epochs=args.epochs,
            imgsz=640,
            batch=args.batch,
            optimizer="AdamW",
            lr0=0.001,
            lrf=0.01,
            warmup_epochs=3,
            augment=True,
            fliplr=0.5,     # plain detect: boxes flip cleanly, no keypoint remap needed
            degrees=10,
            hsv_v=0.4,
            mosaic=1.0,
            project="runs/bow_detect",
            name=args.name,
            # True: reuse/overwrite runs/bow_detect/<name>/ every run instead of
            # auto-incrementing to <name>2, <name>3, ... on a persistent pod where
            # a previous (possibly failed) run's directory is often still there —
            # orchestrate.py always looks at the same fixed path afterward.
            exist_ok=True,
            save=True,
            save_period=10,
            val=True,
            plots=True,
            workers=args.workers,
        )
        if args.device is not None:
            train_kwargs["device"] = args.device

        print(f"Training {args.model} ({args.epochs} epochs) on {data_yaml}")
        print(f"Requested output dir: runs/bow_detect/{args.name}/ (ultralytics may resolve "
              "this differently — see the actual path reported below)\n")
        model.train(**train_kwargs)

    # Don't assume project=/name= landed where requested — read ultralytics'
    # own record of where it actually wrote things (see module docstring).
    save_dir = Path(model.trainer.save_dir)
    Path("train_output_dir.txt").write_text(str(save_dir))
    best = save_dir / "weights" / "best.pt"
    print("\nTraining complete.")
    print(f"Actual output dir: {save_dir.resolve()}")
    print(f"Best weights: {best.resolve()}")
    print("\nKey metrics to check in the printed summary:")
    print("  - mAP50(bow):    want > 0.85 — the box drives all bow geometry")
    print("  - mAP50(violin): want > 0.80")
    print("\nNext: copy best.pt to the Mac and export to CoreML (see GCE.md §5).")


if __name__ == "__main__":
    main()
