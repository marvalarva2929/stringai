#!/usr/bin/env python3
"""
app.py — LocateAnything-3B bow + violin detector web app, built for cloud GPU pods.

Self-contained: this file + requirements.txt is everything the pod needs.
Upload an image → get bow and violin bounding boxes (annotated image + JSON),
plus an estimated bow/string contact point from the box-diagonal intersection.

Usage (on the pod):
    export HF_HOME=/workspace/hf          # cache the 6 GB model on the volume
    python app.py                          # listens on 0.0.0.0:7860

    # With basic auth (recommended — the RunPod proxy URL is public):
    python app.py --auth josh:somepassword

    # Skip model preload at startup (loads lazily on first request instead):
    python app.py --no-preload

See RUNPOD.md in this directory for the full deployment guide.
"""

import argparse
import json
import re
import time

import numpy as np
from PIL import Image, ImageDraw

MODEL_ID = "nvidia/LocateAnything-3B"
MAX_SIDE = 1120  # downscale cap; keeps vision-token count reasonable

BOW_PROMPT = "Locate the violin bow in this image."
VIOLIN_PROMPT = "Locate the violin in this image."

BOW_COLOR = "#f59e0b"      # amber
VIOLIN_COLOR = "#22d3ee"   # cyan
CONTACT_COLOR = "#e879f9"  # magenta — estimated contact point

# ── Model (loaded once, kept in memory) ───────────────────────────────────────

_worker = None


def load_model():
    global _worker
    if _worker is not None:
        return _worker

    import torch
    from transformers import AutoModel, AutoProcessor, AutoTokenizer

    if torch.cuda.is_available():
        device, dtype = "cuda", torch.bfloat16
    elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        device, dtype = "mps", torch.float32  # float16 is numerically unstable on MPS
    else:
        device, dtype = "cpu", torch.float32

    print(f"[LocateAnything] Loading {MODEL_ID} on {device} ({dtype}) — first run downloads ~6 GB …")
    t0 = time.perf_counter()
    tok = AutoTokenizer.from_pretrained(MODEL_ID, trust_remote_code=True)
    proc = AutoProcessor.from_pretrained(MODEL_ID, trust_remote_code=True)
    mdl = AutoModel.from_pretrained(MODEL_ID, torch_dtype=dtype, trust_remote_code=True).to(device).eval()
    print(f"[LocateAnything] Ready in {time.perf_counter() - t0:.0f}s.\n")

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


def make_box(x1n: float, y1n: float, x2n: float, y2n: float, img_w: int, img_h: int) -> dict:
    return {
        "x1": round(x1n * img_w), "y1": round(y1n * img_h),
        "x2": round(x2n * img_w), "y2": round(y2n * img_h),
        "x1_norm": round(x1n, 4), "y1_norm": round(y1n, 4),
        "x2_norm": round(x2n, 4), "y2_norm": round(y2n, 4),
    }


def parse_boxes(text: str, img_w: int, img_h: int) -> list[dict]:
    """Model emits coords in [0, 1000] space; return pixel + normalized [0,1] boxes."""
    boxes = []
    for m in re.finditer(
        r"<box>\s*[<\[]?(\d+)[>\]]?,?\s*[<\[]?(\d+)[>\]]?,?\s*[<\[]?(\d+)[>\]]?,?\s*[<\[]?(\d+)[>\]]?\s*</box>",
        text,
    ):
        x1n, y1n, x2n, y2n = [min(max(int(g) / 1000.0, 0.0), 1.0) for g in m.groups()]
        # The model does not guarantee corner ordering; PIL requires x1<=x2, y1<=y2
        x1n, x2n = sorted((x1n, x2n))
        y1n, y2n = sorted((y1n, y2n))
        boxes.append(make_box(x1n, y1n, x2n, y2n, img_w, img_h))
    return boxes


def select_boxes(boxes: list[dict], mode: str, img_w: int, img_h: int) -> list[dict]:
    """Reduce multiple detections to one box. The model emits no confidence
    scores, so 'first' (emission order ≈ salience) and 'largest' are proxies;
    'union' merges fragments of one object into a single enclosing box."""
    if len(boxes) <= 1 or mode == "all":
        return boxes
    if mode == "first":
        return boxes[:1]
    if mode == "largest":
        return [max(boxes, key=lambda b: (b["x2_norm"] - b["x1_norm"]) * (b["y2_norm"] - b["y1_norm"]))]
    if mode == "union":
        return [make_box(
            min(b["x1_norm"] for b in boxes), min(b["y1_norm"] for b in boxes),
            max(b["x2_norm"] for b in boxes), max(b["y2_norm"] for b in boxes),
            img_w, img_h,
        )]
    return boxes


# ── Contact-point geometry ─────────────────────────────────────────────────────
#
# The bow stick runs corner-to-corner along one diagonal of its (tight) bbox,
# and the violin strings run along one diagonal of the violin bbox. The bow/
# string contact point is therefore the intersection of the right pair of
# diagonals. We don't know which diagonal is right for either box, but the true
# contact point lies ON both objects — so of the 4 candidate intersections,
# usually only the correct one lands inside both segments.

def box_diagonals(box: dict) -> list[tuple[tuple[float, float], tuple[float, float]]]:
    return [
        ((box["x1_norm"], box["y1_norm"]), (box["x2_norm"], box["y2_norm"])),  # TL→BR
        ((box["x1_norm"], box["y2_norm"]), (box["x2_norm"], box["y1_norm"])),  # BL→TR
    ]


def segment_intersection(a1, a2, b1, b2):
    """Intersection of lines a and b. Returns (t, s, point) with
    point = a1 + t*(a2−a1) = b1 + s*(b2−b1), or None if near-parallel."""
    dax, day = a2[0] - a1[0], a2[1] - a1[1]
    dbx, dby = b2[0] - b1[0], b2[1] - b1[1]
    denom = dax * dby - day * dbx
    if abs(denom) < 1e-9:
        return None
    t = ((b1[0] - a1[0]) * dby - (b1[1] - a1[1]) * dbx) / denom
    s = ((b1[0] - a1[0]) * day - (b1[1] - a1[1]) * dax) / denom
    return t, s, (a1[0] + t * dax, a1[1] + t * day)


def contact_candidates(bow_box: dict, violin_box: dict) -> list[dict]:
    """Diagonal-pair intersections that land inside both segments.
    t_along_bow is the position along the bow diagonal — this is the 0–1
    bow-usage metric, up to tip/frog orientation (which pose data resolves)."""
    margin = 0.05
    out = []
    for bi, (a1, a2) in enumerate(box_diagonals(bow_box)):
        for vi, (b1, b2) in enumerate(box_diagonals(violin_box)):
            hit = segment_intersection(a1, a2, b1, b2)
            if hit is None:
                continue
            t, s, (px, py) = hit
            if -margin <= t <= 1 + margin and -margin <= s <= 1 + margin:
                out.append({
                    "x_norm": round(px, 4), "y_norm": round(py, 4),
                    "t_along_bow": round(t, 3),
                    "bow_diag": bi, "violin_diag": vi,
                })
    return out


# ── Drawing ────────────────────────────────────────────────────────────────────

def draw_box(draw: ImageDraw.ImageDraw, box: dict, color: str, label: str) -> None:
    draw.rectangle([box["x1"], box["y1"], box["x2"], box["y2"]], outline=color, width=3)
    tw = len(label) * 7 + 6
    ty = max(box["y1"] - 20, 0)
    draw.rectangle([box["x1"], ty, box["x1"] + tw, ty + 20], fill=color)
    draw.text((box["x1"] + 3, ty + 3), label, fill="black")


def draw_contact(draw: ImageDraw.ImageDraw, cand: dict, img_w: int, img_h: int) -> None:
    x, y = cand["x_norm"] * img_w, cand["y_norm"] * img_h
    r = 7
    draw.ellipse([x - r, y - r, x + r, y + r], outline=CONTACT_COLOR, width=3)
    draw.text((x + r + 3, y - 8), f"t={cand['t_along_bow']:.2f}", fill=CONTACT_COLOR)


# ── Gradio handler ─────────────────────────────────────────────────────────────

def detect(image_np: np.ndarray, find_bow: bool, find_violin: bool,
           bow_prompt: str, violin_prompt: str, box_mode: str, estimate_contact: bool):
    if image_np is None:
        return None, "Upload an image first.", "{}", ""

    pil = Image.fromarray(image_np).convert("RGB")
    if max(pil.size) > MAX_SIDE:
        pil.thumbnail((MAX_SIDE, MAX_SIDE), Image.LANCZOS)
    W, H = pil.size

    targets = []
    if find_bow:
        targets.append(("bow", bow_prompt, BOW_COLOR))
    if find_violin:
        targets.append(("violin", violin_prompt, VIOLIN_COLOR))

    ann = pil.copy()
    draw = ImageDraw.Draw(ann)
    selected: dict[str, list[dict]] = {}
    results: dict[str, list] = {}
    raw_parts = []
    status_parts = []
    total = 0.0

    for name, prompt, color in targets:
        t0 = time.perf_counter()
        raw = predict(pil, prompt)
        elapsed = time.perf_counter() - t0
        total += elapsed

        boxes = select_boxes(parse_boxes(raw, W, H), box_mode, W, H)
        selected[name] = boxes
        results[name] = [
            {k: b[k] for k in ("x1_norm", "y1_norm", "x2_norm", "y2_norm")} for b in boxes
        ]
        for b in boxes:
            draw_box(draw, b, color, name)

        raw_parts.append(f"── {name} ({elapsed:.1f}s) ──\n{raw}")
        status_parts.append(f"{name}: {len(boxes)} box(es)")

    if estimate_contact and selected.get("bow") and selected.get("violin"):
        cands = contact_candidates(selected["bow"][0], selected["violin"][0])
        results["contact_candidates"] = cands
        for c in cands:
            draw_contact(draw, c, W, H)
        status_parts.append(f"contact: {len(cands)} candidate(s)")

    status = f"⏱ {total:.1f}s total  •  " + "  •  ".join(status_parts)
    return np.array(ann), status, json.dumps(results, indent=2), "\n\n".join(raw_parts)


# ── UI ─────────────────────────────────────────────────────────────────────────

def build_ui():
    import gradio as gr

    with gr.Blocks(title="Bow + Violin Detector", theme=gr.themes.Soft()) as demo:
        gr.Markdown(
            "## StringAI — Bow + Violin Detector (LocateAnything-3B)\n"
            "Upload a frame; boxes are returned in normalized [0,1] coords. "
            "Amber = bow · Cyan = violin · Magenta ○ = estimated bow/string "
            "contact point (intersection of box diagonals; t = position along "
            "the bow, 0–1)."
        )
        with gr.Row():
            with gr.Column():
                img_in = gr.Image(label="Input image", type="numpy", height=420)
                with gr.Row():
                    cb_bow = gr.Checkbox(label="Detect bow", value=True)
                    cb_violin = gr.Checkbox(label="Detect violin", value=True)
                    cb_contact = gr.Checkbox(label="Estimate contact point", value=True)
                box_mode = gr.Radio(
                    ["largest", "union", "first", "all"],
                    value="largest",
                    label="Box selection (when the model returns several boxes)",
                    info="largest = biggest box · union = merge all into one enclosing box · "
                         "first = model's first detection · all = keep everything",
                )
                with gr.Accordion("Prompts", open=False):
                    tb_bow = gr.Textbox(label="Bow prompt", value=BOW_PROMPT)
                    tb_violin = gr.Textbox(label="Violin prompt", value=VIOLIN_PROMPT)
                btn = gr.Button("Run detection", variant="primary", size="lg")
            with gr.Column():
                img_out = gr.Image(label="Result", height=420)
                status = gr.Textbox(label="Status", interactive=False)
                boxes_out = gr.Code(label="Boxes + contact (normalized JSON)", language="json")
                raw_out = gr.Textbox(label="Raw model output", lines=6, interactive=False)

        inputs = [img_in, cb_bow, cb_violin, tb_bow, tb_violin, box_mode, cb_contact]
        outputs = [img_out, status, boxes_out, raw_out]
        btn.click(detect, inputs=inputs, outputs=outputs)
        img_in.upload(detect, inputs=inputs, outputs=outputs)

    return demo


def main():
    parser = argparse.ArgumentParser(description="LocateAnything bow+violin web app for cloud pods.")
    parser.add_argument("--port", type=int, default=7860)
    parser.add_argument("--auth", default=None,
                        help="Basic auth as user:password (recommended on a public proxy URL)")
    parser.add_argument("--no-preload", action="store_true",
                        help="Skip loading the model at startup (load lazily on first request)")
    args = parser.parse_args()

    auth = None
    if args.auth:
        user, _, pw = args.auth.partition(":")
        if not pw:
            raise SystemExit("--auth must be user:password")
        auth = (user, pw)

    if not args.no_preload:
        load_model()

    demo = build_ui()
    demo.queue(max_size=8)  # serialize requests — one GPU
    print(f"\nListening on 0.0.0.0:{args.port}\n")
    demo.launch(server_name="0.0.0.0", server_port=args.port, auth=auth, inbrowser=False)


if __name__ == "__main__":
    main()
