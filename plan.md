# StringAI — Plan

## Vision

AI-powered mobile tutor for string instruments (violin first). User picks a piece, records themselves, gets actionable piece-aware feedback — not generic scores, but "your F# on the D-string lands flat specifically when played with your 4th finger." Targets hobbyist players who can't afford frequent in-person lessons.

**Access:** Subscription-only. Monthly (7-day free trial) or annual (14-day free trial). A mandatory paywall follows the first-run activation flow; there is no free tier.

---

## Phase Roadmap

| Phase | Status | Scope |
|---|---|---|
| **1 — Shell & UI** | ✅ Done | Full navigation, onboarding, analyze flow, progress tab, piece detail |
| **2 — Audio DSP** | ✅ Done | YIN pitch, FFT tone, RMS, onset, vibrato — 7 metrics; iOS audio extractor |
| **3 — Analysis Layer** | ✅ Done | Pose scoring rules, metric/session detail screens, history drill-through, calibration debug screen |
| **3b — Signal Fusion (audio)** | ✅ Done | `noteFusion.ts` → `NoteEvent[]`; octave-aware intonation; InlineVideoPlayer with speed controls, note markers, frame-accurate seeks; Zustand state persistence |
| **3c — L1 Infrastructure (TS)** | ✅ Done | `TimeSeries<T>`, `SessionSignals`, `RawBowFrame` types; `bowAnalysis.ts` projection formula; `sessionSignals.ts` assembly; `patternDetection.ts` (3 audio tests) |
| **4 — Video Feature Polish** | ⏸ Deprioritized | Deprioritized in favor of bow ML critical path; will revisit after L1 complete |
| **5 — Calibration** | 🔨 In Sprint | L1 calibration is built into the bow ML sprint (Jun 21); full 20-clip calibration after bow detector validated |
| **6 — Supabase & Auth** | 🔨 In Sprint (Jun 23) | Migrations written, .env empty — will wire as final step of MVP sprint |
| **7 — MediaPipe** | 🔨 In Sprint | pose-camera native module exists; wiring into post-hoc scoring pipeline is Jun 20 work |
| **8 — LLM Feedback** | 🔨 In Sprint (Jun 23) | Supabase Edge Function → Claude Haiku — final step of MVP sprint |
| **9 — Android Audio** | Next | Edge Function audio extraction for Android (replaces iOS-only native module) |
| **10 — Real-Time Feedback** | Later | MediaPipe at 2–5 fps during recording; warning overlay — see Real-Time Plan below |
| **11 — Polish** | Later | Milestones, push notifications, RevenueCat, Sentry |
| **12 — Expand** | Future | Viola, Cello (new pose model, different pitch ranges) |
| **13 — Signal Fusion (full)** | ✅ Merged into L1-L10 | Bow fields in NoteEvent now come from bow detector ML, not MediaPipe proxy |
| **14 — Pattern Detection** | 🔨 In Sprint (Jun 22) | patternDetection.ts has 3 tests; adding bow tests + validation on Jun 22 |
| **15 — Real LLM Coaching** | 🔨 In Sprint (Jun 23) | Merged with Phase 8 — Edge Function includes pattern findings + phrase features |
| **16 — Session Chat** | Future | Multi-turn chat with tool-use grounded in session data; see architecture.md |
| **17 — Bow Detector ML** | 🔨 CURRENT PRIORITY | Data collection Jun 19, training Jun 20, CoreML integration Jun 20–21 — see Current Sprint below |
| **18 — Bridge Detector** | Future | Traditional CV (Canny + Hough) to locate bridge top; needed for bowZone (sul ponticello vs. sul tasto) — deferred |
| **19 — Phrasing + Style** | 🔨 In Sprint (Jun 22–23) | L6 phrase segmentation + L7 phrase feature engine in MVP sprint |

---

## Current Sprint: Bow-First, Layer-by-Layer MVP (Jun 18–23)

### Guiding Philosophy

Every higher layer depends on the quality of lower layer data. L2 note grouping, L5 slur detection, L7 phrase features, and L8 pattern correlations cannot be properly calibrated without real bow data from L1. The approach: **get L1 fully working first with real ML-detected bow position/speed/angle, then validate each layer on real data before building the next one.** Do not use MediaPipe wrist position as a proxy for bow tracking — this was considered and rejected because it cannot distinguish tip vs. frog, produces too much noise from arm movement not related to bowing, and would result in L2-L10 being tuned to bad data.

### Why Bow ML First

The four bow metrics (`bowPlacement`, `bowAngle`, `bowArmLevel`, `bowDistribution`) all return `unavailableMetric()` today. Without them:
- L3 time-series feature engine has no bow speed or contact point to populate
- L5 slur detection has no bow direction signal
- L7 phrase features have no `bow_usage` distribution
- L8 pattern tests like `bow_distribution_narrow`, `upper_bow_tone_degradation`, `tip_dynamic_ceiling` cannot fire
- L10 LLM coaching has nothing to say about bow technique (4 of 13 metrics silent)

Getting the bow detector working unlocks all of these simultaneously.

### Day-by-Day Plan

#### Wednesday Jun 18 — Python Data Collection Pipeline

**Goal:** User can run one command Thursday morning to extract frames and begin labeling.

Create `ml/` directory with all tooling ready:

- **`ml/extract_frames.py`**: Extract frames from video files at 10fps. Near-duplicate detection via mean absolute diff of 64×64 grayscale thumbnails — drop frame if diff < `--min-diff` threshold (default 8.0). Output: `ml/data/raw_frames/<video_id>/<frame_id>.jpg` + `ml/data/manifest.csv`. Target: keep ~60-70% of extracted frames (slow passages produce many near-duplicates). Usage: `python extract_frames.py --input videos/ --output data/raw_frames/ --fps 10`

- **`ml/data.yaml`**: YOLOv8 pose dataset config with 3 keypoints (tip, frog, contact point). Critical fields: `kpt_shape: [3, 3]` (3 keypoints × 3 values each: x, y, visibility) and `flip_idx: [1, 0, 2]` (on horizontal flip, tip and frog swap, contact point stays — contact is still the contact regardless of orientation).

- **`ml/train.py`**: YOLOv8n-pose training script, ready to run once labels exist. Config: `yolov8n-pose.pt` base, 150 epochs, AdamW optimizer, lr=0.001, augmentation enabled (mosaic, flip, brightness, blur). Saves best weights to `runs/bow/train/`. Estimated runtime: ~1-2 hours with GPU (MPS on M-series Mac).

- **`ml/export_coreml.py`**: CoreML INT8 export after training. Runs `model.export(format='coreml', imgsz=640, nms=True, int8=True)`. NMS baked into model — simplifies Swift post-processing. Output: `runs/bow/train/weights/best.mlpackage` (~2 MB INT8 quantized). Prints copy command to `modules/pose-camera/ios/`.

- **`ml/evaluate.py`**: OKS (Object Keypoint Similarity) evaluation per keypoint and per bow zone. Targets before shipping: OKS > 0.82 overall, > 0.75 contact point, > 0.90 tip, > 0.88 frog. Also checks: per-zone breakdown (frog area, middle, tip area), confusion with other elongated objects, failure cases (bow behind body, foreshortened).

- **`ml/requirements.txt`**: `ultralytics`, `opencv-python`

**Parallel Swift work (don't wait for model):** Write `BowDetector.swift` against the spec so it's ready to drop the model into.

#### Thursday Jun 19 — Bow Data Collection + Swift Integration

**User task:** Record violin videos covering all bow zones (frog, lower-half, middle, upper-half, tip), both G-string (elbow high) and E-string (elbow low) positions, slow bows and fast détaché/spiccato. Run `extract_frames.py`, upload filtered frames to Roboflow, label 500-1,000 frames. See `bow_model.md` for exact Roboflow project config and keypoint definitions.

**Labeling spec (from `bow_model.md`):**
- Class: `bow`, bounding box around the stick (not the hair ribbon)
- KP0 — Tip: very end of the bow head (the pointed end)
- KP1 — Frog: heel of the frog on the underside, where thumb contacts (NOT the end button)
- KP2 — Contact: where bow hair ribbon crosses the string (look for slight flattening of hair against string)
- Visibility: 0=out of frame or occluded, 1=inferred (partially obscured), 2=fully visible and precisely labeled
- Skip frames where bow is entirely absent; label partial visibility correctly

**My parallel work — Swift integration:**

- **`modules/pose-camera/ios/BowDetector.swift`** (NEW): CoreML wrapper. Loads `bow_detector.mlpackage` from bundle via `MLModel` → `VNCoreMLModel`. Input: `CGImage` → resized to 640×640 letterboxed RGB (preserve aspect ratio, pad with gray, track letterbox offsets). Runs `VNCoreMLRequest`. Parses output tensor `[N, 14]` where each row is `[x, y, w, h, conf, tip_x, tip_y, tip_v, frog_x, frog_y, frog_v, contact_x, contact_y, contact_v]`. Rescales keypoints from 640×640 space back to original frame normalized coords (undo letterboxing). Returns `BowDetection?` struct (nil if `conf < 0.4`). `BowDetection` struct: `tipX, tipY, tipVisible, frogX, frogY, frogVisible, contactX, contactY, contactVisible, confidence` all as Float/Bool.

- **`modules/pose-camera/ios/PoseCameraModule.swift`** (MODIFY): In `analyzeVideoFrames`, after Vision pose inference per frame, call `BowDetector.shared?.detect(in: image)`. If confidence ≥ 0.4, append `bowTip: {x, y, visible}`, `bowFrog: {x, y, visible}`, `bowContact: {x, y, visible}`, `bowConfidence: Float` keys to the frame dict. Frames where bow is not detected simply omit these keys — the JS side treats absent keys as null `RawBowFrame` fields.

- **`src/services/videoAnalysis.ts`** (MODIFY): Parse bow keys from native frame dicts into `RawBowFrame[]`. `analyzeVideoFrames(uri)` currently returns `FrameKeypoints[]`; extend return type to `{ poseFrames: FrameKeypoints[], bowFrames: RawBowFrame[] }`. Gate on presence of `bowTip` key in the frame dict (absent = model not integrated yet OR confidence below threshold — both treated as no bow data for that frame).

#### Friday Jun 20 — Training + CoreML Export + L1 Wiring

**User runs training:**
```bash
cd ml/
python train.py   # ~1-2 hours with MPS GPU
python evaluate.py  # check OKS targets
python export_coreml.py  # export if OKS > 0.75 on contact point
cp runs/bow/train/weights/best.mlpackage ../modules/pose-camera/ios/bow_detector.mlpackage
```

**If OKS on contact point < 0.75:** Don't integrate yet. Check which failure modes dominate (foreshortened bow? Frog occlusion?). Label 200 more frames from those failure modes, retrain.

**App wiring:**

- **`app/(tabs)/analyze.tsx: processMedia()`** (MODIFY): Currently calls `runVideoAnalysis(uri)` stub. Replace:
  ```
  const { poseFrames, bowFrames } = await analyzeVideoFrames(uri)
  const signals = buildSessionSignals(audioOutput, poseFrames, bowFrames, noteEvents, duration)
  const videoMetrics = scorePoseMetrics(signals, instrument)
  const findings = runPatternDetection(signals, noteEvents)
  ```
  Store `signals` in `sessionResultCache` (in-memory, not persisted — too large). Add `sessionSignals?: SessionSignals` to `AnalysisResult` type.

- **`src/lib/poseScoring.ts`** (MODIFY): Replace 4 stub bow scoring functions with real implementations using `SessionSignals`. Signature change: `scoreBowPlacement(signals: SessionSignals)` etc. (was `FrameKeypoints[]`). Also migrate `scoreLeftHandWrist` and `scorePosture` to consume `signals.leftWristAngle` and `signals.shoulderDiff` time series:
  - `scoreBowPlacement`: fraction of frames in each zone; excellent ≥ 70% normal zone, critical > 40% sul tasto
  - `scoreBowAngle`: contiguous violation runs ≥ 3 frames at > 15° deviation from ideal
  - `scoreBowDistribution`: range of `bowContactPoint` used; < 0.3 = critical, ≥ 0.7 = excellent
  - `scoreBowArmLevel`: `rightElbowY` correlated with current string (derived from pitch); join pitch time series to elbow position, compare to `InstrumentConfig` expected range per string

**L1 done when:** Record 30-second clip → all 4 bow metrics show real (non-"unavailable") scores.

#### Saturday Jun 21 — L1 Calibration + L2 Hybrid Onset + Vibrato Fix

**L1 calibration pass** — use `app/debug.tsx` debug screen on 5+ real recordings:
- Bow angle: verify `scoreBowAngle` fires on clearly tilted bow; tune deviation threshold (currently 15°)
- Bow distribution: verify narrow players (only middle bow) get flagged; tune range threshold (currently 0.35)
- Wrist collapse: verify `scoreLeftHandWrist` fires on deliberately collapsed wrist; calibrate threshold
- Posture: verify `scorePosture` fires on raised shoulder
- Audio: tune `YIN_THRESHOLD` (0.15), `IN_TUNE_CENTS` (25), `TONE_QUALITY_CLEAN_THRESHOLD`, `AMPLITUDE_DIP_THRESHOLD` (0.12)

**L2 hybrid onset** — `src/lib/noteFusion.ts`:
- Current onset: energy flux only
- New: `onset_score = 0.6 * spectral_flux + 0.4 * |Δbow_speed|` where bow_speed is sampled from `SessionSignals.bowSpeed` at each onset candidate timestamp
- Merge onsets < 40ms; minimum note duration remains 80ms
- Only apply bow signal when `SessionSignals.bowSpeed.sample(t)` returns non-null (graceful degradation to audio-only onset when bow not detected)

**YIN hop reduction** — `src/services/audioEngine.ts`:
- Change `Math.round(sampleRate * 0.05)` → `Math.round(sampleRate * 0.025)` (50ms → 25ms hop)
- One-line change; improves fast-passage accuracy at 160+ BPM

**Vibrato fix** — `src/services/audioEngine.ts`:
- Replace zero-crossing count (current rough proxy) with band-pass pitch contour analysis
- Bandpass pitch between 4–8 Hz using IIR or moving-average approximation
- Per-note: measure oscillation rate (Hz) via autocorrelation peak within [4Hz, 8Hz]; depth in cents via peak-to-trough amplitude
- Return `{ rate_hz, depth_cents, confidence }` per note
- Penalize: no vibrato (rate ≈ 0), inconsistent (starts/stops mid-note), rate outside 3–7 Hz range
- Feed into `SessionSignals` vibrato time series for L3

#### Sunday Jun 22 — L3 Timbre + L4 Events + L5 Slurs + Pattern Validation

**L3 timbre proxies** — `src/services/audioEngine.ts`:
- Spectral centroid: weighted mean of frequency bins from existing FFT data — `Σ(freq[i] * magnitude[i]) / Σ(magnitude[i])`
- Brightness: high-frequency energy ratio — energy above 3kHz / total energy from Hann-windowed FFT
- Add both to `RawAudioSignals` type and populate in `SessionSignals` via `sessionSignals.ts`

**L4 event detection wiring** — ensure all violations surface as `FlaggedTimestamp[]`:
- Out-of-tune note: `|centsDeviation| > 35` AND duration > 150ms → `TechniqueEvent` with `type: 'out_of_tune_note'`
- Wrist collapse: already working from `scoreLeftHandWrist` → confirm `flaggedTimestamps` populated
- Bow angle violation: new from bow detector → `type: 'bow_angle_deviation'`
- Confirm all event types show as video replay chips in `CoachingReport`

**L5 — Slur/bow grouping** — `src/lib/noteGrouping.ts` (NEW):
- Input: `NoteEvent[]` + bow direction derived from `SessionSignals.bowSpeed` (sign of velocity = direction)
- Bow direction: +1 = tip-ward (up-bow in violin convention), -1 = frog-ward (down-bow), 0 = stationary (speed < threshold ~0.01 normalized units/sec)
- Algorithm: consecutive notes where bow direction stays same sign → slur group; direction flip → new group
- Every note in exactly one group (no gaps, no overlaps)
- Output: `NoteGroup[]` with `{ id, type: 'slur'|'detache'|'other', noteIds: number[], start_t, end_t, confidence }`
- Confidence: fraction of inter-note gaps where bow signal is non-null and consistent

**Pattern detection validation** — run `runPatternDetection()` on 5+ real recordings and verify:
- `intonation_fatigue`: fires on long recordings with pitch drift over time (OLS slope > 0.3 cents/sec)
- `finger_accuracy_gap`: fires when one finger consistently worse (gap ≥ 15 cents, n ≥ 8 notes per finger)
- `pitch_tendency`: fires on systematic sharpness/flatness per finger/string combination
- Add `bow_distribution_narrow` test: fires if `bowContactPoint.window(0, duration)` range < 0.35

#### Monday Jun 23 — L6-L7 + Supabase + L10 LLM

**L6 — Phrase segmentation improvement** — `src/lib/noteFusion.ts: detectPhrases()`:
- Current: RMS-based silence detection (> 500ms rolling avg below 0.008 threshold)
- New composite score: `0.5 * rms_drop + 0.3 * bow_speed_drop + 0.2 * inter_onset_gap`
- Minimum 300ms silence OR composite energy drop > threshold to segment
- Bow speed drop: sample `SessionSignals.bowSpeed` at phrase boundary candidates; large drop = natural phrase end
- Graceful degradation: if bow signal absent, fall back to RMS-only (current behavior)

**L7 — Phrase Feature Engine** — `src/lib/phraseFeatures.ts` (NEW):
- Input: `phrases[]` from L6 + `SessionSignals` + `NoteEvent[]` + `NoteGroup[]` from L5
- Per-phrase output:
  ```typescript
  interface PhraseFeatures {
    id: number
    start_t: number
    end_t: number
    energy_shape: 'flat' | 'arch' | 'late_peak' | 'early_peak'
    peak_location: number          // 0-1 relative position within phrase
    bow_usage: {
      mean_u: number               // mean bowContactPoint
      distribution: 'frog_heavy' | 'middle_heavy' | 'tip_heavy' | 'full'
      coverage: number             // range of bow used (max - min bowContactPoint)
    }
    intonation: {
      mean_error_cents: number
      variance: number
      stability: 'high' | 'moderate' | 'low'
    }
    vibrato_consistency: number    // fraction of notes in phrase with detected vibrato
    timbre_variation: number       // std dev of spectral centroid within phrase
  }
  ```
- `energy_shape`: classify RMS arc by comparing first-half mean vs. second-half mean vs. peak position
- `bow_usage.distribution`: histogram of bowContactPoint into frog (0-0.33), middle (0.33-0.67), tip (0.67-1) zones
- Pass `PhraseFeatures[]` into Edge Function context for L10 LLM coaching

**Supabase wiring:**
- Fill `.env`: `EXPO_PUBLIC_SUPABASE_URL` + `EXPO_PUBLIC_SUPABASE_ANON_KEY`
- Run `supabase/migrations/001_initial_schema.sql` against live project
- `saveSession()` and `fetchSessionHistory()` in `src/services/analysis.ts` are already written — just need live client
- On app startup: query Supabase to backfill `sessionResultCache` for sessions from previous app runs

**L10 — Edge Function** — `supabase/functions/analyze-feedback/index.ts` (NEW):
- Input:
  ```typescript
  {
    instrument: 'violin'
    piece?: { title: string; composer?: string }
    skillLevel: 'beginner' | 'intermediate' | 'advanced'
    metrics: { key: MetricKey; score: number; severity: SeverityBand; observationSummary: string }[]
    patternFindings: { testId: string; summary: string; evidence: object; severity: string }[]
    phraseFeatures?: PhraseFeatures[]   // L7 output, if available
    playerCategory: 'foundation' | 'refinement'
  }
  ```
- Model: `claude-haiku-4-5-20251001` (~$0.001/session)
- System prompt: Expert violin teacher; prioritize 1-3 most important issues; reference piece and skill level; explain the WHY behind each issue (e.g., "your bow speed drops at the tip because...")
- Output structured JSON matching L10 spec: `{ summary, insights[], phrase_feedback[], practice_plan }`
- Replace `buildSessionFeedback()` in `src/services/llmFeedback.ts` with Edge Function call; keep static tips as fallback

**End-to-end verification:**
1. Record 30-second clip → all 13 metrics show real (non-mock) scores
2. All 4 bow metrics (placement, angle, arm level, distribution) show real values
3. Slur groups in `NoteGroup[]` match audible bow direction changes
4. Pattern detection fires at least one test on a realistic recording
5. LLM coaching from Claude references specific issues (not generic text)
6. Session saves to Supabase + reloads in history after full app restart
7. Flagged timestamp chips → video seeks to correct moment

---

## L1–L10 Architecture Specification

This is the reference architecture for the full violin performance analysis pipeline. The app implements this layer by layer, bottom-up, validating each layer on real data before proceeding. Layers L1–L10 correspond to the modules described below. The implementation is in TypeScript (on-device, React Native) except for the Python `ml/` training pipeline.

### L1 — Signal Extraction

**Input:** Raw video frames + audio stream.

**Output:** Structured session data (implemented as `SessionSignals` in `src/types/signals.ts`):
```typescript
{
  metadata: { duration: number, fps: number, sample_rate: number }
  t: number[]                    // aligned timestamps (seconds)
  vision: {
    bow_tip_xy: [number,number][]
    bow_frog_xy: [number,number][]
    bridge_xy: [number,number][] // future: bridge detector
    wrist_xy: [number,number][]
    confidence: {
      bow_tip: number[], bow_frog: number[], bridge: number[], wrist: number[]
    }
  }
  derived_geometry: {
    bow_position_u: number[]     // 0=frog, 1=tip (projection formula)
    bow_angle: number[]          // degrees relative to horizontal
    bow_length_px: number[]      // frog-to-tip pixel distance
    wrist_angle: number[]        // left wrist angle (degrees, interior)
  }
  audio: {
    waveform: number[]
    rms_energy: number[]
    sample_rate: number
  }
}
```

**Implementation files:**
- Audio: `src/services/audioEngine.ts` (✅ complete — YIN pitch, FFT, RMS, onset)
- Vision/pose: `modules/pose-camera/ios/PoseCameraModule.swift` + `src/services/videoAnalysis.ts` (⚠️ partial — pose works, bow detector pending)
- Bow: `modules/pose-camera/ios/BowDetector.swift` + `src/lib/bowAnalysis.ts` (❌ ML model not yet trained)
- Assembly: `src/lib/sessionSignals.ts` (✅ complete — builds `SessionSignals` from all streams)

**Rules:**
- Detect/track keypoints per frame using MediaPipe + CoreML bow detector
- Interpolate gaps < 150ms; discard or mark low-confidence (< 0.5 threshold) frames
- Normalize `bow_position_u` via projection formula: `t = dot(contact − frog, tip − frog) / |tip − frog|²`
- Smooth `wrist_angle` (EMA over 5 frames in `poseFramePrep.ts`) and filter unstable frames

### L2 — Onset + Note Detection

**Input:** L1 audio waveform + rms_energy + bow speed signal (from L1/L3).

**Output:** `{ onsets: OnsetEvent[], notes: NoteEvent[] }` — implemented in `src/lib/noteFusion.ts`.

**Hybrid onset function (planned for Jun 21):**
```
onset_score = 0.6 * spectral_flux + 0.4 * |Δbow_speed|
```
Where `bow_speed` is sampled from `SessionSignals` at each candidate onset timestamp.

**Current implementation:** Energy flux only (audio-only). Pitch segmentation via `segmentByPitch()` — pitch-class-transition detection with 25ms hop and 50ms min note duration. Artifact filtering via `filterArtifacts()` with neighbor-similarity guard.

**Key pitfalls documented:**
- Octave-aware grouping: B4 and B5 are separate pitch classes (stripping octave caused them to merge in intonation analysis — fixed)
- YIN hop size: currently 50ms, should be reduced to 25ms for fast passages

### L3 — Time-Synced Feature Engine

**Input:** L1 + L2 outputs.

**Output:** Uniform time series implemented in `SessionSignals`:
```typescript
{
  t: number[]
  bow_speed: number[]            // from bowAnalysis.ts tip velocity
  bow_position_u: number[]       // 0=frog, 1=tip
  bow_direction: number[]        // +1 tipward, -1 frogward, 0 stationary
  volume_db: number[]
  pitch: (number|null)[]         // Hz or null if unvoiced
  pitch_confidence: number[]
  wrist_angle: number[]
  vibrato: { rate_hz, depth_cents, confidence }[]   // per frame, null if not vibrating
  timbre: {
    spectral_centroid: number[]
    brightness: number[]         // high-freq energy ratio
    spectral_rolloff: number[]   // future
  }
  note_alignment: (number|null)[] // note_id at each timestamp
}
```

**Status:** Schema complete in `src/types/signals.ts`. `sessionSignals.ts` populates audio + pose + bow time series. Vibrato and timbre fields planned for Jun 21-22.

### L4 — Event Detection

**Input:** L3 + L2.

**Output:** Two streams — UI events (shown to user) + internal events (for analytics).

**UI events:**
```typescript
interface TechniqueEvent {
  type: 'out_of_tune_note' | 'wrist_collapse' | 'bow_reset' | 'bow_angle_deviation'
  t: number
  severity: number               // 0-1
  details: object                // e.g. { deviation_cents: 32 }
}
```

**Rules:**
- Out-of-tune: `|cents| > 35` AND note duration > 150ms
- Wrist collapse: angle below `collapseAngle` threshold for ≥ 3 consecutive frames
- Bow angle: deviation > 15° for ≥ 3 consecutive frames (new — enabled by bow detector)

**Status:** `patternDetection.ts` has 3 statistical tests. `poseScoring.ts` produces events for wrist/posture. Bow events will be added when bow detector is live.

### L5 — Note Grouping (Slurs)

**Input:** L2 notes + L3 bow_direction.

**Output:**
```typescript
interface NoteGroup {
  id: number
  type: 'slur' | 'detache' | 'other'
  noteIds: number[]
  start_t: number
  end_t: number
  confidence: number
}
```

**Rule:** Consecutive same bow_direction → slur; direction reset → new group. Every note in exactly one group.

**Status:** ❌ Not yet built. Planned for Jun 22 in `src/lib/noteGrouping.ts`. Requires bow direction signal from L1 bow detector.

### L6 — Phrase Segmentation

**Input:** L3 energy signals + L5 groups + L2 onsets.

**Output:**
```typescript
interface Phrase {
  id: number
  start_t: number
  end_t: number
  confidence: number
}
```

**Method:** Composite energy = `0.5 * volume + 0.3 * bow_speed + 0.2 * note_density`. Silence > 300ms, bow reset + pause, or strong composite energy slope change triggers segment.

**Status:** ⚠️ Basic RMS-based version in `noteFusion.ts: detectPhrases()`. Improvement planned for Jun 23.

### L7 — Phrase Feature Engine

**Input:** L3 + L5 + L6.

**Output:**
```typescript
interface PhraseFeatures {
  id: number
  energy_shape: 'flat' | 'arch' | 'late_peak' | 'early_peak'
  peak_location: number          // 0-1 relative position
  bow_usage: {
    mean_u: number
    distribution: 'frog_heavy' | 'middle_heavy' | 'tip_heavy' | 'full'
    coverage: number             // bow travel fraction (max - min contact point)
  }
  intonation: {
    mean_error_cents: number
    variance: number
    stability: 'high' | 'moderate' | 'low'
  }
  tempo: { stability: string; mean_bpm: number }
  vibrato: { consistency: string; avg_rate: number; avg_depth: number }
  timbre_variation: number
}
```

**Status:** ❌ Not yet built. Planned for Jun 23 in `src/lib/phraseFeatures.ts`.

### L8 — Statistical Relationship Engine

**Input:** L7 phrase features + L4 events.

**Output:**
```typescript
{
  correlations: { a: string; b: string; strength: number; p_value: number }[]
  lag_effects: { cause: string; effect: string; lag_ms: number; strength: number }[]
  event_clusters: object[]
  min_sample_warning: boolean
}
```

**Status:** ⚠️ `patternDetection.ts` implements pre-specified tests (not general correlation search). Three tests implemented: `intonation_fatigue`, `finger_accuracy_gap`, `pitch_tendency`. Bow-dependent tests pending: `bow_distribution_narrow`, `upper_bow_tone_degradation`, `tip_dynamic_ceiling`, `sul_tasto_drift`, `phrase_end_pressure`. All tests gate on `confidence >= 0.4` (requires n ≥ 8 samples in each group).

### L9 — Musical Interpretation Layer

**Input:** L7 + L8.

**Output:** Categorical version of L7 with severity flags. No raw numbers in final user view.

**Status:** ⚠️ `src/lib/sessionAssessment.ts` classifies player as foundation/refinement, builds key observations and issues. Needs extension with phrase-level interpretation from L7.

### L10 — LLM Teacher

**Input:** L9 + subset of L8 (pattern findings).

**Tools available to LLM:** `get_correlations()`, `get_event_examples(event_type)`, `get_phrase_details(phrase_id)` — will be implemented as Edge Function tool use (Phase 16, session chat).

**Output:**
```typescript
{
  summary: string
  insights: { metricKey: string; observation: string; feedback: string; exercise: object }[]
  phrase_feedback: { phraseId: number; observation: string; tip: string }[]
  practice_plan: { title: string; duration: string; instructions: string }[]
}
```

**Guardrails:** Explain the WHY; link technique to music; prioritize 1-3 issues max; give specific exercises. Never recompute stats or reference raw numbers.

**Status:** ⚠️ `src/services/llmFeedback.ts` is a local stub using static templates. Supabase Edge Function → Claude Haiku planned for Jun 23.

---

## Audio Metric Improvement Plans

### Pitch Accuracy
**Current:** YIN pitch with 1024-sample window (~23ms) and **50ms hop**. Works well at moderate tempos; at 160 BPM sixteenth notes get only 1–2 readings each.

**Improvement path:**
1. **Reduce YIN hop to 25ms** in `audioEngine.ts` — one-line change: `Math.round(sampleRate * 0.05)` → `Math.round(sampleRate * 0.025)`. Immediate improvement. Planned Jun 21.
2. **Per-note pitch via NoteEvent[]** — `noteFusion.ts` already built; compute median pitch within each note segment rather than across all frames. Handles fast passages cleanly.
3. **ML onset detection** — see ML Onset Detection section below.
4. **Score-aware (long-term)** — align detected pitches against known note sequence for named pieces via DTW; distinguishes B♭ (correct) from accidentally flat B.

### Intonation Stability
**Current:** Std deviation of pitch over detected windows. Conflates vibrato with instability.

**Fix:** Band-pass split at 2 Hz / 7 Hz. Low-frequency component (< 2 Hz) = real drift → penalize. 4–7 Hz component = vibrato → feed to vibrato scoring, not penalized here.

### Tone Quality
**Current:** FFT fundamental/total-power ratio. Algorithm correct; thresholds uncalibrated.

**Improvement:**
1. Calibrate `TONE_QUALITY_CLEAN_THRESHOLD` and `TONE_QUALITY_NOISE_THRESHOLD` (see Calibration Plan).
2. Add **spectral centroid** as second signal: high centroid = scratchy, low centroid = breathy. Separates the two failure modes. Planned Jun 22.
3. Once bow speed exists (Jun 20): tone anomalies at high bow speed = excessive pressure; at low speed = too little contact.

### Bow Smoothness
**Current:** RMS amplitude-dip detector. Catches obvious crashes; misses subtle roughness.

**Fix:** Measure first derivative of RMS envelope at each bow change — steep derivative = abrupt, shallow = smooth. Suppress penalty when strokes are short and rhythmically regular (intentional spiccato/martelé).

### Rhythm Accuracy
**Current:** Onset detection works; comparison to a reference grid not yet wired.

**Fix:** (1) BPM estimation from mode of inter-onset intervals. (2) Map each onset to nearest beat, measure offset in ms. (3) Report rushing tendency (mean offset) and unevenness (std dev) separately.

### Dynamic Control
**Current:** RMS range analysis; scoring weights uncalibrated.

**Fix:** Slow envelope (< 2 Hz) vs. fast fluctuations (> 2 Hz) split. Absolute range check: if session never exceeds 0.15 RMS, flag "no forte moments." Coordinate with phrase shape once phrasing is built.

### Vibrato
**Current:** Zero-crossing counting — rough proxy conflating vibrato with instability.

**Fix (planned Jun 21):** (1) Band-pass filter pitch between 4–8 Hz. (2) Measure oscillation rate (Hz) via autocorrelation peak and depth (cents) via peak-to-trough amplitude. (3) Report per-note, not session average. Penalize: no vibrato, inconsistent (starts/stops), rate outside 3–7 Hz.

---

## Video Metric Improvement Plans

Note: The previous plan used "wrist proxy" for bow tracking as a stopgap. **This approach was explicitly rejected.** MediaPipe wrist position cannot distinguish tip vs. frog, produces noise from non-bow arm movement, and would result in higher layers (L5-L10) being calibrated to bad data. The plan is to go directly to the bow ML detector (Phase 17, now prioritized as part of MVP sprint).

### Bow Placement, Angle, Distribution, Speed
**Current:** All four return `unavailableMetric()`. Stub is in `poseScoring.ts`.

**With bow detector ML (Jun 20-21):** YOLOv8n-pose on ~500-1,000 labeled frames → CoreML INT8 export (~2 MB). Outputs 3 keypoints: tip, frog, contact point. Contact point is the key innovation — projects onto frog→tip line for `bow_position_u` without calibration. Replaces all stubs with real implementations.

**Bow Speed** (new metric, not yet implemented): `|tip[t] - tip[t-1]| / frame_interval`. Available from `src/lib/bowAnalysis.ts: deriveBowTimeSeries()` once model is integrated.

### Left Hand Wrist Alignment
**Current:** Logic is geometrically precise in `poseScoring.ts`; blocked on real MediaPipe hand landmarks flowing into post-hoc scoring.

**After Jun 20 wiring:** Calibrate `collapseAngle` threshold against real recordings of known-good and known-bad wrist positions via debug screen.

### Bow Arm Level
**Current:** Measures elbow height variance — backwards for single-string passages (single-string scales show low variance correctly).

**Fix (Jun 20):** Join pitch stream to video frames by timestamp. Determine current string from pitch frequency (G3–B3 = G-string, etc.). Compare `rightElbowY` to expected range for that string from `InstrumentConfig`.

### Posture
**Current:** Shoulder y-difference and head tilt. Geometrically sound; needs threshold calibration.

**Enhancements:** Add scroll height check (violin angle from wrist/shoulder line); split raised-shoulder detection into left (violin) and right (bow) shoulder — different causes.

---

## L5–L7 Implementation Plans

### L5 — Note Grouping / Slur Detection (`src/lib/noteGrouping.ts`)

New file planned for Jun 22. Takes `NoteEvent[]` + bow direction derived from `SessionSignals.bowSpeed`.

**Algorithm:**
1. For each timestamp between consecutive notes, sample `bowSpeed` from `SessionSignals`
2. Classify direction: `sign(bowSpeed) > threshold` = tipward (+1), `< -threshold` = frogward (-1), within threshold = stationary (0)
3. Run-length encode the direction sequence
4. Consecutive notes within a same-direction run → slur group
5. Direction change between notes → new group (detaché)
6. Confidence: fraction of inter-note samples where bow signal is non-null

**Output type:**
```typescript
interface NoteGroup {
  id: number
  type: 'slur' | 'detache' | 'other'
  noteIds: number[]
  start_t: number
  end_t: number
  confidence: number   // 0-1: based on bow signal quality
}
```

### L6 — Phrase Segmentation Improvement (`noteFusion.ts: detectPhrases()`)

Current implementation: RMS-based silence detection only. Improvement on Jun 23:
- Composite boundary score: `0.5 * rms_drop + 0.3 * bow_speed_drop + 0.2 * inter_onset_gap`
- Bow speed drop: sample `SessionSignals.bowSpeed` at phrase boundary candidates; large speed drop = natural bow rest = phrase end
- Graceful degradation: if bow signal absent for > 80% of session, fall back to RMS-only (current behavior)
- Minimum segment duration: 500ms (filter out breath-length pauses within a phrase)

### L7 — Phrase Feature Engine (`src/lib/phraseFeatures.ts`)

New file planned for Jun 23. Per-phrase analysis over `SessionSignals` window.

**Energy shape classification:**
- Sample RMS in first third, middle third, last third of phrase
- arch: middle > both ends by > 20%
- late_peak: last third > first third by > 20%
- early_peak: first third > last third by > 20%
- flat: all thirds within 20% of each other

**Bow usage distribution:**
- Histogram of `bowContactPoint` into frog (0-0.33), middle (0.33-0.67), tip (0.67-1.0) bins
- frog_heavy: > 50% of time in frog bin
- tip_heavy: > 50% of time in tip bin
- middle_heavy: > 50% in middle
- full: no bin > 50%

---

## Musical Interpretation Plans

### Phrasing (Phase 19)
1. **DSP detection:** Phrase peaks = local maxima in slow-moving dynamic envelope (RMS smoothed with ~2s window). Score dynamic arc shape (rise-fall), bow speed at peak, legato continuity.
2. **Statistical tests** (in `patternDetection.ts`): `phrase_peak_lacks_bow_speed`, `phrase_end_pressure_maintained`, `flat_dynamic_profile`.
3. **LLM interpretation:** Phrase shape flows into `CoachingInput` with `piece.style` ("baroque" | "romantic"). Different phrasing expectations per period — the LLM handles this without separate rules.
4. **Score-aware (long-term):** Upload sheet music with dynamic markings → compare played dynamics measure by measure.

### Session Chat (Phase 16)
Multi-turn conversation grounded in session data after the automated report. LLM has tool access (`get_notes`, `query_metric_window`, `get_findings`) to answer specific questions. See architecture.md for full design.

### Stylistic/Expressive Advice
- **Short term (with LLM):** LLM uses piece style knowledge — "for Vivaldi, terraced dynamics suit the Baroque period."
- **Medium term:** Route flagged passages (15–30s clips) to a multimodal audio LLM for tone colour judgment.
- **Long term:** Reference performance comparison — extract dynamic/tempo/vibrato trajectories from professional recordings, compare student trajectories.

---

## ML Onset Detection Model (Future)

At faster tempos, note segmentation in `noteFusion.ts` isn't perfect even with the 25ms segmentation hop.

**Recommended: Basic Pitch (Spotify Research)**
- Open-source pitch + onset model, available as a TFLite model
- ~10ms onset precision, significantly better than energy-flux onset detection for fast violin passages
- Pitch-change-aware (not just energy-change), so handles legato passages correctly
- Runs on-device via `react-native-fast-tflite` (same pipeline as bow detector and MediaPipe)
- Outputs both onset times and fundamental frequency — could unify `noteFusion.ts`'s pitch segmentation into a single ML inference step

**When to pursue:** After bow detector is validated and L1-L5 are stable. Onset detection becomes the primary remaining bottleneck for fast-passage accuracy at that point.

---

## Calibration Plan (Phase 5)

**Goal:** All 13 metrics produce plausible scores on real recordings. Flagged timestamps match actual problem moments.

**Access:** Settings tab → "Audio Analysis Debug" (dev builds only). Pick any video from camera roll; runs full pipeline; shows raw intermediates + final scores; "Share Raw JSON" for logging.

**Note:** Calibration is now split — L1 calibration (bow + pose thresholds) happens Jun 21 as part of the bow ML sprint. Full 20-clip audio calibration happens after bow detector is validated.

### 20 Calibration Clips

**Pitch / Intonation**
1. G major scale, slow whole bows, tuned carefully beforehand → pitchAccuracy: excellent
2. Same scale, violin a quarter-step flat → pitchAccuracy: critical
3. Same scale, every note a half-step sharp → pitchAccuracy: critical
4. Free playing, natural drift (no deliberate correction) → pitchAccuracy: needs_attention
5. Sustained open strings (G, D, A, E), 5 seconds each, in tune → intonationStability: excellent

**Tone Quality**
6. Open strings, slow full bow, arm weight, clean contact → toneQuality: excellent
7. Same, press hard and slow the bow (deliberate scratch) → toneQuality: critical
8. Bow very fast and light near fingerboard (thin, whistling tone) → toneQuality: needs_attention
9. Bow right next to bridge (sul ponticello, nasal tone) → toneQuality: needs_attention

**Bow Smoothness**
10. Slow détaché, smooth direction changes ("curved" bow changes) → bowSmoothness: excellent
11. Same, every bow change deliberately abrupt and jerky → bowSmoothness: critical

**Vibrato**
12. Sustained A on A string, full consistent vibrato → vibrato: good/excellent
13. Same note, completely straight tone, no vibrato → vibrato: critical
14. Vibrato starts okay then stops mid-note → vibrato: needs_attention

**Rhythm**
15. Simple scale played along with a metronome click → rhythmAccuracy: excellent
16. Same passage — rush on difficult notes, drag on easy ones → rhythmAccuracy: critical

**Dynamics**
17. ff for 10s → pp for 10s → ff (exaggerated contrast) → dynamicControl: excellent
18. Same passage at identical volume throughout → dynamicControl: critical

**Edge Cases**
19. Normal honest practice of a simple piece → all metrics: personal baseline
20. 10 seconds silence then normal playing → test silence handling

### Key Thresholds to Tune

| Constant | Location | Current Value | Target behavior |
|---|---|---|---|
| `YIN_THRESHOLD` | `audioEngine.ts` | 0.15 | Too high → noisy pitch stream; too low → gaps |
| `IN_TUNE_CENTS` | `audioEngine.ts` | 25 | Tighter for advanced (15 cents), looser for beginners (30) |
| `TONE_QUALITY_CLEAN_THRESHOLD` | `audioEngine.ts` | — | Scratch < 50; clean tone > 80 |
| `AMPLITUDE_DIP_THRESHOLD` | `audioEngine.ts` | 0.12 | Abrupt bow changes < 60; smooth détaché > 80 |
| `BOW_ANGLE_DEVIATION_DEG` | `poseScoring.ts` | 15° | Calibrate against known-tilted bow recordings |
| `BOW_DISTRIBUTION_MIN_RANGE` | `poseScoring.ts` | 0.35 | Calibrate: player using < 35% of bow length = flagged |
| `WRIST_COLLAPSE_ANGLE` | `poseScoring.ts` | 18° (interior) | Calibrate against known-collapsed wrist recordings |

Expect 2–3 passes through all clips — adjusting one threshold can shift others. After calibration: validate flagged timestamps by spot-checking that the flagged moment in the video actually shows the problem.

---

## MediaPipe Integration Plan (Phase 7)

**Status update:** The native `pose-camera` module already exists and works for real-time pose. The remaining work is wiring `FrameKeypoints[]` from post-hoc video analysis into `poseScoring.ts` scoring functions. This is being done as part of the bow ML sprint (Jun 20).

**Approach:** Apple Vision framework in `PoseCameraModule.swift: analyzeVideoFrames()` — already samples at 10fps and returns `FrameKeypoints[]`. The stub `runVideoAnalysis()` in `src/services/analysis.ts` needs to be replaced with a real call to `analyzeVideoFrames()`.

**Remaining steps:**
1. Extend `analyzeVideoFrames` return type to include `RawBowFrame[]` (bow detector output)
2. Wire `buildSessionSignals(audioOutput, poseFrames, bowFrames, noteEvents, duration)` into `processMedia()`
3. Call `scorePoseMetrics(signals, instrument)` replacing stub
4. Calibrate pose thresholds via debug screen

**Note on MediaPipe library:** `pose-camera` module uses Apple Vision (not the MediaPipe SDK directly). This is already working. No additional MediaPipe library installation needed for Phase 7.

---

## Real-Time Feedback Plan (Phase 10)

Requires bow detector integrated into live recording path (separate from post-hoc analysis). Deferred until post-MVP.

### Architecture
```
CameraView (live recording)
  ├─► Frame processor at 2–5 fps → Vision landmarks + BowDetector → Violation[]
  ├─► Rolling 200ms audio pitch check → { pitchOk, centsOff }
  └─► React state: activeWarnings (max 2 shown simultaneously)
        └─► RealtimeWarningOverlay above CameraView
```

### Warning Triggers
| Condition | Message |
|---|---|
| Left wrist bend > 20° | "Straighten your wrist" |
| Left wrist bend > 30° | "Wrist collapsing — relax left hand" |
| Right shoulder raised > 3cm equiv. | "Lower your right shoulder" |
| Head tilt > 15° | "Keep head level" |
| Violin scroll below chin level | "Raise the violin" |
| Elbow wrong level for string being played | "Move elbow higher/lower" |
| Bow angle deviation > 15° | "Straighten the bow" |
| Sul tasto zone > 3 consecutive frames | "Bow too near fingerboard" |
| Pitch deviation > 30 cents for > 400ms | "Check your intonation" |

Cards auto-dismiss after 3 seconds if violation resolves. Max 2 cards; overflow queued. Strictness slider: Relaxed (thresholds × 1.5), Normal, Strict (thresholds × 0.7).

### New files needed (Phase 10)
- `src/services/realtimePose.ts` — landmarks → Violation[]
- `src/services/realtimePitch.ts` — rolling pitch check
- `src/components/analysis/RealtimeWarningOverlay.tsx`
- `src/components/analysis/WarningCard.tsx`

**Note:** `expo-av` doesn't stream PCM during recording — file only available after stop. Real-time pitch monitoring may need `react-native-audio-analyser` or a custom native module. Investigate before building.

---

## LLM Feedback Layer (Phase 8 / L10)

### Edge Function: `supabase/functions/analyze-feedback/index.ts`

**Input:**
```typescript
{
  instrument: 'violin'
  piece?: { title: string; composer?: string }
  skillLevel: 'beginner' | 'intermediate' | 'advanced'
  playerCategory: 'foundation' | 'refinement'
  metrics: { key: MetricKey; score: number; severity: SeverityBand; observationSummary: string }[]
  patternFindings: {
    testId: string
    summary: string
    evidence: { groupA: object; groupB: object; effectSize: number }
    severity: string
  }[]
  phraseFeatures?: PhraseFeatures[]
}
```

**Model:** `claude-haiku-4-5-20251001`. ~575 tokens per session = < $0.001.

**Prompt guidance:**
- Expert violin teacher persona
- Prioritize 1-3 most impactful issues (not all flagged metrics)
- Link technique to musical outcome ("your bow distributes too heavily toward the frog, which is why you lose tone in the upper half of the bow")
- Reference piece and skill level where helpful
- Give specific, actionable exercises — not generic advice
- Return structured JSON matching L10 output schema

**Client integration:** After `setResult(result)` in `processMedia`, call Edge Function, merge response into result, cache on session row so re-viewing doesn't re-call LLM. `MetricCard.tsx` reads `metric.tip` if present, otherwise falls back to static `METRIC_META[key].tips[severity]`.

---

## Open Questions

1. **MediaPipe library status:** `pose-camera` module uses Apple Vision, not MediaPipe SDK directly. Already working. No additional library installation needed. ✅ Resolved.

2. **Android audio:** `VideoAudioExtractor` is iOS-only (AVFoundation). Android needs a Supabase Edge Function accepting video → returning PCM WAV, or use `expo-av` recording events directly (limits DSP options). Deferred post-MVP.

3. **Real-time pitch stream:** `expo-av` only gives a file after recording stops. May need `react-native-audio-analyser` or a custom native module for rolling pitch feedback during recording. Relevant for Phase 10 (real-time feedback).

4. **Supabase session backfill:** Once Supabase is wired, query `sessions` + `metric_scores` on app startup and populate `sessionResultCache`. Unblocks `/session/[id]` for historical sessions from previous app runs.

5. **Bow detector training data diversity:** `bow_model.md` calls for at least 3 players. MVP may ship with 1 player's data; document this as a known limitation and label more frames from different players over time.

6. **Contact point visibility at frog:** The bow hair is compressed at the frog, making the exact contact point harder to see. Expect lower OKS in frog-area frames. Label 200+ frames specifically from frog-area playing to improve robustness.

7. **Git remote SSH alias:** Repo uses SSH alias `github-personal` in remote URL (`git@github-personal:marvalarva2929/stringai.git`) to handle multiple GitHub accounts. This breaks tools that parse remote URLs for `github.com` (e.g., Ultraplan). The alias is intentional and correct — don't change it. Tools needing HTTPS: add a second remote `git remote add github https://github.com/marvalarva2929/stringai.git`.
