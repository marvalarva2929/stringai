# Bow Keypoint Model

## What the model outputs

Three keypoints per frame:

| Keypoint | Description |
|---|---|
| **0 — Tip** | The very end of the bow head (the thin end, away from the player's hand) |
| **1 — Frog** | The heel of the frog, where the player's thumb contacts the stick |
| **2 — Contact** | The point where the bow hair crosses the string (the "sounding point") |

The contact point is the key innovation. With tip, frog, and contact known, the bow usage metric falls out from a simple vector projection — no camera calibration needed:

```
t = dot(contact − frog, tip − frog) / |tip − frog|²
```

`t ∈ [0, 1]` where 0 = playing at the frog and 1 = playing at the tip.

---

## Architecture

**Base model:** YOLOv8n-pose  
**Keypoints:** 3 (tip, frog, contact)  
**Input:** 640×640 letterboxed RGB  
**Output:** bounding box + 3 keypoints, each with (x, y, visibility)

---

## Data collection

### What to record

Collect short clips (10–30 seconds) of a violinist playing. Aim for:

- All bow zones: frog, lower half, middle, upper half, tip
- Slow bows (whole notes) and fast détaché / spiccato
- Both G-string (elbow high) and E-string (elbow low) positions
- Multiple lighting conditions and backgrounds
- At least 3 players if possible

Target: **~3,000 labeled frames** after deduplication (more is better — budget an afternoon per player).

### Frame extraction

```bash
cd ml/
python extract_frames.py --input videos/ --output data/raw_frames/ --fps 10
```

Use the existing `ml/extract_frames.py` script. It deduplicates near-static frames (slow passages produce many duplicates). Keep ~60–70% of extracted frames.

---

## Labeling

Upload filtered frames to **Roboflow**. Create a project with:
- **Task:** Object Detection + Keypoints
- **Class:** `bow`
- **Keypoint count:** 3

### Keypoint definitions

**Keypoint 0 — Tip:**  
The pointed end of the bow head. The stick tapers to a near-point here. Label the very tip of the wood.

**Keypoint 1 — Frog:**  
The heel of the frog on the underside of the stick — where the player's thumb sits. Do NOT label the end button (the decorative knob at the very end of the stick). Label the inside corner of the frog nearest the hair.

**Keypoint 2 — Contact:**  
The point where the bow hair ribbon crosses the string. Visually this is where the bow hair appears to "land" on the violin — look for the slight flattening of the hair ribbon against the string. On a front-facing camera this appears as the intersection of the ribbon with the thin string line across the violin body.

If the contact point is occluded (e.g., player's body is in the way), mark visibility = 0. This is common in lower-string playing.

### Visibility flags

| Value | Meaning |
|---|---|
| 0 | Not visible (out of frame or occluded) |
| 1 | Estimated (partially obscured but position can be inferred) |
| 2 | Fully visible and precisely labeled |

### Occlusion rules

- If a keypoint is outside the frame: visibility = 0
- If the bow is entirely absent: skip the frame entirely
- If only one end is visible, label what you can, mark the other visibility = 0
- If the contact point is obscured but the stick position makes it inferable, use visibility = 1

### Frog off-camera (common — do NOT skip these frames)

The frog frequently goes below the camera frame, especially during down-bow passages and when the player films from in front. **These frames are valid training data — label them, don't skip them.**

- Label tip and contact point normally (they are still visible)
- Set frog x/y to `(0, 0)` and visibility = 0
- The model learns to output `frogVisible: false` for these frames, which is the correct signal

The JavaScript layer (`bowAnalysis.ts: deriveBowTimeSeries`) has a fallback formula that estimates the contact point from tip + contact alone using the last-known bow angle and length. This fallback only activates when the model correctly reports `frogVisible: false`, so properly labeled frog-off-camera frames are critical for accurate runtime behavior.

---

## Dataset config

**File: `ml/data.yaml`**

```yaml
path: data
train: images/train
val:   images/val
nc: 1
names: ['bow']
kpt_shape: [3, 3]      # 3 keypoints × (x, y, visibility)
flip_idx: [1, 0, 2]    # when image is flipped: swap tip↔frog, contact stays
```

`flip_idx` tells YOLOv8 how to remap keypoints when horizontal-flip augmentation is applied. Tip and frog swap (they're at opposite ends), but the contact point stays — it's still the contact point regardless of orientation.

---

## Training

**File: `ml/train.py`**

```python
from ultralytics import YOLO

model = YOLO('yolov8n-pose.pt')
results = model.train(
    data='data.yaml',
    epochs=150,
    imgsz=640,
    batch=16,
    optimizer='AdamW',
    lr0=0.001,
    augment=True,
    fliplr=0.5,
    degrees=10,      # bow angles vary; small rotation is valid
    hsv_v=0.4,       # brightness variation for lighting
    project='runs/bow',
    name='train',
)
```

Install: `pip install ultralytics opencv-python`

---

## Export to CoreML

```python
from ultralytics import YOLO

model = YOLO('runs/bow/train/weights/best.pt')
model.export(
    format='coreml',
    imgsz=640,
    nms=True,    # bake NMS into the model
    int8=True,   # ~2 MB quantized
)
# Output: runs/bow/train/weights/best.mlpackage
```

Copy to: `modules/pose-camera/ios/bow_detector.mlpackage`

---

## Evaluation targets

Run `ml/evaluate.py` after training. Targets before shipping:

| Metric | Target |
|---|---|
| OKS (all keypoints) | > 0.82 |
| OKS (contact point only) | > 0.75 |
| Tip OKS | > 0.90 |
| Frog OKS | > 0.88 |

The contact point is the hardest keypoint — the bow hair is translucent and the string is thin. Expect it to be the weakest of the three. OKS > 0.75 on the contact point is sufficient for the 0–1 bow usage metric to be useful in practice, since errors in the contact point position produce proportional errors in `t` that are smoothed out over time.

Check per-zone breakdowns: contact point accuracy is typically lowest at the frog (bow hair is compressed and the exact contact is harder to see) and highest in the middle of the bow.

---

## Swift integration

Once the model is trained and exported, integrate it in `modules/pose-camera/ios/BowDetector.swift`. The Swift side runs the model per frame and populates `bowTip`, `bowFrog`, and `bowContact` keys in the frame dict returned by `analyzeVideoFrames`. The JS side parses these into `RawBowFrame` (see `src/types/signals.ts`).

The `contactVisible` field on `RawBowFrame` maps to the model's keypoint visibility score — use `visibility >= 1` as the threshold (both estimated and fully visible are usable).

---

## Notes on the contact point

The contact point is a learned visual feature, not a geometric computation. The model learns:
- Where the bow hair ribbon visually meets the string
- How the hair flattens slightly at the contact zone
- The spatial relationship between the bow stick and violin body at different contact locations

This is reliable because violin strings are visually distinct (thin bright line across a dark body) and the bow hair ribbon is wide enough to show clear contact with the string. The main failure modes are:
- Bow pointing directly at the camera (foreshortened — all three keypoints become ambiguous)
- Heavy motion blur on fast détaché passages
- Dark lighting where the string isn't visible

Label ~200 frames from each failure mode to improve robustness.
