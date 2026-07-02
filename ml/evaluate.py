#!/usr/bin/env python3
"""
evaluate.py — Evaluate bow keypoint detector with OKS breakdown.

OKS (Object Keypoint Similarity) measures keypoint detection accuracy.
OKS = 1.0 is perfect; OKS = 0.0 is completely wrong.

Targets before shipping to app:
  Overall OKS:         > 0.82
  Tip (KP0) OKS:       > 0.90
  Frog (KP1) OKS:      > 0.88
  Contact (KP2) OKS:   > 0.75   ← hardest; bow hair translucent, string is thin

Usage:
    cd ml/
    python evaluate.py --weights runs/bow/train/weights/best.pt
    python evaluate.py --weights runs/bow/train/weights/best.pt --visualize --n 20
"""

import argparse
import sys
from pathlib import Path


KEYPOINT_NAMES  = ["tip", "frog", "contact"]
OKS_TARGETS     = {"tip": 0.90, "frog": 0.88, "contact": 0.75, "overall": 0.82}
# Sigma controls how strictly each keypoint is evaluated.
# Larger sigma = more lenient. Contact point gets slightly more slack
# because it's a learned visual feature, not a hard geometric point.
KP_SIGMAS       = [0.025, 0.025, 0.035]   # tip, frog, contact


def compute_oks(pred_kps, gt_kps, gt_bbox_area, sigmas):
    """
    Compute OKS for a single detection.

    pred_kps: [[x, y, v], ...] predicted keypoints (v = visibility score)
    gt_kps:   [[x, y, v], ...] ground-truth keypoints (v = 0/1/2)
    gt_bbox_area: float, area of ground-truth bounding box (normalized)
    sigmas:   list of per-keypoint sigma values

    Returns mean OKS over visible ground-truth keypoints.
    """
    import numpy as np

    scores = []
    for i, (pred, gt, sigma) in enumerate(zip(pred_kps, gt_kps, sigmas)):
        gt_v = gt[2]
        if gt_v == 0:   # keypoint not labeled — skip
            continue
        dx = pred[0] - gt[0]
        dy = pred[1] - gt[1]
        dist_sq = dx * dx + dy * dy
        s_sq = (2 * sigma) ** 2
        e = dist_sq / (2 * gt_bbox_area * s_sq + 1e-9)
        scores.append(float(np.exp(-e)))

    return float(sum(scores) / len(scores)) if scores else 0.0


def compute_per_keypoint_oks(weights: Path, data_yaml: Path, device: str) -> list:
    """Compute mean OKS per keypoint by running inference on the val set."""
    import numpy as np
    from ultralytics import YOLO

    model = YOLO(str(weights))
    val_img_dir = data_yaml.parent / "data" / "images" / "val"
    val_lbl_dir = data_yaml.parent / "data" / "labels" / "val"

    image_paths = sorted(
        list(val_img_dir.glob("*.jpg")) + list(val_img_dir.glob("*.png"))
    )

    kp_scores: list = [[], [], []]
    infer_kwargs: dict = {"verbose": False}
    if device:
        infer_kwargs["device"] = device

    for img_path in image_paths:
        label_path = val_lbl_dir / (img_path.stem + ".txt")
        if not label_path.exists():
            continue

        with open(label_path) as f:
            lines = [ln.strip() for ln in f if ln.strip()]

        gt_instances = []
        for line in lines:
            parts = list(map(float, line.split()))
            if len(parts) < 14:
                continue
            bw, bh = parts[3], parts[4]
            kps = [[parts[5 + i * 3], parts[6 + i * 3], parts[7 + i * 3]] for i in range(3)]
            gt_instances.append({"area": bw * bh, "kps": kps})

        if not gt_instances:
            continue

        results = model(str(img_path), **infer_kwargs)

        for result in results:
            if result.keypoints is None or len(result.keypoints) == 0:
                continue
            pred_kps_all = result.keypoints.xyn.cpu().numpy()  # (N, 3, 2) normalized

            for gi, gt in enumerate(gt_instances):
                if gi >= len(pred_kps_all):
                    break
                pred_kps = pred_kps_all[gi]  # (3, 2)

                for i in range(3):
                    gt_x, gt_y, gt_v = gt["kps"][i]
                    if gt_v == 0:
                        continue
                    dx = float(pred_kps[i][0]) - gt_x
                    dy = float(pred_kps[i][1]) - gt_y
                    dist_sq = dx * dx + dy * dy
                    s_sq = (2 * KP_SIGMAS[i]) ** 2
                    e = dist_sq / (2 * gt["area"] * s_sq + 1e-9)
                    kp_scores[i].append(float(np.exp(-e)))

    return [float(np.mean(s)) if s else 0.0 for s in kp_scores]


def evaluate_with_ultralytics(weights: Path, data_yaml: Path, device: str):
    """Run YOLOv8 validation and print per-keypoint OKS."""
    try:
        from ultralytics import YOLO
    except ImportError:
        print("[ERROR] ultralytics not installed. Run: pip install -r requirements.txt")
        sys.exit(1)

    model = YOLO(str(weights))
    kwargs = dict(data=str(data_yaml), imgsz=640, conf=0.25, iou=0.6, verbose=False)
    if device:
        kwargs["device"] = device

    print(f"Running validation on {data_yaml.parent / 'data/images/val'}...\n")
    results = model.val(**kwargs)

    # Overall metrics from the PoseMetrics object
    pose_map50   = float(getattr(results.pose, "map50", 0.0)) if hasattr(results, "pose") else 0.0
    pose_map5095 = float(getattr(results.pose, "map",   0.0)) if hasattr(results, "pose") else 0.0

    print("\n--- Validation Summary ---")
    print(f"  Pose mAP50:     {pose_map50:.3f}")
    overall_pass = pose_map5095 >= OKS_TARGETS["overall"]
    mark = "✓" if overall_pass else "✗"
    print(f"  Pose mAP50-95:  {pose_map5095:.3f}  (target: >{OKS_TARGETS['overall']:.2f})  {mark}")

    # Per-keypoint OKS via custom inference loop
    print("\n--- Per-Keypoint OKS ---")
    kp_oks = compute_per_keypoint_oks(weights, data_yaml, device)

    print(f"  {'Keypoint':<12}  {'OKS':>6}  {'Target':>6}  {'Pass':>5}")
    print(f"  {'-'*12}  {'-'*6}  {'-'*6}  {'-'*5}")
    all_pass = overall_pass
    for i, name in enumerate(KEYPOINT_NAMES):
        oks = kp_oks[i]
        target = OKS_TARGETS[name]
        passed = oks >= target
        all_pass = all_pass and passed
        mark = "✓" if passed else "✗"
        print(f"  {name:<12}  {oks:>6.3f}  {target:>6.3f}  {mark:>5}")

    print()
    if all_pass:
        print("  All targets met. Ready to export to CoreML.")
    else:
        print("  Some targets not met. See recommendations below.")
        print_improvement_tips()

    return results


def print_improvement_tips():
    print("""
Improvement suggestions:
  - Contact point low OKS: label more frames from frog area (hair compressed,
    contact harder to see). Target 200+ frog-area frames.
  - Tip OKS low: label more foreshortened frames (bow pointing at camera).
  - General: add frames from different lighting conditions, different players,
    different string heights (G-string vs E-string elbow position).
  - Consider increasing epochs to 200 if loss curves haven't plateaued.
""")


def visualize_predictions(weights: Path, data_yaml: Path, n: int, output_dir: Path):
    """Save n sample prediction images with keypoint overlays."""
    try:
        from ultralytics import YOLO
        import cv2
    except ImportError:
        print("[ERROR] Install requirements: pip install -r requirements.txt")
        return

    model = YOLO(str(weights))
    val_dir = data_yaml.parent / "data" / "images" / "val"
    if not val_dir.exists():
        print(f"[WARN] Val directory not found: {val_dir}")
        return

    import random
    image_paths = list(val_dir.glob("*.jpg")) or list(val_dir.glob("*.png"))
    random.shuffle(image_paths)
    image_paths = image_paths[:n]

    output_dir.mkdir(parents=True, exist_ok=True)

    colors = {
        0: (0, 255, 255),    # tip — yellow
        1: (0, 165, 255),    # frog — orange
        2: (0, 255, 0),      # contact — green
    }

    for img_path in image_paths:
        results = model(str(img_path), verbose=False)
        img = cv2.imread(str(img_path))

        for result in results:
            if result.keypoints is None:
                continue
            for kps in result.keypoints.xy:
                for i, (x, y) in enumerate(kps):
                    x, y = int(x), int(y)
                    if x > 0 or y > 0:
                        cv2.circle(img, (x, y), 6, colors[i], -1)
                        cv2.putText(img, KEYPOINT_NAMES[i], (x + 8, y),
                                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, colors[i], 1)

        out_path = output_dir / img_path.name
        cv2.imwrite(str(out_path), img)

    print(f"Saved {len(image_paths)} visualizations to {output_dir.resolve()}")


def benchmark_inference(weights: Path, data_yaml: Path, device: str, n: int = 50):
    """Measure mean inference time per image (excludes preprocessing overhead)."""
    import time
    from ultralytics import YOLO

    model = YOLO(str(weights))
    val_dir = data_yaml.parent / "data" / "images" / "val"
    image_paths = sorted(list(val_dir.glob("*.jpg")) + list(val_dir.glob("*.png")))[:n]

    infer_kwargs: dict = {"verbose": False}
    if device:
        infer_kwargs["device"] = device

    # Warmup
    for p in image_paths[:3]:
        model(str(p), **infer_kwargs)

    times = []
    for p in image_paths:
        t0 = time.perf_counter()
        model(str(p), **infer_kwargs)
        times.append((time.perf_counter() - t0) * 1000)

    avg = sum(times) / len(times)
    mn  = min(times)
    mx  = max(times)
    print(f"\n--- Inference Timing ({len(times)} images) ---")
    print(f"  Mean:  {avg:.1f} ms/image")
    print(f"  Min:   {mn:.1f} ms")
    print(f"  Max:   {mx:.1f} ms")
    print(f"  Note: this is CPU/Python timing — on-device ANE will be faster")


def main():
    parser = argparse.ArgumentParser(description="Evaluate bow keypoint detector OKS.")
    parser.add_argument("--weights",   required=True,  help="Path to best.pt")
    parser.add_argument("--data",      default=None,   help="data.yaml path (default: ml/data.yaml)")
    parser.add_argument("--device",    default=None,   help="cpu / mps / 0")
    parser.add_argument("--visualize", action="store_true", help="Save sample prediction images")
    parser.add_argument("--n",         type=int, default=20, help="Number of images to visualize")
    parser.add_argument("--time",      action="store_true", help="Benchmark inference speed (ms/image)")
    args = parser.parse_args()

    weights = Path(args.weights)
    if not weights.exists():
        print(f"[ERROR] Weights not found: {weights}", file=sys.stderr)
        sys.exit(1)

    data_yaml = Path(args.data) if args.data else Path(__file__).parent / "data.yaml"
    if not data_yaml.exists():
        print(f"[ERROR] data.yaml not found: {data_yaml}", file=sys.stderr)
        sys.exit(1)

    print(f"Evaluating: {weights}")
    evaluate_with_ultralytics(weights, data_yaml, args.device or "")

    if args.time:
        benchmark_inference(weights, data_yaml, args.device or "")

    if args.visualize:
        vis_dir = weights.parent.parent / "visualizations"
        print(f"\nGenerating {args.n} visualization(s)...")
        visualize_predictions(weights, data_yaml, args.n, vis_dir)


if __name__ == "__main__":
    main()
