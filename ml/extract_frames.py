#!/usr/bin/env python3
"""
extract_frames.py — Extract labeled frames from violin recordings for bow detector training.

Usage:
    python extract_frames.py --input videos/ --output data/raw_frames/
    python extract_frames.py --input videos/ --output data/raw_frames/ --fps 10 --min-diff 8.0

Output:
    data/raw_frames/<video_id>/<frame_id>.jpg   — JPEG frames (quality 95)
    data/manifest.csv                           — frame index with metadata

The script deduplicates near-static frames (slow passages produce many near-duplicates).
Targets keeping ~60-70% of extracted frames. Tune --min-diff to adjust:
  - Higher value (e.g. 12): keep less, faster labeling but less variety
  - Lower value (e.g. 5):  keep more, more variety but more redundant frames
"""

import argparse
import csv
import os
import sys
from pathlib import Path

import cv2
import numpy as np


THUMBNAIL_SIZE = 64   # px — used for near-duplicate detection
JPEG_QUALITY   = 95


def video_id_from_path(path: Path) -> str:
    """Sanitize filename into a safe directory name."""
    return path.stem.replace(" ", "_").replace("(", "").replace(")", "")


def thumbnail(frame: np.ndarray) -> np.ndarray:
    """Downscale frame to THUMBNAIL_SIZE x THUMBNAIL_SIZE grayscale."""
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    return cv2.resize(gray, (THUMBNAIL_SIZE, THUMBNAIL_SIZE), interpolation=cv2.INTER_AREA)


def mean_abs_diff(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.mean(np.abs(a.astype(np.float32) - b.astype(np.float32))))


def extract_video(
    video_path: Path,
    output_dir: Path,
    fps: float,
    min_diff: float,
    manifest_rows: list,
) -> tuple[int, int]:
    """
    Extract frames from a single video.

    Returns (frames_kept, frames_dropped).
    """
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        print(f"  [ERROR] Could not open {video_path}", file=sys.stderr)
        return 0, 0

    source_fps = cap.get(cv2.CAP_PROP_FPS)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration_s = total_frames / source_fps if source_fps > 0 else 0

    # Sample every N source frames to hit target fps
    frame_interval = max(1, round(source_fps / fps))

    vid_id = video_id_from_path(video_path)
    out_dir = output_dir / vid_id
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"  source fps={source_fps:.1f}  duration={duration_s:.1f}s  "
          f"interval=1/{frame_interval}  output={out_dir}")

    kept = 0
    dropped = 0
    source_frame_idx = 0
    prev_thumb: np.ndarray | None = None

    while True:
        ret, frame = cap.read()
        if not ret:
            break

        if source_frame_idx % frame_interval == 0:
            thumb = thumbnail(frame)
            timestamp_ms = int(cap.get(cv2.CAP_PROP_POS_MSEC))

            if prev_thumb is not None:
                diff = mean_abs_diff(thumb, prev_thumb)
                is_duplicate = diff < min_diff
            else:
                diff = 999.0
                is_duplicate = False

            frame_name = f"{vid_id}_{source_frame_idx:06d}.jpg"
            frame_path = out_dir / frame_name

            manifest_rows.append({
                "frame_id": frame_name,
                "source_video": video_path.name,
                "video_id": vid_id,
                "source_frame_idx": source_frame_idx,
                "timestamp_ms": timestamp_ms,
                "diff_from_prev": round(diff, 2),
                "kept": not is_duplicate,
            })

            if not is_duplicate:
                cv2.imwrite(str(frame_path), frame, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
                prev_thumb = thumb
                kept += 1
            else:
                dropped += 1

        source_frame_idx += 1

    cap.release()
    return kept, dropped


def find_videos(input_path: Path) -> list[Path]:
    """Find all video files under input_path (file or directory)."""
    extensions = {".mp4", ".mov", ".avi", ".m4v", ".mkv"}
    if input_path.is_file():
        return [input_path] if input_path.suffix.lower() in extensions else []
    return sorted(p for p in input_path.rglob("*") if p.suffix.lower() in extensions)


def write_manifest(manifest_rows: list, output_dir: Path) -> None:
    manifest_path = output_dir.parent / "manifest.csv"
    if not manifest_rows:
        return
    fieldnames = list(manifest_rows[0].keys())
    with open(manifest_path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(manifest_rows)
    print(f"\nManifest written: {manifest_path}  ({len(manifest_rows)} rows)")


def main():
    parser = argparse.ArgumentParser(description="Extract training frames from violin videos.")
    parser.add_argument("--input",    required=True,       help="Input video file or directory")
    parser.add_argument("--output",   default="data/raw_frames", help="Output directory for frames")
    parser.add_argument("--fps",      type=float, default=10.0,  help="Target extraction FPS (default: 10)")
    parser.add_argument("--min-diff", type=float, default=8.0,
                        help="Min mean-abs-diff to keep a frame (default: 8.0). "
                             "Higher = fewer frames kept.")
    args = parser.parse_args()

    input_path  = Path(args.input)
    output_path = Path(args.output)

    if not input_path.exists():
        print(f"[ERROR] Input path does not exist: {input_path}", file=sys.stderr)
        sys.exit(1)

    videos = find_videos(input_path)
    if not videos:
        print(f"[ERROR] No video files found under: {input_path}", file=sys.stderr)
        sys.exit(1)

    print(f"Found {len(videos)} video(s)  fps={args.fps}  min-diff={args.min_diff}\n")

    output_path.mkdir(parents=True, exist_ok=True)

    manifest_rows: list = []
    total_kept = 0
    total_dropped = 0

    for i, video in enumerate(videos, 1):
        print(f"[{i}/{len(videos)}] {video.name}")
        kept, dropped = extract_video(video, output_path, args.fps, args.min_diff, manifest_rows)
        total_kept    += kept
        total_dropped += dropped
        total = kept + dropped
        pct = 100 * kept / total if total > 0 else 0
        print(f"  kept={kept}  dropped={dropped}  retention={pct:.0f}%\n")

    write_manifest(manifest_rows, output_path)

    total = total_kept + total_dropped
    pct = 100 * total_kept / total if total > 0 else 0
    print(f"Done. Total kept={total_kept}  dropped={total_dropped}  "
          f"overall retention={pct:.0f}%")
    print(f"Frames saved to: {output_path.resolve()}")
    print(f"\nNext step: upload frames from {output_path.resolve()} to Roboflow.")
    print("Label each frame with 3 keypoints: tip (KP0), frog (KP1), contact point (KP2).")
    print("See bow_model.md for exact labeling instructions.")


if __name__ == "__main__":
    main()
