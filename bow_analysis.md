# Bow Analysis Pipeline

## Goal

Replace the four `unavailableMetric()` stubs in `poseScoring.ts` (bowPlacement, bowAngle, bowArmLevel, bowDistribution) with real metrics derived from a lightweight on-device ML model that tracks the bow tip and frog positions in each video frame.

The pipeline also introduces `SessionSignals` — a time-series data contract that stores all signals (audio, pose, bow) at their native resolution instead of forcing everything into per-note fields. Statistical tests query this store directly.

---

## Architecture

```
Pre-recording calibration (3 tap-to-capture poses)
       │
       │  BowCalibration
       ▼
Raw video (mp4/mov)
       │
       ▼
┌──────────────────────┐
│  analyzeVideoFrames  │  Swift (PoseCameraModule)
│  10 fps, Vision pose │  EXTENDED: also runs CoreML bow detector
│  + bow CoreML model  │  per frame
└──────────────────────┘
       │
       │  RawPoseFrame[] + RawBowFrame[]  (from native → JS bridge)
       ▼
┌──────────────────────┐
│  buildSessionSignals │  src/lib/sessionSignals.ts  (NEW)
│                      │  Audio + pose + bow + calibration → SessionSignals
└──────────────────────┘
       │
       │  SessionSignals
       ▼
┌──────────────────────────────────────────────────────┐
│  Scoring + Pattern Detection                         │
│  poseScoring.ts (bow metrics)                        │
│  patternDetection.ts  (NEW — statistical tests)      │
└──────────────────────────────────────────────────────┘
       │
       ▼
  MetricScore[]  +  StatisticalFinding[]
```

---

## No Calibration

The model outputs three keypoints — tip, frog, and the string contact point — directly in frame coordinates. No per-session camera calibration is needed. The bow usage metric (0=frog, 1=tip) is computed by projecting the contact point onto the frog→tip line:

```typescript
t = dot(contact − frog, tip − frog) / |tip − frog|²
```

This is robust across all camera angles and positions.

**Bow zone (bridge vs. fingerboard) is a future feature.** Detecting bridge vs. fingerboard position from the camera requires knowing the camera's relationship to the violin body, which varies per session. For MVP, only the frog→tip contact point is tracked.

---

## Data Model

### `TimeSeries<T>` — `src/types/signals.ts` (NEW)

The core abstraction. Each signal is stored at its native sampling rate; no upsampling or downsampling to note boundaries.

```typescript
interface TimeSeriesPoint<T> {
  t: number;   // seconds
  v: T;
}

interface TimeSeries<T> {
  points: TimeSeriesPoint<T>[];
  // Nearest-neighbor lookup; returns null if no point within maxGapSeconds
  sample(t: number, maxGapSeconds?: number): T | null;
  // All points in [t0, t1]
  window(t0: number, t1: number): TimeSeriesPoint<T>[];
}
```

### `SessionSignals` — `src/types/signals.ts`

```typescript
interface SessionSignals {
  durationSeconds: number;

  // ── Dense audio (~50 Hz, 20ms hop) ──────────────────────────
  pitch:            TimeSeries<number | null>;   // Hz; null = unvoiced
  rms:              TimeSeries<number>;           // 0-1
  fundamentalRatio: TimeSeries<number>;           // 0-1 (tone quality proxy)

  // ── Sparse pose (10 fps from analyzeVideoFrames) ────────────
  leftWristAngle:   TimeSeries<number | null>;   // degrees, violin arm wrist
  rightElbowY:      TimeSeries<number | null>;   // normalized y, bow arm
  shoulderDiff:     TimeSeries<number | null>;   // |leftShoulder.y - rightShoulder.y|

  // ── Sparse bow (10 fps, high-confidence frames only) ────────
  bowContactPoint:  TimeSeries<number | null>;   // 0=frog … 1=tip (projection formula)
  bowAngle:         TimeSeries<number | null>;   // degrees from horizontal
  bowSpeed:         TimeSeries<number | null>;   // normalized tip pixels/sec (frame width = 1)

  // ── Segmentation index (derived from audio) ─────────────────
  noteEvents: NoteEvent[];
}
```

### `RawBowFrame` — `src/types/signals.ts`

Three keypoints: tip, frog, and the string contact point. All coordinates normalized 0-1 in the original video frame.

```typescript
interface RawBowFrame {
  timestamp: number;
  tipX: number;     tipY: number;     tipVisible: boolean;
  frogX: number;    frogY: number;    frogVisible: boolean;
  contactX: number; contactY: number; contactVisible: boolean;
  confidence: number;
}
```

---

## Phase 1 — Data Pipeline (offline, Python)

**Directory:** `ml/` (lives outside the app — not bundled)

### 1a. Frame Extraction — `ml/extract_frames.py`

Pulls frames from violin recording videos at 10 fps, drops near-duplicate frames, outputs JPEGs and a manifest.

```
Input:  directory of video files (MOV/MP4)
Output: ml/data/raw_frames/<video_id>/<frame_id>.jpg
        ml/data/manifest.csv  (frame_id, source_video, timestamp_ms, kept)
```

Near-duplicate detection: compute mean absolute difference between consecutive frame thumbnails (64×64 grayscale). Drop if diff < threshold (tunable). Target: keep ~60-70% of extracted frames — fast passages look different frame-to-frame; slow passages repeat.

**Libraries:** OpenCV (`pip install opencv-python`)

### 1b. Labeling

Upload filtered frames to **Roboflow**. Label each frame with:

- **Class:** `bow`
- **Bounding box:** tight rectangle around the bow stick (not the hair ribbon)
- **Keypoint 0 — TIP:** the very tip of the bow head (end away from the player's hand)
- **Keypoint 1 — FROG:** the heel of the frog, where the thumb contacts the stick (not the very end of the stick)
- **Occlusion rules:**
  - If a keypoint is outside the frame: mark visibility = 0 (not visible)
  - If a keypoint is occluded by the player's body: mark visibility = 0
  - If the bow is entirely absent from the frame: skip the frame entirely (don't label)
  - If only one end is visible: label the visible end, mark the other invisible

**Target dataset size:** ~2,500 labeled frames covering:
- All bow zones: frog, lower-half, middle, upper-half, tip
- Both slow bows (whole notes) and fast détaché / spiccato
- G-string (elbow high) and E-string (elbow low) bow heights
- Different backgrounds and lighting conditions
- At least 3 different players if possible

**Export format:** YOLOv8 Pose (creates `images/train/`, `images/val/`, `labels/train/`, `labels/val/`, `data.yaml`)

Label format in each `.txt` file (one row per detection):
```
<class> <x_center> <y_center> <w> <h>  <tip_x> <tip_y> <tip_v>  <frog_x> <frog_y> <frog_v>
```
All values normalized 0-1. `_v` is visibility: 0=not visible, 1=visible, 2=visible+labeled.

### 1c. Dataset Config — `ml/data.yaml`

```yaml
path: data
train: images/train
val:   images/val
nc: 1
names: ['bow']
kpt_shape: [2, 3]   # 2 keypoints, 3 values each (x, y, visibility)
```

---

## Phase 2 — Model Training

**Files:** `ml/train.py`, `ml/evaluate.py`

### Model choice: YOLOv8n-pose

- ~3M parameters, ~3.5 MB INT8-quantized
- Keypoint detection variant — detects bounding box + 2 keypoints in one pass
- Exports to CoreML (`.mlpackage`) natively via Ultralytics
- Well-established ecosystem, good documentation

### Training — `ml/train.py`

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
    augment=True,       # mosaic, flip, brightness, blur built in
    fliplr=0.5,         # horizontal flip — swap tip/frog keypoint labels
    degrees=10,         # small rotation (bow angle variation)
    hsv_v=0.4,          # brightness augmentation for lighting variety
    project='runs/bow',
    name='train',
)
```

**Note on `fliplr`:** YOLOv8 automatically swaps keypoint order for flipped images only if `flip_idx` is set in `data.yaml`. Since tip and frog are physically different (tip is lighter, frog has a distinctive shape), horizontal flip is valid augmentation but only helps with left/right framing variation — the detector should still learn which end is which from visual features, not just position.

```yaml
# add to data.yaml:
flip_idx: [1, 0]   # when image is flipped, swap tip↔frog
```

### Export — CoreML

```python
# After training:
model = YOLO('runs/bow/train/weights/best.pt')
model.export(
    format='coreml',
    imgsz=640,
    nms=True,      # bakes NMS into the model — simplifies Swift post-processing
    int8=True,     # INT8 quantization: ~3.5 MB → ~2 MB
)
# Output: runs/bow/train/weights/best.mlpackage
```

With `nms=True`, the CoreML model's output dict contains already-filtered detections (no manual NMS needed in Swift). Target output shape: `[N_detections, 11]` per image where each row is `[x, y, w, h, conf, tip_x, tip_y, tip_v, frog_x, frog_y, frog_v]`.

**Copy output to:** `modules/pose-camera/ios/bow_detector.mlpackage`

### Evaluation — `ml/evaluate.py`

Primary metric: **OKS** (Object Keypoint Similarity). Target: OKS > 0.85 on validation set before shipping.

Also check:
- Per-zone OKS: frog-area, middle, tip-area (harder near the tip because it's thinner)
- Confusion with other elongated objects (music stand, bow case edges)
- Failure cases: bow fully hidden behind body, bow pointing at camera (foreshortened)

---

## Phase 3 — On-Device Inference (Swift)

**Files modified:** `modules/pose-camera/ios/PoseCameraModule.swift`  
**New file:** `modules/pose-camera/ios/BowDetector.swift`

### 3a. `BowDetector.swift`

Loads the CoreML model, runs inference on a single `CGImage`, returns a `BowDetection` if confidence ≥ threshold.

```swift
struct BowDetection {
    let tipX: Float;    let tipY: Float;    let tipVisible: Bool
    let frogX: Float;   let frogY: Float;   let frogVisible: Bool
    let confidence: Float
}

class BowDetector {
    private let model: VNCoreMLModel
    static let shared = BowDetector()

    init?() {
        guard let url = Bundle.main.url(forResource: "bow_detector", withExtension: "mlmodelc"),
              let mlModel = try? MLModel(contentsOf: url),
              let vnModel = try? VNCoreMLModel(for: mlModel)
        else { return nil }
        self.model = vnModel
    }

    func detect(in image: CGImage) -> BowDetection? { ... }
}
```

Input preprocessing: resize `CGImage` to 640×640 (letter-boxed, not stretched) before passing to the model. The keypoint coordinates returned by the model are in the 640×640 input space — rescale back to the original frame's normalized coordinates.

### 3b. Extend `analyzeVideoFrames` in `PoseCameraModule.swift`

The existing function already samples at 10fps, runs Vision pose + hands, and returns frame dicts. Extend it to also run the bow detector on each frame and append bow fields to the same dict.

```swift
// Inside the frame loop, after Vision inference:
if let detector = BowDetector.shared,
   let detection = detector.detect(in: image),
   detection.confidence >= 0.4 {
    payload["bowTip"]        = ["x": detection.tipX,     "y": detection.tipY,     "visible": detection.tipVisible]
    payload["bowFrog"]       = ["x": detection.frogX,    "y": detection.frogY,    "visible": detection.frogVisible]
    payload["bowContact"]    = ["x": detection.contactX, "y": detection.contactY, "visible": detection.contactVisible]
    payload["bowConfidence"] = detection.confidence
}
```

Frames where the bow is not detected or confidence < 0.4 simply omit the bow keys — the JS side treats absent keys as null/unavailable for that frame.

### 3c. Live recording (future — Phase 10)

The `processFrame` method in `PoseCameraView.swift` already runs at 15fps. Once the post-processing bow detector is validated, add it to `processFrame` at reduced rate (every 3rd frame = 5fps) for real-time bow zone feedback. This is Phase 10 work — don't add it now.

---

## Phase 4 — Bow Signal Processing

**File:** `src/lib/bowAnalysis.ts`

Converts `RawBowFrame[]` into typed bow time series. No calibration needed.

### `bowContactPoint` derivation

Projects the model-detected contact point onto the frog→tip bow stick line:

```typescript
function computeContactPoint(tip: Point, frog: Point, contact: Point): number | null {
  const dx = tip.x - frog.x;
  const dy = tip.y - frog.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 0.0001) return null;   // tip and frog overlap — degenerate frame
  const t = ((contact.x - frog.x) * dx + (contact.y - frog.y) * dy) / len2;
  return Math.max(0, Math.min(1, t));
}
```

Requires all three keypoints visible. Frames where `contactVisible = false` produce a null contact point for that timestamp.

### `deriveBowTimeSeries(frames: RawBowFrame[]): BowTimeSeries`

Returns `bowContactPoint`, `bowAngle`, `bowSpeed` time series. Filter steps:
1. Drop frames where `confidence < 0.4`
2. Drop frames where both tip and frog are invisible
3. Spike rejection: drop a frame whose `tip.y` differs from both neighbors by > 0.15 while the neighbors agree within 0.08 (single-frame detection glitch)

---

## Phase 5 — Signal Assembly

**New file:** `src/lib/sessionSignals.ts`

### `buildSessionSignals`

```typescript
function buildSessionSignals(
  audioOutput:     AudioAnalysisOutput,
  poseFrames:      FrameKeypoints[],
  bowFrames:       RawBowFrame[],
  noteEvents:      NoteEvent[],
  durationSeconds: number,
): SessionSignals
```

Steps:
1. Build audio time series from `audioOutput.rawSignals`
2. Build pose time series: `leftWristAngle`, `rightElbowY`, `shoulderDiff` from `FrameKeypoints[]`
3. Call `deriveBowTimeSeries(bowFrames)` — no calibration param needed
4. Assemble into `SessionSignals`
6. Assemble into `SessionSignals`

### `NoteEvent` stays lean

No bow or pose fields on `NoteEvent`. The current schema (audio fields only: `startSeconds`, `endSeconds`, `noteName`, `pitchHz`, `centsDeviation`, `inTune`, `midiNote`, `string`, `inferredFinger`) is sufficient. Statistical tests query `SessionSignals.bowContactPoint.sample(note.midpoint)` directly.

### Update `AnalysisResult` — `src/types/analysis.ts`

```typescript
interface AnalysisResult {
  // ... existing fields ...
  sessionSignals?: SessionSignals;  // ADD: full time-series store
}
```

`sessionSignals` is not persisted in Zustand (too large, not needed for replay). It lives in `sessionResultCache` (in-memory). Supabase will eventually serialize the time series to `session_signals` table (future).

---

## Phase 6 — Bow Scoring (replace stubs)

**Modified files:** `src/lib/poseScoring.ts`, `src/services/videoAnalysis.ts`

### Signature change

The four bow scoring functions currently take `FrameKeypoints[]`. Change them to take `SessionSignals`:

```typescript
// Before:
function scoreBowPlacement(_frames: FrameKeypoints[]): MetricScore

// After:
function scoreBowPlacement(signals: SessionSignals): MetricScore
```

`scorePoseMetrics` signature becomes:
```typescript
function scorePoseMetrics(signals: SessionSignals, instrument: InstrumentId): MetricScore[]
```

`scoreLeftHandWrist` and `scorePosture` also migrate to consume `signals.leftWristAngle` and `signals.shoulderDiff` time series instead of iterating `FrameKeypoints[]` directly.

### New bow scoring implementations

**`scoreBowPlacement`** — fraction of frames in each zone:
- Excellent (≥90): ≥70% of frames in normal zone
- Good (70-89): 50-70% normal
- Needs attention: > 20% sul tasto
- Critical: > 40% sul tasto or > 30% sul ponticello

**`scoreBowAngle`** — how often angle deviates > ±15° from ideal:
- Uses `bowAngle` time series
- Counts contiguous violation runs (≥ 3 consecutive frames = confirmed event)
- Score = fraction of good frames × 100

**`scoreBowDistribution`** — range of `bowContactPoint` used:
- Range < 0.3: critical (using only 30% of bow)
- Range 0.3–0.5: needs attention
- Range 0.5–0.7: good
- Range ≥ 0.7: excellent

**`scoreBowArmLevel`** — uses `rightElbowY` time series correlated with string being played (derived from pitch):
- For each note, expected elbow height range varies by string (G high, E low)
- Replaces the old "elbow variance" proxy (which was backwards for single-string passages)

---

## Phase 7 — Pattern Detection

**New file:** `src/lib/patternDetection.ts`

Takes `SessionSignals` + `NoteEvent[]`. Runs pre-specified statistical tests. Returns `StatisticalFinding[]`.

See `architecture.md` for the full test spec. Bow-relevant tests enabled by this pipeline:

| Test ID | Signals used |
|---|---|
| `upper_bow_tone_degradation` | `bowContactPoint` × `fundamentalRatio` per note |
| `tip_dynamic_ceiling` | `bowContactPoint` × `rms` in crescendo windows |
| `sul_tasto_drift` | `bowZone` histogram |
| `bow_distribution_narrow` | `bowContactPoint` range |
| `phrase_end_pressure` | `fundamentalRatio` × phrasePosition (from note timing) |

Audio-only tests that don't need bow data can also be built now (they were blocked on `patternDetection.ts` existing, not on bow data):

| Test ID | Signals used |
|---|---|
| `intonation_fatigue` | linear regression of `pitch` error on time |
| `finger_accuracy_gap` | `NoteEvent.inferredFinger` × `centsDeviation` |
| `pitch_tendency` | mean `centsDeviation` by finger × string |

---

## Phase 8 — App Wiring

**Modified file:** `app/(tabs)/analyze.tsx`

### Post-processing path (uploaded video or recorded video)

`processMedia` currently calls `runVideoAnalysis(uri)` which returns stub `MetricScore[]`. Replace:

```typescript
// 1. extractVideoFrames already returns FrameKeypoints[] from Vision
//    EXTEND: also return RawBowFrame[] from the same analyzeVideo call
const rawFrames = await analyzeVideo(uri);   // native → [{timestamp, joints, leftHand, rightHand, bowTip?, bowFrog?, ...}]

// 2. Build SessionSignals
const signals = buildSessionSignals(audioOutput, rawFrames, durationSeconds);

// 3. Score
const videoMetrics = scorePoseMetrics(signals, instrument);
const findings     = runPatternDetection(signals, noteEvents);

// 4. Store
setResult({ ...result, sessionSignals: signals, findings });
```

### Live recording path

Live recording already collects `onPose` events into a `poseFrames` buffer in `analyze.tsx`. Bow frames are not collected live in this phase (Phase 10 work). After stop, build `SessionSignals` from the buffered pose frames + audio output, with bow signals absent (all null).

---

## Dependency Graph

```
Phase 1 (data collection)
  └─► Phase 2 (training)
        └─► Phase 3 (Swift inference)  ← blocks all bow signals in app
              │
              ▼
Phase 4 (bow signal processing)   ◄── can write code now, test with stub data
Phase 5 (signal assembly)         ◄── can write code now
Phase 6 (bow scoring)             ◄── can write stub code now, real impl needs Phase 3
Phase 7 (pattern detection)       ◄── audio-only tests can be written now
Phase 8 (app wiring)              ◄── can partially wire now; bow metrics light up after Phase 3
```

Audio-only tests (Phase 7) and `SessionSignals` / `TimeSeries` types (Phase 5) have no dependency on the ML model and can be built immediately.

---

## File Manifest

### New files

| File | What it does |
|---|---|
| `bow_analysis.md` | This document |
| `bow_model.md` | ML model training guide (3-keypoint: tip, frog, contact) |
| `ml/extract_frames.py` | Frame extraction from video files |
| `ml/train.py` | YOLOv8n-pose training |
| `ml/evaluate.py` | OKS evaluation + visualization |
| `ml/data.yaml` | Dataset config |
| `modules/pose-camera/ios/BowDetector.swift` | CoreML bow model wrapper |
| `src/types/signals.ts` | `TimeSeries`, `SessionSignals`, `RawBowFrame` types |
| `src/lib/bowAnalysis.ts` | `RawBowFrame[]` → bow time series (projection formula) |
| `src/lib/sessionSignals.ts` | `buildSessionSignals` — assembles full `SessionSignals` |
| `src/lib/patternDetection.ts` | Statistical tests → `StatisticalFinding[]` |

### Modified files

| File | What changes |
|---|---|
| `modules/pose-camera/ios/PoseCameraModule.swift` | Add bow detection to `analyzeVideoFrames` |
| `src/lib/poseScoring.ts` | Replace stubs; scoring fns take `SessionSignals` |
| `src/services/videoAnalysis.ts` | Wire `buildSessionSignals`; call real scoring |
| `src/types/analysis.ts` | Add `sessionSignals?: SessionSignals` to `AnalysisResult` |
| `app/(tabs)/analyze.tsx` | Add `bow_calibration` phase; pass `BowCalibration` through pipeline |

---

## Build Progress

| Step | File(s) | Status |
|---|---|---|
| 1 | `src/types/signals.ts` | ✅ Done |
| 2 | `src/lib/bowAnalysis.ts` | ✅ Done |
| 3 | `src/lib/sessionSignals.ts` | ✅ Done |
| 4 | `src/lib/patternDetection.ts` | ✅ Done |
| 5 | `bow_model.md` | ✅ Done |
| 6 | `ml/extract_frames.py` + labeling | ⏳ Pending (parallel track) |
| 7 | `ml/train.py` | ⏳ Pending (needs ~3,000 labeled frames) |
| 8 | `modules/pose-camera/ios/BowDetector.swift` + `PoseCameraModule.swift` | ⏳ Pending (needs trained model) |
| 9 | `src/lib/poseScoring.ts` + `src/services/videoAnalysis.ts` | ⏳ Pending (needs step 8) |
| 10 | `app/(tabs)/analyze.tsx` | ⏳ Pending (final wiring) |

### Step 1–4 notes (2026-06-16)

- `TimeSeries<T>` uses binary search for `sample()` and `window()` — efficient even at 3,000 pts/signal.
- `bowContactPoint` formula gracefully degrades: uses calibrated `stringY` when available, `leftWrist.y` fallback otherwise.
- `bowZone` returns null throughout when calibration was skipped — statistical tests gate on this.
- `buildSessionSignals` accepts `FrameKeypoints[]` (already converted) + `RawBowFrame[]` separately — keeps conversion logic in the caller (`analyze.tsx`).
- All new files type-check clean; pre-existing TS errors in `analyze.tsx` and `piece/[id].tsx` are unrelated.

### Calibration redesign (2026-06-17)

Reduced from 3 poses to 2 after user feedback:
- **Old scheme**: Pose A (frog at bridge) + Pose B (tip at bridge) + Pose C (bow near fingerboard)
- **New scheme**: Pose A (frog at bridge, sul ponticello) + Pose B (tip at fingerboard, sul tasto)

Each pose now simultaneously calibrates both axes. Pose B ("tip at bridge") was awkward and unnatural. The new Pose B captures the real opposite extreme of bow movement. `BowCalibration.stringY` is now `avg(frogAtBridge.frogY, tipAtFingerboard.tipY)` — an approximation rather than exact, but the string height difference across the playing range is small in normalized frame coords and acceptable for the contact-point formula.

### Redesign (2026-06-17)

Framework redesigned to remove all camera calibration:
- **Old approach**: model detected tip + frog only; string Y estimated from wrist position or per-session calibration poses. Calibration UI built (BowCalibrationFlow.tsx) then deleted.
- **New approach**: model detects 3 keypoints — tip, frog, and the string contact point directly. Project contact onto the frog→tip line for the 0-1 metric. No calibration, no fallback proxy.
- `bowZone` (bridge vs. fingerboard) deferred to a future phase — requires knowing camera relationship to violin body.
- Deleted: `bowCalibration.ts`, `BowCalibrationFlow.tsx`, `BowCalibration` type, `CalibratedBowPose` type.
- `patternDetection.ts`: Three audio-only tests (`intonation_fatigue`, `finger_accuracy_gap`, `pitch_tendency`). `runPatternDetection()` returns only fired findings with confidence ≥ 0.4.
- All files type-check clean (only pre-existing errors in `analyze.tsx` and `piece/[id].tsx` remain).

### What to Build Next (step 6)

`BowCalibrationFlow.tsx` — 3-step tap-to-capture calibration UI inserted between `camera_tip` and `recording` phases. Can be built and tested now against stub bow detection (just return hardcoded `CalibratedBowPose` for each step until the CoreML model exists).
