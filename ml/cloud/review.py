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

Nothing is deleted. The Export button writes review_flagged.json next to the
dataset — feed that to a cleanup step later.

Usage:
    cd ml/cloud
    python3 review.py --dataset dataset.tar          # or an extracted dataset/ dir
    → open http://localhost:7788
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


def load_frames(backend) -> list[dict]:
    frames = []
    for name, split, text in backend.label_files():
        bow = violin = None
        for line in text.splitlines():
            parts = line.split()
            if len(parts) != 5:
                continue
            cls = int(parts[0])
            w, h = float(parts[3]), float(parts[4])
            area = w * h
            if cls == 0:
                bow = max(bow or 0, area)
            elif cls == 1:
                violin = max(violin or 0, area)
        frames.append({
            "name": name, "split": split, "clip": clip_of(name),
            "bow": bow, "violin": violin,
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
  #counts b.f1 { color: #ef4444; }  #counts b.f2 { color: #f59e0b; }
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
  .card img { width: 100%; height: 120px; object-fit: cover; display: block; }
  .card .cap { padding: 2px 6px; font-size: 11px; color: #9aa3ad;
               display: flex; justify-content: space-between; }
  .card.flag1 { border-color: #ef4444; }
  .card.flag2 { border-color: #f59e0b; }
  .card .star { position: absolute; top: 2px; right: 4px; font-size: 18px;
                cursor: pointer; color: #6b7280; opacity: 0; z-index: 2;
                text-shadow: 0 0 4px #000; user-select: none; }
  .card:hover .star { opacity: 1; }
  .card.ref .star { opacity: 1; color: #22c55e; }
  .card.ref:not(.flag1):not(.flag2) { border-color: #22c55e; }
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
  .card.hidden { display: none; }
  #lb { position: fixed; inset: 0; z-index: 100; background: rgba(5,6,8,.94);
        display: none; align-items: center; justify-content: center; gap: 12px; }
  #lb.open { display: flex; }
  #lb img { max-width: 84vw; max-height: 84vh; object-fit: contain;
            border-radius: 6px; border: 3px solid #2c3138; }
  #lb.flag1 img { border-color: #ef4444; }
  #lb.flag2 img { border-color: #f59e0b; }
  #lbMain { display: flex; flex-direction: column; align-items: center; gap: 8px; }
  #lbCap { font-variant-numeric: tabular-nums; color: #cdd3da; }
  #lbCap b.f1 { color: #ef4444; } #lbCap b.f2 { color: #f59e0b; }
  .lbBtn { background: #1a1d21; color: #e6e6e6; border: 1px solid #2c3138;
           border-radius: 8px; font-size: 26px; padding: 14px 18px; cursor: pointer; }
  .lbBtn:hover { background: #2c3138; }
  #lbClose { position: absolute; top: 14px; right: 16px; font-size: 18px; }
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
    <option value="clean">unflagged only</option>
  </select></label>
  <button id="collapse">Collapse all</button>
  <span id="counts"></span>
  <button id="export">Export flagged list</button>
</div>
<div id="groups"></div>
<div id="lb">
  <button class="lbBtn" id="lbPrev">&#8592;</button>
  <div id="lbMain"><img id="lbImg"><div id="lbCap"></div>
    <div style="display:flex;gap:10px">
      <button class="lbBtn" id="lbRefBtn" style="font-size:14px">&#9733; set as group reference</button>
      <button class="lbBtn" id="lbSplitBtn" style="font-size:14px">&#9986; start new group here</button>
    </div></div>
  <button class="lbBtn" id="lbNext">&#8594;</button>
  <button class="lbBtn" id="lbClose">&#10005;</button>
</div>
<script>
let frames = [], clips = {}, byName = {};

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

function saveRefs() { localStorage.setItem('bowReviewRefs', JSON.stringify(refs)); }
function saveSplits() {
  const o = {};
  for (const [c, s] of Object.entries(splits)) if (s.size) o[c] = [...s];
  localStorage.setItem('bowReviewSplits', JSON.stringify(o));
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

async function init() {
  frames = (await (await fetch('data.json')).json()).frames;
  for (const f of frames) { (clips[f.clip] ??= []).push(f); byName[f.name] = f; }
  // Drop stale entries pointing at frames that no longer exist
  refs = refs.filter(n => byName[n]);

  const groupsEl = document.getElementById('groups');
  for (const [clip, list] of Object.entries(clips)) {
    const det = document.createElement('details');
    det.open = true;
    const sum = document.createElement('summary');
    sum.innerHTML = `${clip} <span class="cnt"></span>`;
    det.appendChild(sum);
    const grid = document.createElement('div');
    grid.className = 'grid';
    for (const f of list) {
      const card = document.createElement('div');
      card.className = 'card';
      f.url = `img?kind=ann&split=${f.split}&name=${encodeURIComponent(f.name)}`;
      card.innerHTML =
        `<img loading="lazy" src="${f.url}" style="cursor:zoom-in">` +
        `<span class="badge"></span>` +
        `<span class="star" title="Set as this group's reference (violin-size filter compares against it)">\\u2605</span>` +
        `<span class="scis" title="Start a new group at this image (angle change)">\\u2702</span>` +
        `<div class="cap"><span>${f.name.slice(clip.length + 1)}</span><span class="r"></span></div>`;
      card.querySelector('img').addEventListener('click', () => openLightbox(f));
      card.querySelector('.star').addEventListener('click', () => toggleRef(f));
      card.querySelector('.scis').addEventListener('click', () => toggleSplit(f));
      f.el = card;
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
  document.getElementById('export').addEventListener('click', exportFlagged);
  document.getElementById('collapse').addEventListener('click', () => {
    const all = [...document.querySelectorAll('#groups details')];
    const anyOpen = all.some(d => d.open);
    for (const d of all) d.open = !anyOpen;
    document.getElementById('collapse').textContent = anyOpen ? 'Expand all' : 'Collapse all';
  });
  document.getElementById('lbPrev').addEventListener('click', () => lbStep(-1));
  document.getElementById('lbNext').addEventListener('click', () => lbStep(1));
  document.getElementById('lbClose').addEventListener('click', closeLightbox);
  document.getElementById('lbRefBtn').addEventListener('click', () => {
    if (lbIndex >= 0 && visList[lbIndex]) toggleRef(visList[lbIndex]);
  });
  document.getElementById('lbSplitBtn').addEventListener('click', () => {
    if (lbIndex >= 0 && visList[lbIndex]) toggleSplit(visList[lbIndex]);
  });
  document.getElementById('lb').addEventListener('click', (e) => {
    if (e.target.id === 'lb') closeLightbox();  // click on the backdrop closes
  });
  document.addEventListener('keydown', (e) => {
    if (!document.getElementById('lb').classList.contains('open')) return;
    if (e.key === 'ArrowLeft') lbStep(-1);
    else if (e.key === 'ArrowRight') lbStep(1);
    else if (e.key === 'Escape') closeLightbox();
  });
  recompute();
}

function isVisible(f, view) {
  if (view === 'flagged') return f.flag1 || f.flag2;
  if (view === 'flag1') return f.flag1;
  if (view === 'flag2') return f.flag2;
  if (view === 'clean') return !f.flag1 && !f.flag2;
  return true;
}

// ── Lightbox (focus mode) ──────────────────────────────────────
let visList = [];   // frames matching the current view, in display order
let lbIndex = -1;   // index into visList, -1 = closed

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
  const lb = document.getElementById('lb');
  lb.classList.toggle('flag1', f.flag1);
  lb.classList.toggle('flag2', f.flag2);
  document.getElementById('lbImg').src = f.url;
  const tag = f.flag1 ? ' &nbsp;<b class="f1">FULL-FRAME</b>'
            : f.flag2 ? ` &nbsp;<b class="f2">${f.ratio.toFixed(1)}\\u00d7 violin</b>` : '';
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
    f.flag1 = (f.bow != null && f.bow >= fullT) || (f.violin != null && f.violin >= fullT);

  // Per-GROUP violin baseline. A ★ reference frame in the group always wins;
  // otherwise fall back to smallest/median over the group's frames NOT already
  // flagged as full-frame (a full-frame violin box must not drag the median up).
  const areasBySeg = {};
  for (const f of frames)
    if (!f.flag1 && f.violin != null) (areasBySeg[f.segKey] ??= []).push(f.violin);
  const base = {};
  for (const [key, areas] of Object.entries(areasBySeg)) {
    areas.sort((a, b) => a - b);
    base[key] = useMedian ? areas[areas.length >> 1] : areas[0];
  }
  for (const n of refs) {
    const rf = byName[n];
    if (rf && rf.violin != null) base[rf.segKey] = rf.violin;
  }

  let c1 = 0, c2 = 0;
  const clipCounts = {};
  visList = [];
  for (const f of frames) {
    const b = base[f.segKey];
    f.ratio = (f.violin != null && b) ? f.violin / b : null;
    f.flag2 = !f.flag1 && f.ratio != null && f.ratio > k;
    if (f.flag1) c1++;
    if (f.flag2) c2++;
    if (f.flag1 || f.flag2)
      clipCounts[f.clip] = (clipCounts[f.clip] || 0) + 1;

    const vis = isVisible(f, view);
    if (vis) visList.push(f);
    f.el.classList.toggle('flag1', f.flag1);
    f.el.classList.toggle('flag2', f.flag2);
    f.el.classList.toggle('ref', refs.includes(f.name));
    f.el.classList.toggle('splitStart', f.splitStart);
    f.el.classList.toggle('hidden', !vis);
    f.badgeEl.textContent = f.flag1 ? 'FULL-FRAME' : f.flag2 ? f.ratio.toFixed(1) + '\\u00d7' : '';
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
  document.getElementById('counts').innerHTML =
    `${frames.length} frames &nbsp; <b class="f1">${c1} full-frame</b> &nbsp; ` +
    `<b class="f2">${c2} violin-size</b> &nbsp; ${frames.length - c1 - c2} kept`;
}

async function exportFlagged() {
  const flagged = frames.filter(f => f.flag1 || f.flag2).map(f => ({
    name: f.name, split: f.split,
    reason: f.flag1 ? 'full_frame' : 'violin_size',
    ratio: f.ratio,
  }));
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


def make_handler(backend, frames: list[dict], export_path: Path):
    frames_json = json.dumps({"frames": [
        {k: f[k] for k in ("name", "split", "clip", "bow", "violin")} for f in frames
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
                if not safe_name(name) or split not in ("train", "val"):
                    self._send(400, b"bad request", "text/plain")
                    return
                data = backend.read_image(name, split, kind)
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
            self._send(200, f"Wrote {n} flagged frame(s) to {export_path}".encode(),
                       "text/plain; charset=utf-8")

    return Handler


def main():
    parser = argparse.ArgumentParser(description="Review auto-labeled dataset, tune outlier filters.")
    parser.add_argument("--dataset", default="dataset.tar",
                        help="dataset.tar (uncompressed) or an extracted dataset/ directory")
    parser.add_argument("--port", type=int, default=7788)
    args = parser.parse_args()

    ds = Path(args.dataset)
    if not ds.exists():
        raise SystemExit(f"[ERROR] Not found: {ds}")

    if ds.is_dir():
        backend = DirBackend(ds)
        export_path = ds / "review_flagged.json"
    else:
        print(f"Indexing {ds.name} …")
        backend = TarBackend(ds)
        export_path = ds.parent / "review_flagged.json"

    print("Reading labels …")
    frames = load_frames(backend)
    if not frames:
        raise SystemExit("[ERROR] No labeled frames found in the dataset.")
    n_clips = len({f['clip'] for f in frames})
    print(f"{len(frames)} labeled frame(s) across {n_clips} clip(s)")

    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(backend, frames, export_path))
    print(f"\nOpen http://localhost:{args.port}\nCtrl-C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
