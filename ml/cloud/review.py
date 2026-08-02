#!/usr/bin/env python3
"""
review.py — Local web UI to review the auto-labeled dataset and tune the
outlier filters BEFORE deleting anything.

Reads the dataset either from an extracted directory or directly from an
uncompressed dataset.tar (no extraction needed — handy when disk is tight).

Filters (adjustable live in the UI):
  1. Full-frame box: a bow or violin box covering ≥ N% of the image
     (the model's "unsure → box everything" failure).
  2. Violin-size outlier: violin box area more than K× the smallest (or
     median) violin box within the same clip (the "violin box swallowed the
     bow" failure).
  3. Single box: only one box total on the frame (the model missed one of
     bow/violin entirely). Fixed rule, not adjustable.

Manual overrides, on top of the auto-filters:
  - Exclude (✕): drop a frame from training entirely, regardless of what the
    filters decide. Toggle on a card or in the lightbox.
  - Edit boxes (✎): open a frame in the lightbox and click "edit boxes" to
    hand-draw/delete bow/violin boxes on the raw image (drag to draw, click
    a box to select it, Delete to remove it). Saved edits fully replace that
    frame's auto-generated labels.

Nothing on disk is touched by this tool — everything (auto-filter flags,
exclusions, manual box edits, references, group splits) is staged in the
browser's localStorage and only written out when you click "Export review",
producing review_flagged.json. Feed that to apply_review_overrides.py to
actually apply the exclusions/edits to a materialized dataset (e.g. the
dataset_clean/ that apply_keeplist.py already built).

Usage:
    cd ml/cloud
    python3 review.py --dataset dataset.tar          # or an extracted dataset/ dir
    → open http://localhost:7788
    → review, then Export review
    python3 apply_review_overrides.py --dataset dataset_clean \\
        --review review_flagged.json --source dataset.tar
"""

from __future__ import annotations

import argparse
import json
import os
import re
import tarfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

# ── Dataset backends ───────────────────────────────────────────────────────────

class DirBackend:
    """Extracted dataset directory: images/{train,val}, labels/{train,val}, annotated/."""

    def __init__(self, root: Path):
        self.root = root

    def label_files(self):
        for split in ("train", "val"):
            d = self.root / "labels" / split
            if not d.exists():
                continue
            for p in sorted(d.glob("*.txt")):
                yield p.stem, split, p.read_text()

    def read_image(self, name: str, split: str, kind: str) -> bytes | None:
        p = (self.root / "annotated" / f"{name}.jpg") if kind == "ann" \
            else (self.root / "images" / split / f"{name}.jpg")
        if kind == "ann" and not p.exists():  # fall back to raw
            p = self.root / "images" / split / f"{name}.jpg"
        return p.read_bytes() if p.exists() else None


class TarBackend:
    """Uncompressed dataset.tar — random access via member offsets, no extraction.

    All reads go through os.pread on ONE shared read-only fd: positioned reads
    are atomic and thread-safe, so the thread-per-request server never opens
    additional handles (a per-request tarfile.open() here previously blew
    through macOS's 256-open-files limit during fast scrolling)."""

    def __init__(self, tar_path: Path):
        self.tar_path = tar_path
        with tarfile.open(tar_path) as tf:
            # (data offset, size) per file — all that's needed for pread
            self.members = {m.name: (m.offset_data, m.size)
                            for m in tf.getmembers() if m.isfile()}
        self.fd = os.open(str(tar_path), os.O_RDONLY)
        # Detect the path prefix in front of "labels/…" (usually "dataset/").
        self.prefix = ""
        for name in self.members:
            m = re.match(r"^(.*?)labels/(?:train|val)/[^/]+\.txt$", name)
            if m:
                self.prefix = m.group(1)
                break

    def _read(self, member_name: str) -> bytes | None:
        entry = self.members.get(member_name)
        if entry is None:
            return None
        offset, size = entry
        return os.pread(self.fd, size, offset)

    def label_files(self):
        pat = re.compile(re.escape(self.prefix) + r"labels/(train|val)/([^/]+)\.txt$")
        for name in sorted(self.members):
            m = pat.match(name)
            if m:
                data = self._read(name)
                if data is not None:
                    yield m.group(2), m.group(1), data.decode("utf-8", "replace")

    def read_image(self, name: str, split: str, kind: str) -> bytes | None:
        if kind == "ann":
            data = self._read(f"{self.prefix}annotated/{name}.jpg")
            if data is not None:
                return data
        return self._read(f"{self.prefix}images/{split}/{name}.jpg")


# ── Metadata ───────────────────────────────────────────────────────────────────

def clip_of(name: str) -> str:
    """Frame names are <clip>_<frameidx> (extract_frames.py / autolabel.py)."""
    m = re.match(r"^(.*)_(\d{4,})$", name)
    return m.group(1) if m else name


def load_frames(backend, source: str) -> list[dict]:
    """source distinguishes frames from different datasets shown together
    (e.g. "current" vs "previous") — prefixed onto name/clip so identifiers
    stay unique across datasets and the /img endpoint can route each request
    back to the right backend."""
    frames = []
    for name, split, text in backend.label_files():
        bow = violin = violin_w = None
        boxes = []
        for line in text.splitlines():
            parts = line.split()
            if len(parts) != 5:
                continue
            cls = int(parts[0])
            cx, cy, w, h = (float(p) for p in parts[1:])
            area = w * h
            boxes.append({"cls": cls, "cx": cx, "cy": cy, "w": w, "h": h})
            if cls == 0:
                bow = max(bow or 0, area)
            elif cls == 1:
                if violin is None or area > violin:
                    violin = area
                    violin_w = w
        frames.append({
            "name": f"{source}:{name}", "split": split, "clip": f"{source}:{clip_of(name)}",
            "source": source,
            "bow": bow, "violin": violin, "violin_w": violin_w,
            "boxes": boxes,
        })
    return frames


# ── HTML/JS page ───────────────────────────────────────────────────────────────

INDEX_HTML = """<!doctype html>
<html><head><meta charset="utf-8"><title>Dataset Review</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #101214; color: #e6e6e6;
         font: 14px/1.4 -apple-system, system-ui, sans-serif; }
  #bar { position: sticky; top: 0; z-index: 10; background: #1a1d21;
         padding: 10px 16px; display: flex; flex-wrap: wrap; gap: 18px;
         align-items: center; border-bottom: 1px solid #2c3138; }
  #bar label { display: flex; align-items: center; gap: 8px; white-space: nowrap; }
  #bar .val { font-variant-numeric: tabular-nums; color: #f59e0b; min-width: 3.5em; }
  #counts { margin-left: auto; font-variant-numeric: tabular-nums; }
  #counts b.f1 { color: #ef4444; }  #counts b.f2 { color: #f59e0b; }  #counts b.f3 { color: #a855f7; }
  button { background: #2563eb; color: white; border: 0; border-radius: 6px;
           padding: 6px 14px; font-size: 14px; cursor: pointer; }
  details { margin: 10px 14px; }
  summary { cursor: pointer; font-weight: 600; padding: 6px 0;
            font-variant-numeric: tabular-nums; }
  summary .cnt { color: #9aa3ad; font-weight: 400; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
          gap: 8px; }
  .card { position: relative; border: 3px solid #2c3138; border-radius: 6px;
          overflow: hidden; background: #000; }
  .card .imgWrap { position: relative; width: 100%; height: 120px; }
  .card img { width: 100%; height: 120px; object-fit: fill; display: block; }
  .card .cardSvg { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
  .card .cap { padding: 2px 6px; font-size: 11px; color: #9aa3ad;
               display: flex; justify-content: space-between; }
  .card.flag1 { border-color: #ef4444; }
  .card.flag2 { border-color: #f59e0b; }
  .card.flag3 { border-color: #a855f7; }
  .card .star { position: absolute; top: 2px; right: 4px; font-size: 18px;
                cursor: pointer; color: #6b7280; opacity: 0; z-index: 2;
                text-shadow: 0 0 4px #000; user-select: none; }
  .card:hover .star { opacity: 1; }
  .card.ref .star { opacity: 1; color: #22c55e; }
  .card.ref:not(.flag1):not(.flag2):not(.flag3) { border-color: #22c55e; }
  summary .ref-tag { color: #22c55e; font-weight: 400; }
  .card .scis { position: absolute; top: 2px; right: 28px; font-size: 15px;
                cursor: pointer; color: #6b7280; opacity: 0; z-index: 2;
                text-shadow: 0 0 4px #000; user-select: none; }
  .card:hover .scis { opacity: 1; }
  .card.splitStart .scis { opacity: 1; color: #38bdf8; }
  .card.splitStart { box-shadow: -5px 0 0 0 #38bdf8; }
  .divider { grid-column: 1 / -1; color: #38bdf8; font-size: 12px;
             padding: 8px 2px 0; border-top: 1px dashed #38bdf8; }
  .card .badge { position: absolute; top: 4px; left: 4px; font-size: 11px;
                 font-weight: 700; padding: 1px 6px; border-radius: 4px; display: none; }
  .card.flag1 .badge { display: block; background: #ef4444; color: #fff; }
  .card.flag2 .badge { display: block; background: #f59e0b; color: #000; }
  .card.flag3 .badge { display: block; background: #a855f7; color: #fff; }
  .card.hidden { display: none; }
  .card .excl { position: absolute; top: 2px; right: 52px; font-size: 15px;
                cursor: pointer; color: #6b7280; opacity: 0; z-index: 2;
                text-shadow: 0 0 4px #000; user-select: none; }
  .card:hover .excl { opacity: 1; }
  .card.excluded .excl { opacity: 1; color: #ef4444; }
  .card.excluded { filter: grayscale(1); }
  .card.excluded img { opacity: .35; }
  .card.excluded::after { content: "EXCLUDED"; position: absolute; inset: 0;
    display: flex; align-items: center; justify-content: center; pointer-events: none;
    font-size: 11px; font-weight: 700; color: #ef4444; letter-spacing: .05em; }
  .card .pencil { position: absolute; bottom: 24px; right: 4px; font-size: 13px;
    color: #22c55e; text-shadow: 0 0 4px #000; z-index: 2; display: none; pointer-events: none; }
  .card.edited .pencil { display: block; }
  .card .wrong { position: absolute; top: 2px; right: 76px; font-size: 14px;
                cursor: pointer; color: #6b7280; opacity: 0; z-index: 2;
                text-shadow: 0 0 4px #000; user-select: none; }
  .card:hover .wrong { opacity: 1; }
  .card.wrongMark .wrong { opacity: 1; color: #f59e0b; }
  #lbImgWrap { position: relative; display: inline-block; line-height: 0; }
  #lbSvg { position: absolute; left: 0; top: 0; display: none; }
  #editBar { display: none; gap: 10px; align-items: center; flex-wrap: wrap;
             justify-content: center; max-width: 80vw; }
  #flowBar { display: none; gap: 14px; align-items: center; flex-wrap: wrap;
             justify-content: center; max-width: 80vw; }
  #flowBar #flowProgress { font-variant-numeric: tabular-nums; color: #f59e0b; font-weight: 700; }
  #flowBar #flowName { color: #9aa3ad; }
  #flowBar #flowPhaseLabel { font-size: 14px; }
  #fixWrongBtn { background: #f59e0b; color: #101214; font-weight: 700; }
  #lb { position: fixed; inset: 0; z-index: 100; background: rgba(5,6,8,.94);
        display: none; align-items: center; justify-content: center; gap: 12px; }
  #lb.open { display: flex; }
  #lb img { max-width: 84vw; max-height: 84vh; object-fit: contain;
            border-radius: 6px; border: 3px solid #2c3138; }
  #lb.flag1 img { border-color: #ef4444; }
  #lb.flag2 img { border-color: #f59e0b; }
  #lb.flag3 img { border-color: #a855f7; }
  #lbMain { display: flex; flex-direction: column; align-items: center; gap: 8px; }
  #lbCap { font-variant-numeric: tabular-nums; color: #cdd3da; }
  #lbCap b.f1 { color: #ef4444; } #lbCap b.f2 { color: #f59e0b; } #lbCap b.f3 { color: #a855f7; }
  .lbBtn { background: #1a1d21; color: #e6e6e6; border: 1px solid #2c3138;
           border-radius: 8px; font-size: 26px; padding: 14px 18px; cursor: pointer; }
  .lbBtn:hover { background: #2c3138; }
  #lbClose { position: absolute; top: 14px; right: 16px; font-size: 18px; }
  .srcBadge { font-size: 10px; padding: 1px 6px; border-radius: 4px; margin-right: 6px;
              text-transform: uppercase; letter-spacing: .03em; }
  .srcBadge.current { background: #1e3a8a; color: #93c5fd; }
  .srcBadge.previous { background: #78350f; color: #fde68a; }
</style></head>
<body>
<div id="bar">
  <label>Full-frame ≥ <input type="range" id="full" min="50" max="100" step="1" value="85">
    <span class="val" id="fullVal">85%</span></label>
  <label>Violin > <input type="range" id="ratio" min="1.2" max="4" step="0.05" value="2">
    <span class="val" id="ratioVal">2.00×</span></label>
  <label>vs <select id="baseline" title="Clips with a ★ reference frame always compare against it">
    <option value="min">smallest in clip</option>
    <option value="median">median in clip</option>
  </select></label>
  <label>Show <select id="view">
    <option value="all">everything</option>
    <option value="flagged">flagged (any)</option>
    <option value="flag1">full-frame only</option>
    <option value="flag2">violin-size only</option>
    <option value="flag3">single-box only</option>
    <option value="clean">unflagged only</option>
    <option value="excluded">excluded (manual)</option>
    <option value="edited">manually edited</option>
    <option value="wrong">wrong (flagged + marked)</option>
    <option value="training">included in training</option>
  </select></label>
  <label><input type="checkbox" id="showCurrent" checked> current</label>
  <label id="showPrevWrap" style="display:none"><input type="checkbox" id="showPrevious"> previous</label>
  <button id="collapse">Collapse all</button>
  <span id="counts"></span>
  <button id="fixWrongBtn">Fix wrong frames (<span id="wrongCount">0</span>)</button>
  <button id="export">Export review (flags + manual edits)</button>
  <button id="resetManual" style="background:#7f1d1d">Reset manual edits</button>
  <button id="excludeEmptyBtn" style="background:#7f1d1d">Exclude no-box frames</button>
</div>
<div id="groups"></div>
<div id="lb">
  <button class="lbBtn" id="lbPrev">&#8592;</button>
  <div id="lbMain">
    <div id="lbImgWrap"><img id="lbImg"><svg id="lbSvg"></svg></div>
    <div id="lbCap"></div>
    <div id="editBar">
      <span style="color:#9aa3ad">drag to draw &middot; click a box to select &middot; Delete to remove &middot; right-click to erase all</span>
      <button class="lbBtn" id="clsBow" style="font-size:14px">Bow</button>
      <button class="lbBtn" id="clsViolin" style="font-size:14px">Violin</button>
      <button class="lbBtn" id="delBoxBtn" style="font-size:14px">Delete selected</button>
      <button class="lbBtn" id="resetBoxBtn" style="font-size:14px">Reset to auto-labels</button>
      <button class="lbBtn" id="saveBoxBtn" style="font-size:14px">Save edits</button>
      <button class="lbBtn" id="cancelBoxBtn" style="font-size:14px">Cancel</button>
    </div>
    <div id="flowBar">
      <span id="flowProgress"></span>
      <span id="flowName"></span>
      <span id="flowPhaseLabel" style="font-weight:700"></span>
      <button class="lbBtn" id="flowBackBtn" style="font-size:14px">&#8592; Back</button>
      <button class="lbBtn" id="flowSkipBtn" style="font-size:14px">Boxes are fine &mdash; next</button>
      <button class="lbBtn" id="flowExclBtn" style="font-size:14px">Exclude frame</button>
      <button class="lbBtn" id="flowStopBtn" style="font-size:14px">Stop</button>
    </div>
    <div id="lbActions" style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center">
      <button class="lbBtn" id="lbRefBtn" style="font-size:14px">&#9733; set as group reference</button>
      <button class="lbBtn" id="lbSplitBtn" style="font-size:14px">&#9986; start new group here</button>
      <button class="lbBtn" id="lbEditBtn" style="font-size:14px">&#9998; edit boxes</button>
      <button class="lbBtn" id="lbExclBtn" style="font-size:14px">&#10007; exclude from training</button>
      <button class="lbBtn" id="lbWrongBtn" style="font-size:14px">&#9873; mark wrong</button>
    </div>
  </div>
  <button class="lbBtn" id="lbNext">&#8594;</button>
  <button class="lbBtn" id="lbClose">&#10005;</button>
</div>
<script>
let frames = [], clips = {}, byName = {};
let sourceVisible = { current: true, previous: false };

function clipSource(clip) { return clip.slice(0, clip.indexOf(':')); }
function clipDisplay(clip) { return clip.slice(clip.indexOf(':') + 1); }

// Starred "perfect" frames — one allowed per group; persisted locally.
// (Older versions stored {clip: name}; migrate to a flat name array.)
let refs = [];
try {
  const o = JSON.parse(localStorage.getItem('bowReviewRefs') || '[]');
  refs = Array.isArray(o) ? o : Object.values(o);
} catch {}

// User-defined group splits: clip → Set of frame names that START a new
// group (for clips filmed from several angles). Persisted locally.
let splits = {};
try {
  const o = JSON.parse(localStorage.getItem('bowReviewSplits') || '{}');
  for (const [c, arr] of Object.entries(o)) splits[c] = new Set(arr);
} catch {}

// Manually excluded frames — dropped from training regardless of the
// auto-filters. Persisted locally.
let excluded = new Set();
try {
  const o = JSON.parse(localStorage.getItem('bowReviewExcluded') || '[]');
  if (Array.isArray(o)) excluded = new Set(o);
} catch {}

// Manual box overrides — name -> [{cls,cx,cy,w,h}, ...], fully replacing
// that frame's auto-generated labels. Persisted locally.
let manualLabels = {};
try {
  manualLabels = JSON.parse(localStorage.getItem('bowReviewManualLabels') || '{}');
} catch {}

// Frames manually flagged "needs re-annotation" — unioned with the
// auto-flagged (flag1/flag2/flag3) set to build the "Fix wrong frames" queue.
// Persisted locally.
let wrong = new Set();
try {
  const o = JSON.parse(localStorage.getItem('bowReviewWrong') || '[]');
  if (Array.isArray(o)) wrong = new Set(o);
} catch {}

function saveRefs() { localStorage.setItem('bowReviewRefs', JSON.stringify(refs)); }
function saveSplits() {
  const o = {};
  for (const [c, s] of Object.entries(splits)) if (s.size) o[c] = [...s];
  localStorage.setItem('bowReviewSplits', JSON.stringify(o));
}
function saveExcluded() { localStorage.setItem('bowReviewExcluded', JSON.stringify([...excluded])); }
function saveManualLabels() { localStorage.setItem('bowReviewManualLabels', JSON.stringify(manualLabels)); }
function saveWrong() { localStorage.setItem('bowReviewWrong', JSON.stringify([...wrong])); }

function toggleExcluded(f) {
  excluded.has(f.name) ? excluded.delete(f.name) : excluded.add(f.name);
  saveExcluded();
  recompute();
}

function toggleWrong(f) {
  wrong.has(f.name) ? wrong.delete(f.name) : wrong.add(f.name);
  saveWrong();
  recompute();
}

// Frames needing re-annotation: auto-flagged (flag1/flag2/flag3) OR
// manually marked wrong, minus anything already fixed (has a manual
// override) or excluded (doesn't need annotation at all).
function computeWrongQueue() {
  return frames.filter(f => sourceVisible[f.source] &&
    (f.flag1 || f.flag2 || f.flag3 || wrong.has(f.name)) && !manualLabels[f.name] && !excluded.has(f.name));
}

function boxesForFrame(f) {
  const src = manualLabels[f.name] || f.boxes || [];
  return src.map(b => ({ ...b }));
}

// Draws the current box set (manual edit if any, else the original labels)
// onto a card's thumbnail — the grid otherwise has no way to show boxes for
// datasets with no baked-in annotated/ overlay (e.g. the "previous" set),
// and a baked-in image would go stale the moment a frame is manually edited.
function renderCardOverlay(f) {
  if (!f.cardSvg) return;
  f.cardSvg.innerHTML = '';
  for (const b of boxesForFrame(f)) {
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', b.cx - b.w / 2);
    rect.setAttribute('y', b.cy - b.h / 2);
    rect.setAttribute('width', Math.max(b.w, 0.001));
    rect.setAttribute('height', Math.max(b.h, 0.001));
    rect.setAttribute('fill', 'none');
    rect.setAttribute('stroke', CLASS_COLOR[b.cls] || '#fff');
    rect.setAttribute('stroke-width', 1.5);
    rect.setAttribute('vector-effect', 'non-scaling-stroke');
    f.cardSvg.appendChild(rect);
  }
}

function toggleRef(f) {
  const i = refs.indexOf(f.name);
  if (i >= 0) refs.splice(i, 1);
  else {
    // one reference per group — replace any other star in the same group
    refs = refs.filter(n => !byName[n] || byName[n].segKey !== f.segKey);
    refs.push(f.name);
  }
  saveRefs();
  recompute();
}

function toggleSplit(f) {
  if (clips[f.clip][0] === f) return;  // first frame already starts group 1
  const sp = splits[f.clip] ??= new Set();
  sp.has(f.name) ? sp.delete(f.name) : sp.add(f.name);
  saveSplits();
  recompute();
}

// review state (refs/splits/excluded/manualLabels/wrong) predating the
// "previous dataset" feature was saved under bare names/clips (no
// "source:" prefix). Remap it onto the new scheme so it isn't orphaned —
// a bare key that matches exactly one loaded frame/clip (by its unprefixed
// form) gets rewritten to that frame/clip's prefixed identifier; anything
// that doesn't match anything just passes through unchanged (already
// migrated, or genuinely stale).
function migrateBarePersistedState() {
  const byBareName = {};
  const byBareClip = {};
  for (const f of frames) {
    const bareName = f.name.slice(f.name.indexOf(':') + 1);
    (byBareName[bareName] ??= []).push(f.name);
    const bareClip = f.clip.slice(f.clip.indexOf(':') + 1);
    (byBareClip[bareClip] ??= new Set()).add(f.clip);
  }
  const migrateNames = (arr) => arr.flatMap(n => byBareName[n] || [n]);

  refs = migrateNames(refs);
  wrong = new Set(migrateNames([...wrong]));
  excluded = new Set(migrateNames([...excluded]));

  const migratedManual = {};
  for (const [name, val] of Object.entries(manualLabels)) {
    for (const t of byBareName[name] || [name]) migratedManual[t] = val;
  }
  manualLabels = migratedManual;

  const migratedSplits = {};
  for (const [clip, set] of Object.entries(splits)) {
    const migratedSet = new Set(migrateNames([...set]));
    for (const tc of byBareClip[clip] || [clip]) migratedSplits[tc] = migratedSet;
  }
  splits = migratedSplits;

  // Persist so this is a one-time migration, not a per-load cost.
  saveRefs();
  saveWrong();
  saveExcluded();
  saveManualLabels();
  saveSplits();
}

async function init() {
  frames = (await (await fetch('data.json')).json()).frames;
  for (const f of frames) { (clips[f.clip] ??= []).push(f); byName[f.name] = f; }

  migrateBarePersistedState();

  // Drop stale entries pointing at frames that no longer exist
  refs = refs.filter(n => byName[n]);

  if (frames.some(f => f.source === 'previous')) {
    document.getElementById('showPrevWrap').style.display = '';
  }

  const groupsEl = document.getElementById('groups');
  for (const [clip, list] of Object.entries(clips)) {
    const det = document.createElement('details');
    det.open = true;
    const sum = document.createElement('summary');
    sum.innerHTML = `<span class="srcBadge ${clipSource(clip)}">${clipSource(clip)}</span> ` +
      `${clipDisplay(clip)} <span class="cnt"></span>`;
    det.appendChild(sum);
    const grid = document.createElement('div');
    grid.className = 'grid';
    for (const f of list) {
      const card = document.createElement('div');
      card.className = 'card';
      f.url = `img?kind=ann&split=${f.split}&name=${encodeURIComponent(f.name)}`;
      f.thumbUrl = `img?kind=raw&split=${f.split}&name=${encodeURIComponent(f.name)}`;
      card.innerHTML =
        `<div class="imgWrap"><img loading="lazy" src="${f.thumbUrl}" style="cursor:zoom-in">` +
        `<svg class="cardSvg" viewBox="0 0 1 1" preserveAspectRatio="none"></svg></div>` +
        `<span class="badge"></span>` +
        `<span class="star" title="Set as this group's reference (violin-size filter compares against it)">\\u2605</span>` +
        `<span class="scis" title="Start a new group at this image (angle change)">\\u2702</span>` +
        `<span class="excl" title="Exclude this frame from training">\\u2715</span>` +
        `<span class="wrong" title="Mark as wrong (needs re-annotation)">\\u2691</span>` +
        `<span class="pencil" title="Manually re-annotated">\\u270e</span>` +
        `<div class="cap"><span>${f.name.slice(clip.length + 1)}</span><span class="r"></span></div>`;
      card.querySelector('img').addEventListener('click', () => openLightbox(f));
      card.querySelector('.star').addEventListener('click', () => toggleRef(f));
      card.querySelector('.scis').addEventListener('click', () => toggleSplit(f));
      card.querySelector('.excl').addEventListener('click', () => toggleExcluded(f));
      card.querySelector('.wrong').addEventListener('click', () => toggleWrong(f));
      if (excluded.has(f.name)) card.classList.add('excluded');
      if (manualLabels[f.name]) card.classList.add('edited');
      if (wrong.has(f.name)) card.classList.add('wrongMark');
      f.el = card;
      f.cardSvg = card.querySelector('.cardSvg');
      renderCardOverlay(f);
      f.badgeEl = card.querySelector('.badge');
      f.ratioEl = card.querySelector('.r');
      grid.appendChild(card);
    }
    det.appendChild(grid);
    groupsEl.appendChild(det);
    clips[clip].sumEl = sum.querySelector('.cnt');
  }
  for (const id of ['full', 'ratio', 'baseline', 'view'])
    document.getElementById(id).addEventListener('input', recompute);
  document.getElementById('showCurrent').addEventListener('change', (e) => {
    sourceVisible.current = e.target.checked;
    recompute();
  });
  document.getElementById('showPrevious').addEventListener('change', (e) => {
    sourceVisible.previous = e.target.checked;
    recompute();
  });
  document.getElementById('export').addEventListener('click', exportFlagged);
  document.getElementById('collapse').addEventListener('click', () => {
    const all = [...document.querySelectorAll('#groups details')];
    const anyOpen = all.some(d => d.open);
    for (const d of all) d.open = !anyOpen;
    document.getElementById('collapse').textContent = anyOpen ? 'Expand all' : 'Collapse all';
  });
  document.getElementById('lbPrev').addEventListener('click', () => lbStep(-1));
  document.getElementById('lbNext').addEventListener('click', () => lbStep(1));
  document.getElementById('lbClose').addEventListener('click', () => {
    if (flowMode) endFlow(false); else closeLightbox();
  });
  document.getElementById('lbRefBtn').addEventListener('click', () => {
    if (lbIndex >= 0 && visList[lbIndex]) toggleRef(visList[lbIndex]);
  });
  document.getElementById('lbSplitBtn').addEventListener('click', () => {
    if (lbIndex >= 0 && visList[lbIndex]) toggleSplit(visList[lbIndex]);
  });
  document.getElementById('lbExclBtn').addEventListener('click', () => {
    if (lbIndex >= 0 && visList[lbIndex]) toggleExcluded(visList[lbIndex]);
  });
  document.getElementById('lbWrongBtn').addEventListener('click', () => {
    if (lbIndex >= 0 && visList[lbIndex]) toggleWrong(visList[lbIndex]);
  });
  document.getElementById('lbEditBtn').addEventListener('click', () => {
    if (!editing) openEditor();
  });
  document.getElementById('fixWrongBtn').addEventListener('click', startFlow);
  document.getElementById('resetManual').addEventListener('click', () => {
    const n = Object.keys(manualLabels).length;
    if (!confirm(`Clear all ${n} manual edit(s)/confirmation(s)? Excluded frames and wrong-marks are kept. This can't be undone.`)) return;
    manualLabels = {};
    saveManualLabels();
    for (const f of frames) renderCardOverlay(f);
    recompute();
  });
  document.getElementById('excludeEmptyBtn').addEventListener('click', () => {
    const targets = frames.filter(f => !excluded.has(f.name) && boxesForFrame(f).length === 0);
    if (!targets.length) { alert('No frames with zero boxes found.'); return; }
    if (!confirm(`Exclude and mark wrong: ${targets.length} frame(s) with no boxes at all?`)) return;
    for (const f of targets) { excluded.add(f.name); wrong.add(f.name); }
    saveExcluded();
    saveWrong();
    recompute();
  });
  document.getElementById('flowBackBtn').addEventListener('click', flowGoBack);
  document.getElementById('flowSkipBtn').addEventListener('click', () => {
    const f = flowQueue[flowIndex];
    const boxes = boxesForFrame(f);
    manualLabels[f.name] = boxes.map(b => ({ cls: b.cls, cx: b.cx, cy: b.cy, w: b.w, h: b.h }));
    saveManualLabels();
    markResolvedCard(f);
    f.el.classList.add('edited');
    renderCardOverlay(f);
    autoExcludeIfEmpty(f, boxes);
    flowIndex++;
    enterFlowFrame();
  });
  document.getElementById('flowExclBtn').addEventListener('click', () => {
    const f = flowQueue[flowIndex];
    excluded.add(f.name);
    saveExcluded();
    markResolvedCard(f);
    f.el.classList.add('excluded');
    flowIndex++;
    enterFlowFrame();
  });
  document.getElementById('flowStopBtn').addEventListener('click', () => endFlow(false));
  document.getElementById('clsBow').addEventListener('click', () => { curClass = 0; updateClsButtons(); });
  document.getElementById('clsViolin').addEventListener('click', () => { curClass = 1; updateClsButtons(); });
  document.getElementById('delBoxBtn').addEventListener('click', () => {
    if (selectedBox >= 0) { overlayBoxes.splice(selectedBox, 1); selectedBox = -1; drawEditorBoxes(); }
  });
  document.getElementById('resetBoxBtn').addEventListener('click', () => {
    const f = visList[lbIndex];
    if (!f) return;
    delete manualLabels[f.name];
    saveManualLabels();
    renderCardOverlay(f);
    closeEditor(false);
    recompute();  // re-derive flag1/2/3 (may reflag it) and refresh the card/lightbox
  });
  document.getElementById('saveBoxBtn').addEventListener('click', () => {
    const f = visList[lbIndex];
    if (!f) return;
    manualLabels[f.name] = overlayBoxes.map(b => ({ cls: b.cls, cx: b.cx, cy: b.cy, w: b.w, h: b.h }));
    saveManualLabels();
    renderCardOverlay(f);
    closeEditor(false);
    recompute();  // re-derive flag1/2/3 (now suppressed by the manual edit) and refresh the card/lightbox
  });
  document.getElementById('cancelBoxBtn').addEventListener('click', () => closeEditor(true));
  document.getElementById('lbSvg').addEventListener('mousedown', editorMouseDown);
  document.getElementById('lbSvg').addEventListener('contextmenu', editorContextMenu);
  document.addEventListener('mousemove', editorMouseMove);
  document.addEventListener('mouseup', editorMouseUp);
  window.addEventListener('resize', () => {
    if (document.getElementById('lb').classList.contains('open') &&
        document.getElementById('lbSvg').style.display !== 'none') drawEditorBoxes();
  });
  document.getElementById('lb').addEventListener('click', (e) => {
    if (suppressNextBackdropClick) { suppressNextBackdropClick = false; return; }
    if (e.target.id !== 'lb') return;
    if (flowMode) endFlow(false); else closeLightbox();  // click on the backdrop closes
  });
  document.addEventListener('keydown', (e) => {
    if (!document.getElementById('lb').classList.contains('open')) return;
    if (flowMode) {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedBox >= 0) {
          e.preventDefault();
          overlayBoxes.splice(selectedBox, 1);
          selectedBox = -1;
          drawEditorBoxes();
        }
      } else if (e.key === 'Escape') {
        endFlow(false);
      }
      return;
    }
    if (editing) {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedBox >= 0) {
          e.preventDefault();
          overlayBoxes.splice(selectedBox, 1);
          selectedBox = -1;
          drawEditorBoxes();
        }
      } else if (e.key === 'Escape') {
        closeEditor(true);
      }
      return;  // suppress frame navigation while editing
    }
    if (e.key === 'ArrowLeft') lbStep(-1);
    else if (e.key === 'ArrowRight') lbStep(1);
    else if (e.key === 'Escape') closeLightbox();
  });
  recompute();
}

function isVisible(f, view) {
  if (!sourceVisible[f.source]) return false;
  if (view === 'excluded') return excluded.has(f.name);
  if (view === 'edited') return !!manualLabels[f.name];
  if (view === 'wrong') return f.flag1 || f.flag2 || f.flag3 || wrong.has(f.name);
  if (view === 'flagged') return f.flag1 || f.flag2 || f.flag3;
  if (view === 'flag1') return f.flag1;
  if (view === 'flag2') return f.flag2;
  if (view === 'flag3') return f.flag3;
  if (view === 'clean') return !f.flag1 && !f.flag2 && !f.flag3;
  if (view === 'training')
    return !excluded.has(f.name) &&
      (!!manualLabels[f.name] || (!f.flag1 && !f.flag2 && !f.flag3 && !wrong.has(f.name)));
  return true;
}

// ── Lightbox (focus mode) ──────────────────────────────────────
let visList = [];   // frames matching the current view, in display order
let lbIndex = -1;   // index into visList, -1 = closed

// ── Manual box editor ──────────────────────────────────────────
let overlayBoxes = null;  // boxes currently drawn in the SVG overlay (view or edit)
let editing = false;      // whether the box editor is actively accepting edits
let selectedBox = -1;     // index into overlayBoxes, -1 = none selected
let curClass = 0;         // 0=bow, 1=violin — class assigned to newly-drawn boxes (manual edit mode)
let drawStartPt = null;   // {x,y} normalized, set while a new box is being dragged
let replacedBoxes = [];   // boxes of this phase's class pulled out for the current drag, restored if it's cancelled
// A drag that ends outside the image (common for tall/wide boxes) releases
// the mouse over the backdrop — mousedown and mouseup then have different
// targets, and the browser still synthesizes a 'click' on their common
// ancestor (#lb itself), which looks exactly like a "click the backdrop to
// close" gesture. Suppress the next backdrop click right after a real drag.
let suppressNextBackdropClick = false;

// "Fix wrong frames" flow — rips through flagged/marked-wrong frames fast
// via two sequential phases per frame: violin, then bow. Each frame starts
// showing its existing boxes. Each phase: drag to REPLACE that class's box
// with a freshly drawn one, or right-click to skip — leaving that class's
// box (or lack of one) exactly as it was — and move to the next phase.
// After the bow phase (drawn or skipped) it auto-saves and advances to the
// next frame in the queue.
let flowMode = false;
let flowQueue = [];
let flowIndex = 0;
let flowPhase = 'violin';  // 'violin' | 'bow' — which box the current frame is on

const CLASS_COLOR = ['#ef4444', '#3b82f6'];  // bow, violin

function updateClsButtons() {
  document.getElementById('clsBow').style.background = curClass === 0 ? '#ef4444' : '#1a1d21';
  document.getElementById('clsViolin').style.background = curClass === 1 ? '#3b82f6' : '#1a1d21';
}

function svgPointFromEvent(e) {
  const r = document.getElementById('lbSvg').getBoundingClientRect();
  const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
  return { x, y };
}

function drawEditorBoxes() {
  const img = document.getElementById('lbImg');
  const svg = document.getElementById('lbSvg');
  if (!img.clientWidth || !img.clientHeight) return;
  svg.setAttribute('width', img.clientWidth);
  svg.setAttribute('height', img.clientHeight);
  svg.setAttribute('viewBox', '0 0 1 1');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.innerHTML = '';
  (overlayBoxes || []).forEach((b, i) => {
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', b.cx - b.w / 2);
    rect.setAttribute('y', b.cy - b.h / 2);
    rect.setAttribute('width', Math.max(b.w, 0.001));
    rect.setAttribute('height', Math.max(b.h, 0.001));
    rect.setAttribute('fill', 'none');
    rect.setAttribute('stroke', CLASS_COLOR[b.cls] || '#fff');
    rect.setAttribute('stroke-width', i === selectedBox ? 3 : 1.5);
    rect.setAttribute('vector-effect', 'non-scaling-stroke');
    rect.style.cursor = editing ? 'pointer' : 'default';
    rect.addEventListener('mousedown', (e) => {
      // In flow mode a drag should always start a new box, even if it
      // starts on top of an existing one — don't let the box steal the
      // mousedown for selection (that was swallowing the drag entirely).
      if (!editing || flowMode) return;
      e.stopPropagation();
      selectedBox = i;
      drawEditorBoxes();
    });
    svg.appendChild(rect);
  });
}

function openEditor() {
  const f = visList[lbIndex];
  if (!f) return;
  editing = true;
  overlayBoxes = boxesForFrame(f);
  selectedBox = -1;
  document.getElementById('editBar').style.display = 'flex';
  const img = document.getElementById('lbImg');
  document.getElementById('lbSvg').style.display = 'block';
  img.onload = drawEditorBoxes;
  img.src = `img?kind=raw&split=${f.split}&name=${encodeURIComponent(f.name)}`;
  drawEditorBoxes();  // in case the src didn't change (already showing raw) and onload won't refire
  updateClsButtons();
}

function closeEditor(restoreView) {
  editing = false;
  selectedBox = -1;
  drawStartPt = null;
  document.getElementById('editBar').style.display = 'none';
  document.getElementById('lbImg').onload = null;
  if (restoreView) renderLightbox();
}

function editorMouseDown(e) {
  // Left button only — a right-click's own tiny mousedown-to-mouseup jitter
  // was registering as a real (if sliver-thin) drag, so a single right-click
  // could both skip via contextmenu AND advance again via mouseup's "box
  // drawn" path, skipping two phases at once instead of one.
  if (!editing || e.button !== 0) return;
  e.preventDefault();
  drawStartPt = svgPointFromEvent(e);
  const cls = flowMode ? (flowPhase === 'violin' ? 1 : 0) : curClass;
  if (flowMode) {
    // Pull out any existing box(es) of this phase's class right away, so the
    // replacement is visible immediately — restored if this turns out to be
    // an accidental too-small click rather than a real drag.
    replacedBoxes = overlayBoxes.filter(b => b.cls === cls);
    overlayBoxes = overlayBoxes.filter(b => b.cls !== cls);
  }
  overlayBoxes.push({ cls, cx: drawStartPt.x, cy: drawStartPt.y, w: 0, h: 0 });
  selectedBox = overlayBoxes.length - 1;
  drawEditorBoxes();
}

function editorContextMenu(e) {
  if (!editing) return;
  e.preventDefault();
  if (flowMode) {
    flowAdvancePhase();  // skip this phase's box entirely, move to the next phase/frame
  } else {
    overlayBoxes = [];
    selectedBox = -1;
    drawEditorBoxes();
  }
}

function editorMouseMove(e) {
  if (!editing || !drawStartPt) return;
  const p = svgPointFromEvent(e);
  const x = Math.min(drawStartPt.x, p.x), y = Math.min(drawStartPt.y, p.y);
  const w = Math.abs(p.x - drawStartPt.x), h = Math.abs(p.y - drawStartPt.y);
  const b = overlayBoxes[overlayBoxes.length - 1];
  b.cx = x + w / 2; b.cy = y + h / 2; b.w = w; b.h = h;
  drawEditorBoxes();
}

function editorMouseUp() {
  if (!editing || !drawStartPt) return;
  drawStartPt = null;
  suppressNextBackdropClick = true;  // this mouseup may land outside the image; don't let it close things
  const newBox = overlayBoxes[overlayBoxes.length - 1];
  const tooSmall = newBox.w < 0.01 || newBox.h < 0.01;
  if (tooSmall) {
    overlayBoxes.pop();  // accidental click — not a real drag; put back what we pulled out for it
    if (replacedBoxes.length) overlayBoxes.push(...replacedBoxes);
    selectedBox = overlayBoxes.length - 1;
  } else {
    selectedBox = overlayBoxes.indexOf(newBox);
  }
  replacedBoxes = [];
  drawEditorBoxes();
  if (flowMode && !tooSmall) flowAdvancePhase();  // this phase's box is drawn — move on
}

// Advances the two-phase state machine for the current flow frame: violin
// phase -> bow phase, or bow phase -> save the frame and move to the next one.
function flowAdvancePhase() {
  if (flowPhase === 'violin') {
    flowPhase = 'bow';
    updateFlowPhaseUI();
  } else {
    flowSaveAndAdvance();
  }
}

function updateFlowPhaseUI() {
  const label = document.getElementById('flowPhaseLabel');
  if (flowPhase === 'violin') {
    label.textContent = 'Draw the VIOLIN box (right-click to skip)';
    label.style.color = CLASS_COLOR[1];
  } else {
    label.textContent = 'Draw the BOW box (right-click to skip)';
    label.style.color = CLASS_COLOR[0];
  }
}

// ── "Fix wrong frames" flow ──────────────────────────────────────
function startFlow() {
  flowQueue = computeWrongQueue();
  if (!flowQueue.length) { alert('No wrong frames to fix — nothing flagged or marked wrong.'); return; }
  flowMode = true;
  flowIndex = 0;
  document.getElementById('lb').classList.add('open');
  document.getElementById('lbPrev').style.display = 'none';
  document.getElementById('lbNext').style.display = 'none';
  document.getElementById('lbCap').style.display = 'none';
  document.getElementById('lbActions').style.display = 'none';
  enterFlowFrame();
}

function enterFlowFrame() {
  // Skip anything that got resolved/excluded since the queue was built.
  while (flowIndex < flowQueue.length) {
    const f = flowQueue[flowIndex];
    if (manualLabels[f.name] || excluded.has(f.name)) { flowIndex++; continue; }
    break;
  }
  if (flowIndex >= flowQueue.length) { endFlow(true); return; }
  renderFlowFrame();
}

function renderFlowFrame() {
  const f = flowQueue[flowIndex];
  editing = true;
  overlayBoxes = boxesForFrame(f);  // show what's already there; skipping a phase keeps it as-is
  flowPhase = 'violin';
  selectedBox = -1;
  document.getElementById('editBar').style.display = 'none';
  document.getElementById('flowBar').style.display = 'flex';
  document.getElementById('flowProgress').textContent = `${flowIndex + 1} / ${flowQueue.length}`;
  document.getElementById('flowName').textContent = f.name;
  updateFlowPhaseUI();
  const backBtn = document.getElementById('flowBackBtn');
  backBtn.disabled = flowIndex === 0;
  backBtn.style.opacity = flowIndex === 0 ? 0.4 : 1;
  const img = document.getElementById('lbImg');
  document.getElementById('lbSvg').style.display = 'block';
  img.onload = drawEditorBoxes;
  img.src = `img?kind=raw&split=${f.split}&name=${encodeURIComponent(f.name)}`;
  drawEditorBoxes();
}

// Revisit the previous frame in the queue (e.g. it just got auto-advanced
// past). Shows its current state — the manual edit if it was just saved,
// otherwise its original boxes — for further correction.
function flowGoBack() {
  if (flowIndex <= 0) return;
  flowIndex--;
  renderFlowFrame();
}

// Clears the auto-flag styling on a single card immediately, without a full
// recompute() (which would re-derive lbIndex against visList — the wrong
// list while the "Fix wrong frames" flow, which navigates via flowQueue
// instead, is driving the lightbox).
function markResolvedCard(f) {
  f.flag1 = f.flag2 = f.flag3 = false;
  f.el.classList.remove('flag1', 'flag2', 'flag3');
  f.badgeEl.textContent = '';
}

// A frame saved with zero boxes at all (both phases skipped, or a manual
// edit that deleted everything) has nothing to train on — drop it from
// training and flag it for a second look, rather than silently keeping an
// unlabeled frame.
function autoExcludeIfEmpty(f, boxes) {
  if (boxes.length > 0) return;
  excluded.add(f.name);
  wrong.add(f.name);
  saveExcluded();
  saveWrong();
  f.el.classList.add('excluded');
}

function flowSaveAndAdvance() {
  const f = flowQueue[flowIndex];
  manualLabels[f.name] = overlayBoxes.map(b => ({ cls: b.cls, cx: b.cx, cy: b.cy, w: b.w, h: b.h }));
  saveManualLabels();
  markResolvedCard(f);
  f.el.classList.add('edited');
  renderCardOverlay(f);
  autoExcludeIfEmpty(f, overlayBoxes);
  flowIndex++;
  enterFlowFrame();
}

function endFlow(completed) {
  flowMode = false;
  editing = false;
  drawStartPt = null;
  selectedBox = -1;
  document.getElementById('flowBar').style.display = 'none';
  document.getElementById('lbPrev').style.display = '';
  document.getElementById('lbNext').style.display = '';
  document.getElementById('lbCap').style.display = '';
  document.getElementById('lbActions').style.display = '';
  document.getElementById('lbImg').onload = null;
  closeLightbox();
  recompute();
  if (completed) alert('All wrong frames fixed!');
}

function openLightbox(f) {
  const i = visList.indexOf(f);
  if (i === -1) return;
  lbIndex = i;
  renderLightbox();
  document.getElementById('lb').classList.add('open');
}

function closeLightbox() {
  lbIndex = -1;
  document.getElementById('lb').classList.remove('open');
}

function lbStep(delta) {
  if (lbIndex === -1 || visList.length === 0) return;
  lbIndex = (lbIndex + delta + visList.length) % visList.length;  // wraps around
  renderLightbox();
}

function renderLightbox() {
  const f = visList[lbIndex];
  if (!f) { closeLightbox(); return; }
  if (editing) closeEditor(false);  // switching frames exits edit mode without saving
  const lb = document.getElementById('lb');
  lb.classList.toggle('flag1', f.flag1);
  lb.classList.toggle('flag2', f.flag2);
  lb.classList.toggle('flag3', f.flag3);
  const img = document.getElementById('lbImg');
  const svg = document.getElementById('lbSvg');
  if (manualLabels[f.name]) {
    overlayBoxes = boxesForFrame(f);
    svg.style.display = 'block';
    img.onload = drawEditorBoxes;
    img.src = `img?kind=raw&split=${f.split}&name=${encodeURIComponent(f.name)}`;
    drawEditorBoxes();
  } else {
    overlayBoxes = null;
    svg.style.display = 'none';
    img.onload = null;
    img.src = f.url;
  }
  const tag = f.flag1 ? ' &nbsp;<b class="f1">FULL-FRAME</b>'
            : f.flag2 ? ` &nbsp;<b class="f2">${f.ratio.toFixed(1)}\\u00d7 violin</b>`
            : f.flag3 ? ' &nbsp;<b class="f3">SINGLE BOX</b>' : '';
  const ratio = f.ratio != null ? ` &nbsp; violin ${f.ratio.toFixed(1)}\\u00d7 group baseline` : '';
  const group = clips[f.clip].nSegs > 1 ? ` &nbsp; group ${f.seg + 1}/${clips[f.clip].nSegs}` : '';
  document.getElementById('lbCap').innerHTML =
    `${lbIndex + 1}/${visList.length} &nbsp; ${f.name} &nbsp; [${f.split}]${group}${ratio}${tag}`;
  const isRef = refs.includes(f.name);
  const btn = document.getElementById('lbRefBtn');
  btn.innerHTML = isRef ? '\\u2605 group reference \\u2014 click to clear'
                        : '\\u2606 set as group reference';
  btn.style.color = isRef ? '#22c55e' : '#e6e6e6';
  const sbtn = document.getElementById('lbSplitBtn');
  const isFirst = clips[f.clip][0] === f;
  sbtn.disabled = isFirst;
  sbtn.style.opacity = isFirst ? 0.4 : 1;
  sbtn.innerHTML = f.splitStart ? '\\u2702 remove group split'
                                : '\\u2702 start new group here';
  sbtn.style.color = f.splitStart ? '#38bdf8' : '#e6e6e6';
  const isExcl = excluded.has(f.name);
  const ebtn = document.getElementById('lbExclBtn');
  ebtn.innerHTML = isExcl ? '\\u2715 excluded \\u2014 click to restore' : '\\u2715 exclude from training';
  ebtn.style.color = isExcl ? '#ef4444' : '#e6e6e6';
  const isWrong = wrong.has(f.name);
  const wbtn = document.getElementById('lbWrongBtn');
  wbtn.innerHTML = isWrong ? '\\u2691 marked wrong \\u2014 click to clear' : '\\u2691 mark wrong';
  wbtn.style.color = isWrong ? '#f59e0b' : '#e6e6e6';
  const edbtn = document.getElementById('lbEditBtn');
  edbtn.innerHTML = manualLabels[f.name] ? '\\u270e edit boxes (manually edited)' : '\\u270e edit boxes';
  edbtn.style.color = manualLabels[f.name] ? '#22c55e' : '#e6e6e6';
  // Preload neighbors so arrow keys feel instant
  for (const d of [-1, 1]) {
    const n = visList[(lbIndex + d + visList.length) % visList.length];
    if (n) new Image().src = n.url;
  }
}

function recompute() {
  const fullT = +document.getElementById('full').value / 100;
  const k = +document.getElementById('ratio').value;
  const useMedian = document.getElementById('baseline').value === 'median';
  const view = document.getElementById('view').value;
  const lbFrame = lbIndex >= 0 ? visList[lbIndex] : null;
  document.getElementById('fullVal').textContent = Math.round(fullT * 100) + '%';
  document.getElementById('ratioVal').textContent = k.toFixed(2) + '\\u00d7';

  // Assign each frame to a group (clip segment). User splits start new groups.
  for (const [clip, list] of Object.entries(clips)) {
    const sp = splits[clip] || new Set();
    let seg = 0;
    list.forEach((f, idx) => {
      f.splitStart = idx > 0 && sp.has(f.name);
      if (f.splitStart) seg++;
      f.seg = seg;
      f.segKey = clip + '#' + seg;
    });
    list.nSegs = seg + 1;
  }

  for (const f of frames)
    f.flag1 = !manualLabels[f.name] &&
      ((f.bow != null && f.bow >= fullT) || (f.violin != null && f.violin >= fullT));

  // Per-GROUP violin baseline. A ★ reference frame in the group always wins;
  // otherwise fall back to smallest/median over the group's frames NOT already
  // flagged as full-frame (a full-frame violin box must not drag the median up)
  // or manually edited/confirmed (its auto-label area is stale once overridden).
  const areasBySeg = {};
  for (const f of frames)
    if (!f.flag1 && !manualLabels[f.name] && f.violin != null) (areasBySeg[f.segKey] ??= []).push(f.violin);
  const base = {};
  for (const [key, areas] of Object.entries(areasBySeg)) {
    areas.sort((a, b) => a - b);
    base[key] = useMedian ? areas[areas.length >> 1] : areas[0];
  }
  for (const n of refs) {
    const rf = byName[n];
    if (rf && rf.violin != null) base[rf.segKey] = rf.violin;
  }

  let c1 = 0, c2 = 0, c3 = 0;
  const clipCounts = {};
  visList = [];
  for (const f of frames) {
    const b = base[f.segKey];
    f.ratio = (f.violin != null && b) ? f.violin / b : null;
    f.flag2 = !manualLabels[f.name] && !f.flag1 && f.ratio != null && f.ratio > k;
    f.flag3 = !manualLabels[f.name] && !f.flag1 && !f.flag2 && (f.boxes || []).length === 1;
    if (f.flag1) c1++;
    if (f.flag2) c2++;
    if (f.flag3) c3++;
    if (f.flag1 || f.flag2 || f.flag3)
      clipCounts[f.clip] = (clipCounts[f.clip] || 0) + 1;

    const vis = isVisible(f, view);
    if (vis) visList.push(f);
    f.el.classList.toggle('flag1', f.flag1);
    f.el.classList.toggle('flag2', f.flag2);
    f.el.classList.toggle('flag3', f.flag3);
    f.el.classList.toggle('ref', refs.includes(f.name));
    f.el.classList.toggle('splitStart', f.splitStart);
    f.el.classList.toggle('excluded', excluded.has(f.name));
    f.el.classList.toggle('edited', !!manualLabels[f.name]);
    f.el.classList.toggle('wrongMark', wrong.has(f.name));
    f.el.classList.toggle('hidden', !vis);
    f.badgeEl.textContent = f.flag1 ? 'FULL-FRAME' : f.flag2 ? f.ratio.toFixed(1) + '\\u00d7' : f.flag3 ? '1 BOX' : '';
    f.ratioEl.textContent = f.ratio != null ? f.ratio.toFixed(1) + '\\u00d7' : '';
  }

  // Keep the lightbox coherent if a filter changed underneath it
  if (lbFrame) {
    const i = visList.indexOf(lbFrame);
    if (i === -1) closeLightbox();
    else { lbIndex = i; renderLightbox(); }
  }
  // Insert/refresh visual group dividers inside each clip grid
  document.querySelectorAll('.divider').forEach(d => d.remove());
  for (const list of Object.values(clips)) {
    for (const f of list) {
      if (f.splitStart) {
        const d = document.createElement('div');
        d.className = 'divider';
        d.textContent = `\\u2702 group ${f.seg + 1}`;
        f.el.parentNode.insertBefore(d, f.el);
      }
    }
  }

  for (const [clip, list] of Object.entries(clips)) {
    const nRefs = refs.filter(n => byName[n] && byName[n].clip === clip).length;
    const refTag = nRefs ? `  \\u2605 ${nRefs} ref${nRefs > 1 ? 's' : ''}` : '';
    const segTag = list.nSegs > 1 ? `, ${list.nSegs} groups` : '';
    list.sumEl.innerHTML = `— ${list.length} frames, ${clipCounts[clip] || 0} flagged${segTag}` +
      (refTag ? `<span class="ref-tag">${refTag}</span>` : '');
  }
  const trainCount = frames.filter(f => !excluded.has(f.name) &&
    (!!manualLabels[f.name] || (!f.flag1 && !f.flag2 && !f.flag3 && !wrong.has(f.name)))).length;
  document.getElementById('counts').innerHTML =
    `${frames.length} frames &nbsp; <b class="f1">${c1} full-frame</b> &nbsp; ` +
    `<b class="f2">${c2} violin-size</b> &nbsp; <b class="f3">${c3} single-box</b> &nbsp; ` +
    `${frames.length - c1 - c2 - c3} kept &nbsp; ` +
    `${excluded.size} excluded &nbsp; ${Object.keys(manualLabels).length} manually edited &nbsp; ` +
    `${wrong.size} marked wrong &nbsp; ` +
    `<b style="color:#22c55e">${trainCount} in training</b>`;
  document.getElementById('wrongCount').textContent = computeWrongQueue().length;
}

async function exportFlagged() {
  const flagged = frames.filter(f => f.flag1 || f.flag2 || f.flag3).map(f => ({
    name: f.name, split: f.split,
    reason: f.flag1 ? 'full_frame' : f.flag2 ? 'violin_size' : 'single_box',
    ratio: f.ratio,
  }));
  const manual_labels = {};
  for (const [name, boxes] of Object.entries(manualLabels)) {
    manual_labels[name] = { split: (byName[name] || {}).split || 'train', boxes };
  }
  const body = {
    thresholds: {
      full_frame_area: +document.getElementById('full').value / 100,
      violin_ratio: +document.getElementById('ratio').value,
      baseline: document.getElementById('baseline').value,
    },
    references: refs,
    splits: Object.fromEntries(
      Object.entries(splits).filter(([, s]) => s.size).map(([c, s]) => [c, [...s]])),
    flagged,
    excluded: [...excluded],
    manual_labels,
  };
  const res = await fetch('export', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  alert(await res.text());
}

init();
</script>
</body></html>
"""

# ── HTTP server ────────────────────────────────────────────────────────────────

def safe_name(name: str) -> bool:
    """Block path traversal; otherwise any filename the dataset produced is fine."""
    return bool(name) and "/" not in name and "\\" not in name and ".." not in name


def make_handler(backends: dict, frames: list[dict], export_path: Path):
    frames_json = json.dumps({"frames": [
        {k: f[k] for k in ("name", "split", "clip", "source", "bow", "violin", "boxes")} for f in frames
    ]}).encode()

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"  # keep-alive: browser reuses a few
                                       # connections instead of opening hundreds

        def log_message(self, *args):  # keep the terminal quiet
            pass

        def _send(self, code: int, body: bytes, ctype: str):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            url = urlparse(self.path)
            if url.path in ("/", "/index.html"):
                self._send(200, INDEX_HTML.encode(), "text/html; charset=utf-8")
            elif url.path == "/data.json":
                self._send(200, frames_json, "application/json")
            elif url.path == "/img":
                q = parse_qs(url.query)
                name = q.get("name", [""])[0]
                split = q.get("split", ["train"])[0]
                kind = q.get("kind", ["ann"])[0]
                source, sep, orig_name = name.partition(":")
                if not sep or not safe_name(orig_name) or split not in ("train", "val"):
                    self._send(400, b"bad request", "text/plain")
                    return
                backend = backends.get(source)
                if backend is None:
                    self._send(404, b"unknown source", "text/plain")
                    return
                data = backend.read_image(orig_name, split, kind)
                if data is None:
                    self._send(404, b"not found", "text/plain")
                else:
                    self._send(200, data, "image/jpeg")
            else:
                self._send(404, b"not found", "text/plain")

        def do_POST(self):
            if urlparse(self.path).path != "/export":
                self._send(404, b"not found", "text/plain")
                return
            length = int(self.headers.get("Content-Length", 0))
            payload = json.loads(self.rfile.read(length))
            export_path.write_text(json.dumps(payload, indent=2))
            n = len(payload.get("flagged", []))
            n_excl = len(payload.get("excluded", []))
            n_manual = len(payload.get("manual_labels", {}))
            self._send(
                200,
                f"Wrote {n} auto-flagged, {n_excl} manually excluded, {n_manual} manually "
                f"re-labeled frame(s) to {export_path}\n\nApply with:\n"
                f"python3 apply_review_overrides.py --dataset dataset_clean "
                f"--review {export_path.name} --source <raw dataset dir or .tar>".encode(),
                "text/plain; charset=utf-8",
            )

    return Handler


def _open_backend(path_str: str):
    ds = Path(path_str)
    if not ds.exists():
        raise SystemExit(f"[ERROR] Not found: {ds}")
    if ds.is_dir():
        return DirBackend(ds), ds / "review_flagged.json"
    print(f"Indexing {ds.name} …")
    return TarBackend(ds), ds.parent / "review_flagged.json"


def main():
    parser = argparse.ArgumentParser(description="Review auto-labeled dataset, tune outlier filters.")
    parser.add_argument("--dataset", default="dataset.tar",
                        help="dataset.tar (uncompressed) or an extracted dataset/ directory")
    parser.add_argument("--prev-dataset",
                        help="Optional second dataset (dir or .tar) shown alongside the first, "
                             "toggleable in the UI (e.g. an older training set for comparison)")
    parser.add_argument("--port", type=int, default=7788)
    args = parser.parse_args()

    backend, export_path = _open_backend(args.dataset)
    print("Reading labels …")
    frames = load_frames(backend, "current")
    backends = {"current": backend}

    if args.prev_dataset:
        prev_backend, _ = _open_backend(args.prev_dataset)
        print("Reading previous dataset's labels …")
        frames += load_frames(prev_backend, "previous")
        backends["previous"] = prev_backend

    if not frames:
        raise SystemExit("[ERROR] No labeled frames found in the dataset.")
    n_clips = len({f['clip'] for f in frames})
    print(f"{len(frames)} labeled frame(s) across {n_clips} clip(s)")

    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(backends, frames, export_path))
    print(f"\nOpen http://localhost:{args.port}\nCtrl-C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
