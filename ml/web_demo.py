#!/usr/bin/env python3
"""
web_demo.py — Local web UI for testing LocateAnything-3B on violin bow images.

Model loads once on first inference and stays in memory between uploads.

Usage:
    cd ml/
    pip install gradio
    python web_demo.py
    → Open http://localhost:7860

With YOLO side-by-side comparison:
    python web_demo.py --yolo runs/pose/runs/bow/train-4-s/weights/best.pt
"""

import argparse
import json
import re
import time

import numpy as np
from PIL import Image, ImageDraw, ImageFont

# ── Lazy model globals ─────────────────────────────────────────────────────────

_la_worker = None
_yolo_model = None


def _load_la():
    global _la_worker
    if _la_worker is not None:
        return _la_worker

    import torch
    from transformers import AutoModel, AutoProcessor, AutoTokenizer

    model_id = "nvidia/LocateAnything-3B"

    if torch.cuda.is_available():
        device, dtype = "cuda", torch.bfloat16
    elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        device, dtype = "mps", torch.float32  # float16 causes numeric instability on MPS
    else:
        device, dtype = "cpu", torch.float32

    print(f"[LocateAnything] Loading on {device} ({dtype}) — first run downloads ~6 GB …")
    tok  = AutoTokenizer.from_pretrained(model_id, trust_remote_code=True)
    proc = AutoProcessor.from_pretrained(model_id, trust_remote_code=True)
    mdl  = AutoModel.from_pretrained(model_id, torch_dtype=dtype, trust_remote_code=True).to(device).eval()
    print("[LocateAnything] Ready.\n")

    _la_worker = {"model": mdl, "processor": proc, "tokenizer": tok, "device": device, "dtype": dtype}
    return _la_worker


def _load_yolo(weights_path: str):
    global _yolo_model
    if _yolo_model is not None:
        return _yolo_model
    from ultralytics import YOLO
    _yolo_model = YOLO(weights_path)
    return _yolo_model


# ── Inference ──────────────────────────────────────────────────────────────────

MAX_SIDE = 1120  # keep patches manageable on MPS


def _la_predict(pil_img: Image.Image, prompt: str) -> str:
    import torch
    w = _load_la()

    # Downscale if either dimension exceeds MAX_SIDE (preserves aspect ratio)
    if max(pil_img.size) > MAX_SIDE:
        pil_img.thumbnail((MAX_SIDE, MAX_SIDE), Image.LANCZOS)

    messages = [{"role": "user", "content": [
        {"type": "image", "image": pil_img},
        {"type": "text",  "text":  prompt},
    ]}]
    text       = w["processor"].py_apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    images, _  = w["processor"].process_vision_info(messages)
    inputs     = w["processor"](text=[text], images=images, return_tensors="pt").to(w["device"])
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


def _parse_boxes(text: str, img_w: int, img_h: int) -> list[dict]:
    """Extract boxes from model output. Coords are in [0, 1000] → normalize to [0, 1]."""
    boxes = []
    for m in re.finditer(
        r"<box>\s*[<\[]?(\d+)[>\]]?,?\s*[<\[]?(\d+)[>\]]?,?\s*[<\[]?(\d+)[>\]]?,?\s*[<\[]?(\d+)[>\]]?\s*</box>",
        text,
    ):
        x1n, y1n, x2n, y2n = [int(g) / 1000.0 for g in m.groups()]
        boxes.append({
            "x1": round(x1n * img_w), "y1": round(y1n * img_h),
            "x2": round(x2n * img_w), "y2": round(y2n * img_h),
            "x1_norm": round(x1n, 4),  "y1_norm": round(y1n, 4),
            "x2_norm": round(x2n, 4),  "y2_norm": round(y2n, 4),
        })
    return boxes


def _draw_box(draw: ImageDraw.ImageDraw, x1, y1, x2, y2, color: str, label: str) -> None:
    draw.rectangle([x1, y1, x2, y2], outline=color, width=3)
    tw = len(label) * 7 + 6
    draw.rectangle([x1, y1 - 20, x1 + tw, y1], fill=color)
    draw.text((x1 + 3, y1 - 17), label, fill="black")


# ── Main detect function called by Gradio ─────────────────────────────────────

def detect(image_np: np.ndarray, prompt: str, yolo_path: str):
    if image_np is None:
        return None, "", "Upload an image first.", "{}"

    pil = Image.fromarray(image_np).convert("RGB")
    W, H = pil.size

    # LocateAnything inference
    t0  = time.perf_counter()
    raw = _la_predict(pil, prompt)
    elapsed = time.perf_counter() - t0

    boxes = _parse_boxes(raw, W, H)

    # Draw results
    ann  = pil.copy()
    draw = ImageDraw.Draw(ann)

    for b in boxes:
        _draw_box(draw, b["x1"], b["y1"], b["x2"], b["y2"], "#f59e0b", "LA bow")

    status_parts = [f"⏱ {elapsed:.1f}s", f"{len(boxes)} box(es) detected"]

    # Optional YOLO comparison
    if yolo_path.strip():
        try:
            import cv2
            yolo  = _load_yolo(yolo_path.strip())
            bgr   = cv2.cvtColor(image_np, cv2.COLOR_RGB2BGR)
            yresults = yolo(bgr, verbose=False, conf=0.30)
            yolo_count = 0
            for r in yresults:
                if r.boxes is not None:
                    for box, conf in zip(r.boxes.xyxy, r.boxes.conf):
                        bx = box.cpu().numpy()
                        _draw_box(draw, int(bx[0]), int(bx[1]), int(bx[2]), int(bx[3]),
                                  "#22c55e", f"YOLO {float(conf):.2f}")
                        yolo_count += 1
            status_parts.append(f"YOLO: {yolo_count} box(es)")
        except Exception as e:
            status_parts.append(f"YOLO error: {e}")

    box_summary = json.dumps(
        [{"x1_norm": b["x1_norm"], "y1_norm": b["y1_norm"],
          "x2_norm": b["x2_norm"], "y2_norm": b["y2_norm"]} for b in boxes],
        indent=2,
    )

    return np.array(ann), raw, "  •  ".join(status_parts), box_summary


# ── Gradio UI ──────────────────────────────────────────────────────────────────

def build_ui(default_yolo: str = "") -> "gr.Blocks":
    import gradio as gr

    with gr.Blocks(title="Bow Detector", theme=gr.themes.Soft()) as demo:
        gr.Markdown(
            "## Bow Detector — LocateAnything-3B\n"
            "Upload a frame. Model runs locally on your machine. "
            "**First inference loads the model (~6 GB, takes ~1 min).**"
        )

        with gr.Row():
            with gr.Column():
                img_in  = gr.Image(label="Input image", type="numpy", height=420)
                prompt  = gr.Textbox(
                    label="Prompt",
                    value="Locate the violin bow in this image.",
                )
                yolo_tb = gr.Textbox(
                    label="YOLO weights path (optional — leave blank to skip)",
                    value=default_yolo,
                    placeholder="runs/pose/runs/bow/train-4-s/weights/best.pt",
                )
                btn = gr.Button("Run detection", variant="primary", size="lg")

            with gr.Column():
                img_out  = gr.Image(label="Result  (amber = LocateAnything · green = YOLO)", height=420)
                status   = gr.Textbox(label="Status", interactive=False)
                raw_out  = gr.Textbox(label="Raw model output", lines=5, interactive=False)
                boxes_out = gr.Code(label="Detected boxes (normalized)", language="json")

        btn.click(
            detect,
            inputs=[img_in, prompt, yolo_tb],
            outputs=[img_out, raw_out, status, boxes_out],
        )
        # Also run on upload so you don't have to click
        img_in.upload(
            detect,
            inputs=[img_in, prompt, yolo_tb],
            outputs=[img_out, raw_out, status, boxes_out],
        )

    return demo


def main():
    parser = argparse.ArgumentParser(description="Local web demo for LocateAnything-3B bow detection.")
    parser.add_argument("--yolo", default="", help="Path to YOLO best.pt for side-by-side comparison")
    parser.add_argument("--port", type=int, default=7860, help="Port to listen on (default: 7860)")
    args = parser.parse_args()

    try:
        import gradio
    except ImportError:
        print("[ERROR] Gradio not installed. Run:  pip install gradio")
        raise SystemExit(1)

    demo = build_ui(default_yolo=args.yolo)
    print(f"\nStarting server on http://localhost:{args.port}\n")
    print("Open that URL in your browser.")
    demo.launch(server_name="127.0.0.1", server_port=args.port, inbrowser=False)


if __name__ == "__main__":
    main()
