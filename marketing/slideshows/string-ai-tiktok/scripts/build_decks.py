#!/usr/bin/env python3
"""
Burn slide copy onto backgrounds and emit shuffled TikTok decks.

    python3 scripts/build_decks.py --count 10

Reads copy/matrix.json and assets/sorted/{slot}{variant}.jpg, writes
out/deck_NN/01.jpg..06.jpg plus out/manifest.json.

Renders colour emoji (Noto Color Emoji / Apple Color Emoji) inline with the
text. JPEG out, because TikTok's photo endpoint rejects PNG.
"""

import argparse
import json
import os
import platform
import random
import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = Path(__file__).resolve().parent.parent

W, H = 1080, 1920
SAFE_TOP = 300        # TikTok search bar + page counter
SAFE_BOTTOM = 560     # caption block + right-hand action rail
SIDE_MARGIN = 90
TEXT_ANCHOR = 0.28    # text block centred at 28% of frame height

# Variant letters are read per-slot from the matrix, so a slot can carry more
# than six as long as a matching background exists for each.

# Colour-emoji bitmap fonts only render at one fixed size; we draw at native
# size and downscale.
EMOJI_NATIVE = 109

FONT_CANDIDATES = {
    "bold": [
        "/usr/share/fonts/truetype/google-fonts/Poppins-Bold.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "C:/Windows/Fonts/arialbd.ttf",
    ],
    "medium": [
        "/usr/share/fonts/truetype/google-fonts/Poppins-Medium.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "C:/Windows/Fonts/arial.ttf",
    ],
    "emoji": [
        "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf",
        "/System/Library/Fonts/Apple Color Emoji.ttc",
        "C:/Windows/Fonts/seguiemj.ttf",
    ],
}

EMOJI_RE = re.compile(
    "([\U0001F000-\U0001FAFF\U00002600-\U000027BF\U0001F1E6-\U0001F1FF"
    "\U00002190-\U000021FF\U00002300-\U000023FF\uFE0F\u200D]+)"
)


def first_existing(paths):
    for p in paths:
        if os.path.exists(p):
            return p
    return None


BOLD = first_existing(FONT_CANDIDATES["bold"])
MEDIUM = first_existing(FONT_CANDIDATES["medium"])
EMOJI = first_existing(FONT_CANDIDATES["emoji"])

if not BOLD:
    sys.exit("No text font found. Install Poppins or edit FONT_CANDIDATES.")


def load(path, size):
    return ImageFont.truetype(path, size)


def emoji_font():
    """Colour emoji fonts are bitmap-only; open at native size."""
    if not EMOJI:
        return None
    try:
        return ImageFont.truetype(EMOJI, EMOJI_NATIVE)
    except OSError:
        return None


EMOJI_FONT = emoji_font()
_emoji_cache = {}


def render_emoji(ch, size):
    """Render one emoji cluster to an RGBA tile of the given size."""
    key = (ch, size)
    if key in _emoji_cache:
        return _emoji_cache[key]
    if EMOJI_FONT is None:
        return None
    tile = Image.new("RGBA", (EMOJI_NATIVE * 2, EMOJI_NATIVE * 2), (0, 0, 0, 0))
    d = ImageDraw.Draw(tile)
    try:
        d.text((0, 0), ch, font=EMOJI_FONT, embedded_color=True)
    except Exception:
        return None
    bbox = tile.getbbox()
    if not bbox:
        return None
    tile = tile.crop(bbox)
    scale = size / max(tile.width, tile.height)
    tile = tile.resize(
        (max(1, int(tile.width * scale)), max(1, int(tile.height * scale))),
        Image.LANCZOS,
    )
    _emoji_cache[key] = tile
    return tile


def segments(text):
    """Split into (chunk, is_emoji) pairs."""
    return [(part, bool(EMOJI_RE.fullmatch(part)))
            for part in EMOJI_RE.split(text) if part]


def measure(draw, text, font):
    """Pixel width of a string, counting emoji as squares."""
    total = 0
    for chunk, is_emoji in segments(text):
        if is_emoji:
            total += sum(font.size * 1.15 for _ in chunk if not _.isspace())
        else:
            total += draw.textlength(chunk, font=font)
    return total


def draw_run(img, draw, x, y, text, font, fill, stroke=0, stroke_fill=None):
    """Draw a mixed text/emoji string; returns the advance width."""
    for chunk, is_emoji in segments(text):
        if is_emoji:
            for ch in chunk:
                if ch.isspace():
                    continue
                size = int(font.size * 1.05)
                tile = render_emoji(ch, size)
                if tile is not None:
                    img.paste(tile, (int(x), int(y + font.size * 0.12)), tile)
                    x += font.size * 1.15
                else:
                    x += font.size * 0.4
        else:
            if stroke:
                draw.text((x, y), chunk, font=font, fill=fill,
                          stroke_width=stroke, stroke_fill=stroke_fill)
            else:
                draw.text((x, y), chunk, font=font, fill=fill)
            x += draw.textlength(chunk, font=font)
    return x


def wrap(draw, text, font, max_width):
    lines, current = [], ""
    for word in text.split():
        trial = f"{current} {word}".strip()
        if measure(draw, trial, font) <= max_width or not current:
            current = trial
        else:
            lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines


def autofit(draw, text, font_path, max_width, start, minimum, max_lines):
    size = start
    while size > minimum:
        font = load(font_path, size)
        lines = wrap(draw, text, font, max_width)
        if len(lines) <= max_lines:
            return font, lines
        size -= 4
    font = load(font_path, minimum)
    return font, wrap(draw, text, font, minimum and max_width)


def fit_background(path):
    img = Image.open(path).convert("RGB")
    target, ratio = W / H, img.width / img.height
    if ratio > target:
        nw = int(img.height * target)
        img = img.crop(((img.width - nw) // 2, 0,
                        (img.width - nw) // 2 + nw, img.height))
    else:
        nh = int(img.width / target)
        img = img.crop((0, (img.height - nh) // 2,
                        img.width, (img.height - nh) // 2 + nh))
    return img.resize((W, H), Image.LANCZOS)


def render(img, headline, sub, style):
    """Both styles anchor the text block at 28% of frame height."""
    draw = ImageDraw.Draw(img)
    max_w = W - 2 * SIDE_MARGIN

    if style == "hero":
        overlay = Image.new("RGBA", img.size, (0, 0, 0, 90))
        img = Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB")
        draw = ImageDraw.Draw(img)
        font, lines = autofit(draw, headline, BOLD, max_w, 112, 62, 5)
    else:
        font, lines = autofit(draw, headline, BOLD, max_w, 78, 46, 5)

    line_h = font.size * 1.3
    sub_font, sub_lines = (None, [])
    if sub:
        sub_font, sub_lines = autofit(draw, sub, MEDIUM, max_w, 44, 30, 4)

    block_h = len(lines) * line_h + (len(sub_lines) * sub_font.size * 1.3 + 30
                                     if sub_lines else 0)
    y = max(SAFE_TOP, int(H * TEXT_ANCHOR - block_h / 2))

    outline = max(3, int(font.size * 0.15))
    for line in lines:
        x = (W - measure(draw, line, font)) / 2
        draw_run(img, draw, x, y, line, font, (255, 255, 255),
                 stroke=outline, stroke_fill=(0, 0, 0))
        y += line_h

    if sub_lines:
        y += 30
        sub_outline = max(2, int(sub_font.size * 0.13))
        for line in sub_lines:
            x = (W - measure(draw, line, sub_font)) / 2
            draw_run(img, draw, x, y, line, sub_font, (245, 245, 245),
                     stroke=sub_outline, stroke_fill=(0, 0, 0))
            y += sub_font.size * 1.3
    return img


def variants_of(matrix, slot, available=None):
    """Variant letters for a slot, optionally limited to ones with a background."""
    keys = sorted(matrix["slots"][slot]["variants"])
    if available is not None:
        keys = [v for v in keys if f"{slot}{v}" in available] or keys
    return keys


def pick_decks(matrix, count, window=4, seed=None, available=None):
    rng = random.Random(seed)
    slots = sorted(matrix["slots"].keys())
    constraints_all = matrix.get("hook_constraints", {})
    decks, history = [], []

    for _ in range(count):
        deck = {}
        hooks = variants_of(matrix, slots[0], available)
        pool = [v for v in hooks
                if all(v != h.get(slots[0]) for h in history[-window:])]
        deck[slots[0]] = rng.choice(pool or hooks)
        constraints = constraints_all.get(deck[slots[0]], {})
        for slot in slots[1:]:
            allowed = variants_of(matrix, slot, available)
            limit = constraints.get(slot)
            if limit:
                allowed = [v for v in allowed if v in limit] or allowed
            fresh = [v for v in allowed
                     if all(v != h.get(slot) for h in history[-window:])]
            deck[slot] = rng.choice(fresh or allowed)
        decks.append(deck)
        history.append(deck)
    return decks


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--matrix", default=str(ROOT / "copy/matrix.json"))
    ap.add_argument("--assets", default=str(ROOT / "assets/sorted"))
    ap.add_argument("--out", default=str(ROOT / "out"))
    ap.add_argument("--count", type=int, default=10)
    ap.add_argument("--seed", type=int, default=None)
    args = ap.parse_args()

    matrix = json.loads(Path(args.matrix).read_text())
    app = matrix.get("app_name", "the app")
    assets = Path(args.assets)

    bgs = {}
    wanted = []
    for slot in matrix["slots"]:
        for v in sorted(matrix["slots"][slot]["variants"]):
            wanted.append(f"{slot}{v}")
            hits = sorted(assets.glob(f"{slot}{v}.*"))
            if hits:
                bgs[f"{slot}{v}"] = hits[0]

    missing = [k for k in wanted if k not in bgs]
    if missing:
        print(f"missing {len(missing)}: {' '.join(missing)}")
    if not bgs:
        sys.exit("no assets found in " + str(assets))

    if EMOJI_FONT is None:
        print("warning: no colour emoji font found; emoji will be skipped")

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    manifest = []

    decks = pick_decks(matrix, args.count, seed=args.seed, available=set(bgs))
    for i, deck in enumerate(decks, 1):
        combo = [f"{s}{deck[s]}" for s in sorted(deck)]
        if any(k not in bgs for k in combo):
            print(f"deck {i:02d}: skipped (missing asset)")
            continue
        d = out / f"deck_{i:02d}"
        d.mkdir(exist_ok=True)
        for n, key in enumerate(combo, 1):
            slot, variant = key[0], key[1]
            spec = matrix["slots"][slot]
            headline, sub = spec["variants"][variant]
            headline = headline.replace("{app}", app)
            sub = sub.replace("{app}", app) if sub else None
            img = render(fit_background(bgs[key]), headline, sub, spec["style"])
            img.save(d / f"{n:02d}.jpg", "JPEG", quality=92, optimize=True)
        manifest.append({
            "deck": f"deck_{i:02d}",
            "slides": combo,
            "hook": combo[0],
        })
        print(f"deck {i:02d}: {' '.join(combo)}")

    (out / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"\n{len(manifest)} decks -> {out}")


if __name__ == "__main__":
    main()
