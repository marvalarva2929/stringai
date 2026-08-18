#!/usr/bin/env python3
"""
Burn slide copy onto backgrounds for the fixed 20-part "tips on how to self
learn the violin" series.

    python3 scripts/build_decks.py            # build every part in copy/series.json
    python3 scripts/build_decks.py --part 1    # build just one part

Reads copy/series.json and assets/sorted/pt{NN}_{1..6}.*, writes
out/pt{NN}/01.jpg..06.jpg plus out/manifest.json.

Renders colour emoji (Noto Color Emoji / Apple Color Emoji) inline with the
text. JPEG out, because TikTok's photo endpoint rejects PNG.
"""

import argparse
import json
import os
import platform
import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = Path(__file__).resolve().parent.parent

W, H = 1080, 1920
SAFE_TOP = 300        # TikTok search bar + page counter
SAFE_BOTTOM = 560     # caption block + right-hand action rail
SIDE_MARGIN = 90

# Fixed layout, no per-slide variance: title sits at the same spot in the
# upper-middle of the frame on every slide, one line, bold. The body copy
# sits at the opposite end, near the bottom -- not stacked right under the
# title -- matching a reference slideshow style (white text, black outline,
# no background box, identical position every time).
TITLE_SIZE = 62
TITLE_MIN = 40
SUB_SIZE = 40
SUB_MIN = 28
TITLE_ANCHOR = 0.34      # title's top sits at this fraction of frame height
SUB_MARGIN_BOTTOM = 40   # gap between the sub block's bottom and the bottom safe zone

TEXT_COLOR = (255, 255, 255)
OUTLINE_COLOR = (0, 0, 0)

# The "pt. N" series badge only appears on a deck's first slide, top-right,
# same outlined-text treatment as everything else -- no background box.
BADGE_SIZE = 36
BADGE_MARGIN = 18

# Colour-emoji bitmap fonts only render at specific fixed "strike" sizes
# (Apple Color Emoji: 20/32/40/48/64/96/160; Noto Color Emoji: 109). We draw
# at native size and downscale, trying candidates since the valid strikes
# differ by font and OS version.
EMOJI_NATIVE_CANDIDATES = [109, 160, 96, 64]

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
    """Colour emoji fonts are bitmap-only and only load at fixed strike
    sizes; try each candidate until one the installed font supports."""
    global EMOJI_NATIVE
    if not EMOJI:
        return None
    for size in EMOJI_NATIVE_CANDIDATES:
        try:
            font = ImageFont.truetype(EMOJI, size)
            EMOJI_NATIVE = size
            return font
        except OSError:
            continue
    return None


EMOJI_NATIVE = EMOJI_NATIVE_CANDIDATES[0]
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


def center_x(draw, line, font):
    return (W - measure(draw, line, font)) / 2


def draw_outlined_line(img, draw, x, y, text, font, outline):
    draw_run(img, draw, x, y, text, font, TEXT_COLOR,
              stroke=outline, stroke_fill=OUTLINE_COLOR)


def draw_badge(img, draw, text):
    """Top-right 'pt. N' series marker -- front slide only."""
    font = load(BOLD, BADGE_SIZE)
    outline = max(2, int(BADGE_SIZE * 0.15))
    x = W - SIDE_MARGIN - measure(draw, text, font)
    y = SAFE_TOP + BADGE_MARGIN
    draw_outlined_line(img, draw, x, y, text, font, outline)


def render(img, headline, sub, badge=None):
    """Title sits at a fixed spot in the upper-middle (TITLE_ANCHOR) on every
    slide, one bold line. The body copy sits at the opposite end near the
    bottom safe zone -- the two land on vertically opposite sides of the
    frame, not stacked together. Both centered, white text with a black
    outline, no background box."""
    draw = ImageDraw.Draw(img)
    max_w = W - 2 * SIDE_MARGIN

    font, lines = autofit(draw, headline, BOLD, max_w, TITLE_SIZE, TITLE_MIN, 1)
    line = lines[0]
    outline = max(3, int(font.size * 0.15))
    title_y = int(H * TITLE_ANCHOR)
    draw_outlined_line(img, draw, center_x(draw, line, font), title_y, line, font, outline)

    if sub:
        sub_font, sub_lines = autofit(draw, sub, MEDIUM, max_w, SUB_SIZE, SUB_MIN, 4)
        sub_outline = max(2, int(sub_font.size * 0.13))
        line_h = int(sub_font.size * 1.3)
        block_h = len(sub_lines) * line_h
        y = (H - SAFE_BOTTOM) - SUB_MARGIN_BOTTOM - block_h
        for sub_line in sub_lines:
            draw_outlined_line(img, draw, center_x(draw, sub_line, sub_font), y,
                                sub_line, sub_font, sub_outline)
            y += line_h

    if badge:
        draw_badge(img, draw, badge)

    return img


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--series", default=str(ROOT / "copy/series.json"))
    ap.add_argument("--assets", default=str(ROOT / "assets/sorted"))
    ap.add_argument("--out", default=str(ROOT / "out"))
    ap.add_argument("--part", type=int, default=None,
                     help="build only this part number (default: every part in series.json)")
    args = ap.parse_args()

    series = json.loads(Path(args.series).read_text())
    app = series.get("app_name", "the app")
    assets = Path(args.assets)

    parts = series["parts"]
    if args.part is not None:
        parts = [p for p in parts if p["part"] == args.part]
        if not parts:
            sys.exit(f"no part {args.part} in {args.series}")

    if EMOJI_FONT is None:
        print("warning: no colour emoji font found; emoji will be skipped")

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    manifest = []

    for part in parts:
        n = part["part"]
        tag = f"pt{n:02d}"
        slides = part["slides"]

        bgs = {}
        missing = []
        for i in range(1, len(slides) + 1):
            hits = sorted(assets.glob(f"{tag}_{i}.*"))
            if hits:
                bgs[i] = hits[0]
            else:
                missing.append(f"{tag}_{i}")

        if missing:
            print(f"{tag}: missing {len(missing)} background(s), skipped: {' '.join(missing)}")
            continue

        d = out / tag
        d.mkdir(exist_ok=True)
        for i, slide in enumerate(slides, 1):
            headline = slide["headline"].replace("{app}", app)
            sub = slide["sub"].replace("{app}", app) if slide.get("sub") else None
            badge = f"pt. {n}" if i == 1 else None
            img = render(fit_background(bgs[i]), headline, sub, badge)
            img.save(d / f"{i:02d}.jpg", "JPEG", quality=92, optimize=True)

        manifest.append({
            "part": n,
            "slides": [bgs[i].name for i in range(1, len(slides) + 1)],
        })
        print(f"{tag}: built {len(slides)} slides")

    (out / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"\n{len(manifest)} part(s) -> {out}")


if __name__ == "__main__":
    main()
