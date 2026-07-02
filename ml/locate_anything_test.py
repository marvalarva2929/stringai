#!/usr/bin/env python3
"""
locate_anything_test.py — Test NVIDIA LocateAnything-3B for violin bow detection.

This is NOT a real-time pipeline — LocateAnything is a 3B-parameter VLM and takes
several seconds per frame. Use it to:
  1. Check if it generalizes better than our current YOLOv8s model on new footage
  2. Auto-annotate new training frames to augment the dataset

Usage:
    # Test on a video (samples at --fps):
    python locate_anything_test.py --input videos/my_session.mov

    # Test on a directory of extracted frames:
    python locate_anything_test.py --input data/raw_frames/my_video/

    # Compare against our existing YOLO model side-by-side:
    python locate_anything_test.py --input data/raw_frames/ \\
        --compare runs/pose/runs/bow/train-4-s/weights/best.pt

    # Export boxes as YOLO-format labels (for annotation):
    python locate_anything_test.py --input data/raw_frames/ --export-labels

Output:
    runs/locate_anything/annotated/    — frames with predicted boxes drawn
    runs/locate_anything/results.json  — all boxes in normalized [0,1] coords

Install:
    pip install transformers>=4.57.1 torch torchvision pillow opencv-python
    # On Mac, torch MPS is used automatically. No CUDA required.
"""

import argparse
import json
import re
import sys
import time
from pathlib import Path

import cv2
import numpy as np
from PIL import Image


# ─── Prompt ──────────────────────────────────────────────────────────────────

LOCATE_PROMPT = "Locate the violin bow in this image."


# ─── Model loader ─────────────────────────────────────────────────────────────

class LocateAnythingWorker:
    def __init__(self, model_path: str = "nvidia/LocateAnything-3B"):
        import torch
        from transformers import AutoModel, AutoProcessor, AutoTokenizer

        if torch.cuda.is_available():
            self.device = "cuda"
            self.dtype  = torch.bfloat16
        elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            self.device = "mps"
            self.dtype  = torch.float16   # bfloat16 not fully supported on MPS
        else:
            self.device = "cpu"
            self.dtype  = torch.float32

        print(f"[LocateAnything] Device: {self.device}  dtype: {self.dtype}")
        print(f"[LocateAnything] Loading {model_path} — this may take a minute on first run...")

        self.tokenizer = AutoTokenizer.from_pretrained(model_path, trust_remote_code=True)
        self.processor = AutoProcessor.from_pretrained(model_path, trust_remote_code=True)
        self.model = AutoModel.from_pretrained(
            model_path,
            torch_dtype=self.dtype,
            trust_remote_code=True,
        ).to(self.device).eval()

        print("[LocateAnything] Model ready.\n")

    def predict(self, image: Image.Image, prompt: str) -> str:
        """Run inference and return the raw text response."""
        import torch

        messages = [
            {"role": "user", "content": [
                {"type": "image", "image": image},
                {"type": "text",  "text":  prompt},
            ]}
        ]

        text   = self.processor.py_apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        images, videos = self.processor.process_vision_info(messages)
        inputs = self.processor(
            text=[text], images=images, videos=videos, return_tensors="pt",
        ).to(self.device)

        with torch.no_grad():
            response = self.model.generate(
                pixel_values=inputs["pixel_values"].to(self.dtype),
                input_ids=inputs["input_ids"],
                attention_mask=inputs["attention_mask"],
                image_grid_hws=inputs.get("image_grid_hws", None),
                tokenizer=self.tokenizer,
                max_new_tokens=256,
                generation_mode="hybrid",
            )

        return response[0] if isinstance(response, tuple) else response

    @staticmethod
    def parse_boxes(answer: str, img_w: int, img_h: int) -> list[dict]:
        """
        Extract boxes from model output text.
        Model emits coordinates in [0, 1000] normalized space.
        Returns list of dicts with pixel coords and normalized [0,1] coords.
        """
        boxes = []
        # Handle both <box><x1><y1><x2><y2></box> and <box>x1,y1,x2,y2</box>
        for m in re.finditer(
            r"<box>\s*[<\[]?(\d+)[>\]]?,?\s*[<\[]?(\d+)[>\]]?,?\s*[<\[]?(\d+)[>\]]?,?\s*[<\[]?(\d+)[>\]]?\s*</box>",
            answer,
        ):
            x1_n, y1_n, x2_n, y2_n = [int(g) / 1000.0 for g in m.groups()]
            boxes.append({
                "x1": x1_n * img_w, "y1": y1_n * img_h,
                "x2": x2_n * img_w, "y2": y2_n * img_h,
                "x1_norm": x1_n, "y1_norm": y1_n,
                "x2_norm": x2_n, "y2_norm": y2_n,
            })
        return boxes


# ─── Frame sources ────────────────────────────────────────────────────────────

def frames_from_video(video_path: Path, fps: float) -> list[tuple[str, np.ndarray]]:
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        print(f"[ERROR] Cannot open video: {video_path}", file=sys.stderr)
        return []

    src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    interval = max(1, round(src_fps / fps))
    frames = []
    idx = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        if idx % interval == 0:
            name = f"{video_path.stem}_{idx:06d}"
            frames.append((name, frame))
        idx += 1
    cap.release()
    print(f"Sampled {len(frames)} frames from {video_path.name} (every {interval} source frames)")
    return frames


def frames_from_dir(img_dir: Path, limit: int) -> list[tuple[str, np.ndarray]]:
    exts = {".jpg", ".jpeg", ".png"}
    paths = sorted(p for p in img_dir.rglob("*") if p.suffix.lower() in exts)
    if limit:
        paths = paths[:limit]
    frames = []
    for p in paths:
        img = cv2.imread(str(p))
        if img is not None:
            frames.append((p.stem, img))
    print(f"Loaded {len(frames)} image(s) from {img_dir}")
    return frames


# ─── Annotation drawing ───────────────────────────────────────────────────────

LA_COLOR   = (0, 200, 255)   # amber/yellow — LocateAnything boxes
YOLO_COLOR = (0, 255, 80)    # green — YOLO boxes (for comparison)


def draw_box(img: np.ndarray, box: dict, color: tuple, label: str) -> None:
    x1, y1, x2, y2 = int(box["x1"]), int(box["y1"]), int(box["x2"]), int(box["y2"])
    cv2.rectangle(img, (x1, y1), (x2, y2), color, 2)
    text_y = max(y1 - 6, 14)
    cv2.rectangle(img, (x1, text_y - 14), (x1 + len(label) * 8 + 4, text_y + 2), color, -1)
    cv2.putText(img, label, (x1 + 2, text_y), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 0, 0), 1)


# ─── YOLO comparison (optional) ───────────────────────────────────────────────

def load_yolo(weights_path: Path):
    try:
        from ultralytics import YOLO
        model = YOLO(str(weights_path))
        print(f"[YOLO] Loaded {weights_path.name} for comparison")
        return model
    except ImportError:
        print("[YOLO] ultralytics not installed — skipping comparison")
        return None


def yolo_box(model, frame_bgr: np.ndarray) -> dict | None:
    """Run our existing YOLO model and return its bounding box (if any)."""
    results = model(frame_bgr, verbose=False, conf=0.30)
    for r in results:
        if r.boxes is not None and len(r.boxes):
            h, w = frame_bgr.shape[:2]
            box = r.boxes.xyxy[0].cpu().numpy()
            return {
                "x1": float(box[0]), "y1": float(box[1]),
                "x2": float(box[2]), "y2": float(box[3]),
                "conf": float(r.boxes.conf[0]),
            }
    return None


# ─── YOLO label export ────────────────────────────────────────────────────────

def export_yolo_label(output_dir: Path, frame_name: str, frame: np.ndarray, boxes: list[dict]) -> None:
    """
    Write a YOLO detection label file (.txt) next to the frame image.
    Format: <class_id> <x_center> <y_center> <width> <height>  (all normalized)
    Class 0 = bow.
    Use these files + images to extend the training dataset.
    """
    h, w = frame.shape[:2]
    label_dir = output_dir / "labels"
    img_dir   = output_dir / "images"
    label_dir.mkdir(parents=True, exist_ok=True)
    img_dir.mkdir(parents=True, exist_ok=True)

    lines = []
    for b in boxes:
        cx = (b["x1_norm"] + b["x2_norm"]) / 2
        cy = (b["y1_norm"] + b["y2_norm"]) / 2
        bw = b["x2_norm"] - b["x1_norm"]
        bh = b["y2_norm"] - b["y1_norm"]
        lines.append(f"0 {cx:.6f} {cy:.6f} {bw:.6f} {bh:.6f}")

    (label_dir / f"{frame_name}.txt").write_text("\n".join(lines))
    cv2.imwrite(str(img_dir / f"{frame_name}.jpg"), frame, [cv2.IMWRITE_JPEG_QUALITY, 95])


# ─── Main pipeline ────────────────────────────────────────────────────────────

def run(args):
    input_path  = Path(args.input)
    output_dir  = Path(args.output)
    ann_dir     = output_dir / "annotated"
    ann_dir.mkdir(parents=True, exist_ok=True)

    # Collect frames
    if input_path.is_file():
        frames = frames_from_video(input_path, args.fps)
    elif input_path.is_dir():
        frames = frames_from_dir(input_path, args.limit)
    else:
        print(f"[ERROR] Input not found: {input_path}", file=sys.stderr)
        sys.exit(1)

    if not frames:
        print("[ERROR] No frames to process.", file=sys.stderr)
        sys.exit(1)

    # Load models
    worker    = LocateAnythingWorker()
    yolo_model = load_yolo(Path(args.compare)) if args.compare else None

    results   = []
    total_t   = 0.0
    detected  = 0

    print(f"Processing {len(frames)} frames...\n")
    for i, (name, frame_bgr) in enumerate(frames, 1):
        pil_img = Image.fromarray(cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB))
        h, w    = frame_bgr.shape[:2]

        t0      = time.perf_counter()
        raw_out = worker.predict(pil_img, LOCATE_PROMPT)
        elapsed = time.perf_counter() - t0
        total_t += elapsed

        boxes   = LocateAnythingWorker.parse_boxes(raw_out, w, h)
        ann     = frame_bgr.copy()

        # Draw LocateAnything predictions
        for b in boxes:
            conf_str = ""
            draw_box(ann, b, LA_COLOR, f"LA bow{conf_str}")
        detected += int(bool(boxes))

        # Draw YOLO comparison (green)
        yolo_b = yolo_box(yolo_model, frame_bgr) if yolo_model else None
        if yolo_b:
            draw_box(ann, yolo_b, YOLO_COLOR, f"YOLO {yolo_b['conf']:.2f}")

        # Legend
        cv2.putText(ann, f"LocateAnything  [{elapsed:.1f}s]", (8, 22),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.55, LA_COLOR, 1)
        if yolo_model:
            cv2.putText(ann, "YOLO (existing)", (8, 44),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.55, YOLO_COLOR, 1)

        out_path = ann_dir / f"{name}.jpg"
        cv2.imwrite(str(out_path), ann, [cv2.IMWRITE_JPEG_QUALITY, 92])

        # Optionally export YOLO detection labels
        if args.export_labels and boxes:
            export_yolo_label(output_dir / "auto_labels", name, frame_bgr, boxes)

        # Store result
        results.append({
            "frame":       name,
            "raw_output":  raw_out,
            "boxes":       [{k: round(v, 4) for k, v in b.items()} for b in boxes],
            "yolo_box":    yolo_b,
            "inference_s": round(elapsed, 2),
        })

        det_str = f"{len(boxes)} box(es)" if boxes else "no detection"
        print(f"  [{i:>3}/{len(frames)}] {name}  →  {det_str}  ({elapsed:.1f}s)")

    # Summary
    avg_t = total_t / len(frames)
    print(f"\n{'─'*50}")
    print(f"Frames:       {len(frames)}")
    print(f"Detected:     {detected} ({100*detected/len(frames):.0f}%)")
    print(f"Avg latency:  {avg_t:.1f}s/frame")
    print(f"Annotated:    {ann_dir.resolve()}")

    json_path = output_dir / "results.json"
    json_path.write_text(json.dumps(results, indent=2))
    print(f"Results JSON: {json_path.resolve()}")

    if args.export_labels:
        label_count = sum(1 for r in results if r["boxes"])
        print(f"Auto-labels:  {output_dir / 'auto_labels'}  ({label_count} frames)")
        print("\nTo add these to training:")
        print("  1. Review annotated/ frames — delete any bad detections from auto_labels/")
        print("  2. Copy auto_labels/images/ and auto_labels/labels/ into data/images/ and data/labels/")
        print("  3. Re-run train.py")


def main():
    parser = argparse.ArgumentParser(
        description="Test NVIDIA LocateAnything-3B on violin bow frames.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--input",         required=True,
                        help="Video file or directory of images")
    parser.add_argument("--output",        default="runs/locate_anything",
                        help="Output directory (default: runs/locate_anything)")
    parser.add_argument("--fps",           type=float, default=2.0,
                        help="Frames per second to sample from video (default: 2)")
    parser.add_argument("--limit",         type=int, default=50,
                        help="Max frames from image directory (default: 50)")
    parser.add_argument("--compare",       default=None,
                        help="Path to YOLO best.pt to draw side-by-side comparison")
    parser.add_argument("--export-labels", action="store_true",
                        help="Write YOLO detection label files alongside annotated images")
    parser.add_argument("--prompt",        default=LOCATE_PROMPT,
                        help=f"Localization prompt (default: '{LOCATE_PROMPT}')")
    args = parser.parse_args()

    print(f"Prompt: \"{args.prompt}\"")
    print(f"Input:  {args.input}")
    print()
    run(args)


if __name__ == "__main__":
    main()
