#!/usr/bin/env python3
"""
autolabel.py — Bulk auto-label violin frames with LocateAnything-3B.

Runs the bow + violin prompts over every frame and writes a YOLO *detect*
dataset (class 0 = bow, class 1 = violin) ready for train_detect.py, plus
annotated previews for human review.

Run on a GPU instance (see GCE.md). Resumable: frames that already have a label
file are skipped, so it's safe to Ctrl-C and rerun, or to add more frames later.

Usage:
    # Frames directory (from extract_frames.py):
    python autolabel.py --input raw_frames/ --output dataset/

    # Long runs — survive closing the terminal:
    nohup python autolabel.py --input raw_frames/ --output dataset/ > autolabel.log 2>&1 &
    tail -f autolabel.log

    # A video file directly (samples at --fps):
    python autolabel.py --input session.mov --fps 4 --output dataset/

Output layout (what Ultralytics expects):
    dataset/images/train/*.jpg   dataset/labels/train/*.txt
    dataset/images/val/*.jpg     dataset/labels/val/*.txt
    dataset/annotated/*.jpg      ← previews with boxes drawn — REVIEW THESE
    dataset/stats.json

After it finishes:
    1. Flip through dataset/annotated/. For any bad frame, delete its image +
       label from dataset/images|labels/*/ (same basename).
    2. python train_detect.py
"""

import argparse
import hashlib
import json
import re
import sys
import time
from pathlib import Path

from PIL import Image, ImageDraw

MAX_SIDE = 1120

BOW_PROMPT = (
    "Locate the violin bow in this image. Only include the violin bow and "
    "nothing else. Include the entire bow. The entire bow may not be visible "
    "in the frame. Locate the part that is visible and don't include extra. "
    "There is guaranteed to be a violin bow in frame."
)
VIOLIN_PROMPT = (
    "Locate the violin in this image. Only include the violin and nothing "
    "else. The violin may be partially hidden behind the player's hand or the "
    "bow; include the whole visible instrument and don't include extra."
)

CLASSES = ["bow", "violin"]          # class ids 0, 1 — keep in sync with data_detect.yaml
COLORS = {"bow": "#f59e0b", "violin": "#22d3ee"}

# ── Model (same loader as app.py) ─────────────────────────────────────────────

_worker = None


def load_model():
    global _worker
    if _worker is not None:
        return _worker

    import torch
    from transformers import AutoModel, AutoProcessor, AutoTokenizer

    model_id = "nvidia/LocateAnything-3B"
    if torch.cuda.is_available():
        device, dtype = "cuda", torch.bfloat16
    elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        device, dtype = "mps", torch.float32
    else:
        device, dtype = "cpu", torch.float32

    print(f"[LocateAnything] Loading on {device} ({dtype}) — first run downloads ~6 GB …", flush=True)
    tok = AutoTokenizer.from_pretrained(model_id, trust_remote_code=True)
    proc = AutoProcessor.from_pretrained(model_id, trust_remote_code=True)
    mdl = AutoModel.from_pretrained(model_id, torch_dtype=dtype, trust_remote_code=True).to(device).eval()
    print("[LocateAnything] Ready.\n", flush=True)

    _worker = {"model": mdl, "processor": proc, "tokenizer": tok, "device": device, "dtype": dtype}
    return _worker


def predict(pil_img: Image.Image, prompt: str) -> str:
    import torch

    w = load_model()
    messages = [{"role": "user", "content": [
        {"type": "image", "image": pil_img},
        {"type": "text", "text": prompt},
    ]}]
    text = w["processor"].py_apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    images, _ = w["processor"].process_vision_info(messages)
    inputs = w["processor"](text=[text], images=images, return_tensors="pt").to(w["device"])
    with torch.no_grad():
        out = w["model"].generate(
            pixel_values=inputs["pixel_values"].to(w["dtype"]),
            input_ids=inputs["input_ids"],
            attention_mask=inputs["attention_mask"],
            image_grid_hws=inputs.get("image_grid_hws"),
            tokenizer=w["tokenizer"],
            max_new_tokens=256,
            generation_mode="hybrid",
            use_cache=True,
        )
    return out[0] if isinstance(out, tuple) else out


# ── Box parsing / selection (same logic as app.py) ────────────────────────────

def parse_boxes(text: str) -> list[tuple[float, float, float, float]]:
    """Normalized (x1, y1, x2, y2) boxes, corners ordered and clamped to [0,1]."""
    boxes = []
    for m in re.finditer(
        r"<box>\s*[<\[]?(\d+)[>\]]?,?\s*[<\[]?(\d+)[>\]]?,?\s*[<\[]?(\d+)[>\]]?,?\s*[<\[]?(\d+)[>\]]?\s*</box>",
        text,
    ):
        x1, y1, x2, y2 = [min(max(int(g) / 1000.0, 0.0), 1.0) for g in m.groups()]
        x1, x2 = sorted((x1, x2))
        y1, y2 = sorted((y1, y2))
        boxes.append((x1, y1, x2, y2))
    return boxes


def select_box(boxes: list, mode: str):
    """Reduce to a single box (or None). Modes: largest | union | first."""
    if not boxes:
        return None
    if mode == "first":
        return boxes[0]
    if mode == "union":
        return (
            min(b[0] for b in boxes), min(b[1] for b in boxes),
            max(b[2] for b in boxes), max(b[3] for b in boxes),
        )
    # largest (default)
    return max(boxes, key=lambda b: (b[2] - b[0]) * (b[3] - b[1]))


# ── Frame sources ──────────────────────────────────────────────────────────────

IMG_EXTS = {".jpg", ".jpeg", ".png"}


def list_image_paths(input_dir: Path, limit: int) -> list[Path]:
    """All real images under input_dir, excluding macOS zip junk
    (__MACOSX/ directories and ._* AppleDouble files)."""
    paths = []
    for p in sorted(input_dir.rglob("*")):
        if p.suffix.lower() not in IMG_EXTS:
            continue
        if p.name.startswith("._") or "__MACOSX" in p.parts:
            continue
        paths.append(p)
    if limit:
        paths = paths[:limit]
    return paths


def iter_video_frames(video_path: Path, fps: float, limit: int):
    """Yield (name, PIL.Image) sampled from a video file at ~fps."""
    import cv2

    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise SystemExit(f"[ERROR] Cannot open video: {video_path}")
    src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    interval = max(1, round(src_fps / fps))
    idx = yielded = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        if idx % interval == 0:
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            yield f"{video_path.stem}_{idx:06d}", Image.fromarray(rgb)
            yielded += 1
            if limit and yielded >= limit:
                break
        idx += 1
    cap.release()


def split_for(name: str, val_fraction: float) -> str:
    """Deterministic train/val assignment by frame-name hash."""
    h = int(hashlib.md5(name.encode()).hexdigest(), 16) % 1000
    return "val" if h < val_fraction * 1000 else "train"


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Bulk auto-label frames with LocateAnything-3B.")
    parser.add_argument("--input", required=True, help="Frames directory or a video file")
    parser.add_argument("--output", default="dataset", help="Dataset output directory")
    parser.add_argument("--fps", type=float, default=4.0, help="Sampling fps for video input")
    parser.add_argument("--limit", type=int, default=0, help="Max frames (0 = all)")
    parser.add_argument("--val-fraction", type=float, default=0.1)
    parser.add_argument("--bow-mode", default="largest", choices=["largest", "union", "first"])
    parser.add_argument("--violin-mode", default="largest", choices=["largest", "union", "first"])
    parser.add_argument("--bow-prompt", default=BOW_PROMPT)
    parser.add_argument("--violin-prompt", default=VIOLIN_PROMPT)
    parser.add_argument("--skip-violin", action="store_true", help="Label only the bow class")
    args = parser.parse_args()

    input_path = Path(args.input)
    if not input_path.exists():
        raise SystemExit(f"[ERROR] Input not found: {input_path}")

    out = Path(args.output)
    ann_dir = out / "annotated"
    ann_dir.mkdir(parents=True, exist_ok=True)
    for split in ("train", "val"):
        (out / "images" / split).mkdir(parents=True, exist_ok=True)
        (out / "labels" / split).mkdir(parents=True, exist_ok=True)

    targets = [("bow", args.bow_prompt, args.bow_mode)]
    if not args.skip_violin:
        targets.append(("violin", args.violin_prompt, args.violin_mode))

    stats = {"processed": 0, "skipped_existing": 0, "unreadable": 0,
             "no_bow": 0, "no_violin": 0, "labeled": 0}

    def label_path_for(name: str, split: str) -> Path:
        return out / "labels" / split / f"{name}.txt"

    # Build a lazy frame source. Images are decoded one at a time inside the
    # loop — never all at once — and already-labeled frames are skipped
    # BEFORE decoding, so reruns are near-instant until they hit new work.
    if input_path.is_dir():
        all_paths = list_image_paths(input_path, args.limit)
        if not all_paths:
            raise SystemExit(f"[ERROR] No images found under {input_path}")

        todo: list[tuple[Path, str]] = []
        for p in all_paths:
            split = split_for(p.stem, args.val_fraction)
            if label_path_for(p.stem, split).exists():
                stats["skipped_existing"] += 1
            else:
                todo.append((p, split))
        total = len(todo)
        print(f"{len(all_paths)} image(s) found  •  {stats['skipped_existing']} already "
              f"labeled (skipped)  •  {total} to process", flush=True)

        def frame_source():
            for p, split in todo:
                try:
                    yield p.stem, split, Image.open(p).convert("RGB")
                except OSError as e:
                    stats["unreadable"] += 1
                    print(f"  [WARN] unreadable image {p}: {e}", file=sys.stderr, flush=True)
    else:
        total = 0  # unknown until the video is walked; ETA is omitted
        print(f"Sampling video {input_path.name} at {args.fps} fps", flush=True)

        def frame_source():
            for name, pil in iter_video_frames(input_path, args.fps, args.limit):
                split = split_for(name, args.val_fraction)
                if label_path_for(name, split).exists():
                    stats["skipped_existing"] += 1
                    continue
                yield name, split, pil

    load_model()  # preload so the download/load progress prints before the loop

    t_start = time.time()
    i = 0
    for name, split, pil in frame_source():
        i += 1
        if max(pil.size) > MAX_SIDE:
            pil.thumbnail((MAX_SIDE, MAX_SIDE), Image.LANCZOS)

        lines = []
        found = {}
        for cls_name, prompt, mode in targets:
            raw = predict(pil, prompt)
            box = select_box(parse_boxes(raw), mode)
            if box is None:
                stats[f"no_{cls_name}"] += 1
                continue
            found[cls_name] = box
            x1, y1, x2, y2 = box
            cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
            w, h = x2 - x1, y2 - y1
            cls_id = CLASSES.index(cls_name)
            lines.append(f"{cls_id} {cx:.6f} {cy:.6f} {w:.6f} {h:.6f}")

        stats["processed"] += 1
        rate = (time.time() - t_start) / stats["processed"]
        eta = f", ETA {rate * (total - i) / 60:.0f}m" if total else ""
        progress = f"[{i}/{total}]" if total else f"[{i}]"

        # A frame with no bow box is useless for training — skip entirely.
        if "bow" not in found:
            print(f"{progress} {name}  →  NO BOW — skipped  ({rate:.1f}s/frame{eta})", flush=True)
            continue

        # Write image + label
        pil.save(out / "images" / split / f"{name}.jpg", quality=92)
        label_path_for(name, split).write_text("\n".join(lines) + "\n")
        stats["labeled"] += 1

        # Annotated preview for review
        ann = pil.copy()
        draw = ImageDraw.Draw(ann)
        W, H = ann.size
        for cls_name, (x1, y1, x2, y2) in found.items():
            draw.rectangle([x1 * W, y1 * H, x2 * W, y2 * H], outline=COLORS[cls_name], width=3)
            draw.text((x1 * W + 4, max(y1 * H - 16, 2)), cls_name, fill=COLORS[cls_name])
        ann.save(ann_dir / f"{name}.jpg", quality=85)

        print(f"{progress} {name} [{split}]  →  {', '.join(found)}  "
              f"({rate:.1f}s/frame{eta}, labeled {stats['labeled']})", flush=True)

    (out / "stats.json").write_text(json.dumps(stats, indent=2))
    print(f"\n{'─' * 50}")
    for k, v in stats.items():
        print(f"{k:>18}: {v}")
    print(f"\nDataset: {out.resolve()}")
    print("Next:")
    print("  1. Review dataset/annotated/ — delete bad frames from images/ + labels/")
    print("  2. python train_detect.py")


if __name__ == "__main__":
    main()
