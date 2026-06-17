# StringAI — Plan

## Vision

AI-powered mobile tutor for string instruments (violin first). User picks a piece, records themselves, gets actionable piece-aware feedback — not generic scores, but "your F# on the D-string lands flat specifically when played with your 4th finger." Targets hobbyist players who can't afford frequent in-person lessons.

**Tiers:** Free (2 lifetime analyses) · $9.99/mo · $59.99/yr

---

## Phase Roadmap

| Phase | Status | Scope |
|---|---|---|
| **1 — Shell & UI** | ✅ Done | Full navigation, onboarding, analyze flow, progress tab, piece detail |
| **2 — Audio DSP** | ✅ Done | YIN pitch, FFT tone, RMS, onset, vibrato — 7 metrics; iOS audio extractor |
| **3 — Analysis Layer** | ✅ Done | Pose scoring rules, metric/session detail screens, history drill-through, calibration debug screen |
| **3b — Signal Fusion (audio)** | ✅ Done | `noteFusion.ts` → `NoteEvent[]`; octave-aware intonation; InlineVideoPlayer with speed controls, note markers, frame-accurate seeks; Zustand state persistence |
| **4 — Video Feature Polish** | 🔨 Now | Finish remaining video replay features (user's current focus) |
| **5 — Calibration** | 🔨 Now | Record 20 calibration clips, tune DSP thresholds — see Calibration Plan below |
| **6 — Supabase & Auth** | Next | Create live project, run migration, wire auth, enable session persistence, paywall gate |
| **7 — MediaPipe** | Next | `react-native-vision-camera` + `react-native-fast-tflite`; replace `runVideoAnalysis` stub; extend NoteEvent with video/pose fields |
| **8 — LLM Feedback** | Next | Supabase Edge Function → Claude; piece-aware coaching tips — see LLM Feedback below |
| **9 — Android Audio** | Next | Edge Function audio extraction for Android (replaces iOS-only native module) |
| **10 — Real-Time Feedback** | Later | MediaPipe at 2–5 fps during recording; warning overlay — see Real-Time Plan below |
| **11 — Polish** | Later | Milestones, push notifications, RevenueCat, Sentry |
| **12 — Expand** | Future | Viola, Cello (new pose model, different pitch ranges) |
| **13 — Signal Fusion (full)** | Future | Add video/pose fields to `NoteEvent`; `inferString`/`inferFinger`; Supabase `note_events` table |
| **14 — Pattern Detection** | Future | ~20 pre-specified statistical tests on `NoteEvent[]` → `StatisticalFinding[]` |
| **15 — Real LLM Coaching** | Future | Edge Function: `StatisticalFinding[]` + history → `CoachingReport` (2–3 causal items max) |
| **16 — Session Chat** | Future | Multi-turn chat with tool-use grounded in session data; see architecture.md |
| **17 — Bow Detector ML** | Future | YOLO-nano on ~2,000 labeled frames → TFLite; direct tip/frog tracking replaces wrist proxy |
| **18 — Bridge Detector** | Future | Traditional CV (Canny + Hough) to locate bridge top; anchors all bow position measurements |
| **19 — Phrasing + Style** | Future | DSP phrase arc detection; LLM style advice using `piece.style`; multimodal audio model for premium |

---

## Audio Metric Improvement Plans

### Pitch Accuracy
**Current:** YIN pitch with 1024-sample window (~23ms) and **50ms hop**. Works well at moderate tempos; at 160 BPM sixteenth notes get only 1–2 readings each.

**Improvement path:**
1. **Reduce YIN hop to 20ms** in `audioEngine.ts` — one-line change: `Math.round(sampleRate * 0.05)` → `Math.round(sampleRate * 0.02)`. Immediate improvement.
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
2. Add spectral centroid as second signal: high centroid = scratchy, low centroid = breathy. Separates the two failure modes.
3. Once bow speed exists: tone anomalies at high wrist speed = excessive pressure; at low speed = too little contact.

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

**Fix:** (1) Band-pass filter pitch between 3–8 Hz. (2) Measure oscillation rate (Hz) and depth (cents) directly. (3) Report per-note, not session average. Penalize: no vibrato, inconsistent (starts/stops), rate outside 3–7 Hz.

---

## Video Metric Improvement Plans

All video metrics are blocked on MediaPipe integration (Phase 7). Scoring logic already written in `poseScoring.ts`.

### Bow Placement, Angle, Distribution, Speed
**Current:** Right wrist position as proxy. Correlates with bow zone but can't distinguish tip vs. frog at similar wrist angles.

**With MediaPipe (Phase 7):** Wrist proxy stays; metric cards note "estimated from wrist position."

**With bow detector ML (Phase 17):** YOLO-nano on ~2,000 labeled frames (bow stick bounding box with tip x/y and frog x/y). ~2–4 MB quantized. Outputs direct contact point, angle, speed — replaces all wrist proxies.

**Bow Speed** (new metric, not yet implemented): `|tipPosition[t] - tipPosition[t-1]| / frame_interval`. Short-term proxy: RMS derivative as "bow energy variation" until bow model exists.

### Left Hand Wrist Alignment
**Current:** Logic is correct and geometrically precise; blocked on real MediaPipe hand landmarks.

**After MediaPipe:** Calibrate `collapseAngle` threshold (currently 18°) against real recordings of known-good and known-bad wrist positions.

### Bow Arm Level
**Current:** Measures elbow height variance — backwards for single-string passages (single-string scales show low variance correctly).

**Fix:** Join pitch stream to video frames by timestamp. Determine current string from pitch frequency (G3–B3 = G-string, etc.). Compare elbow height to expected range for *that string*.

### Posture
**Current:** Shoulder y-difference and head tilt. Geometrically sound; needs threshold calibration.

**Enhancements:** Add scroll height check (violin angle from wrist/shoulder line); split raised-shoulder detection into left (violin) and right (bow) shoulder — different causes.

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

The user raised this: at faster tempos, note segmentation in `noteFusion.ts` isn't perfect even with the 25ms segmentation hop. Would a trained ML model for onset detection help?

**Yes — this is the right long-term path for precise note boundaries.**

**Recommended: Basic Pitch (Spotify Research)**
- Open-source pitch + onset model, available as a TFLite model
- ~10ms onset precision, significantly better than energy-flux onset detection for fast violin passages
- Pitch-change-aware (not just energy-change), so handles legato passages correctly
- Runs on-device via `react-native-fast-tflite` (same pipeline as bow detector and MediaPipe)
- Outputs both onset times and fundamental frequency — could unify `noteFusion.ts`'s pitch segmentation into a single ML inference step

**Alternative:** Custom onset model trained on labeled violin audio (MIDI-aligned recordings or manual annotation). More effort; would be tailored specifically to violin attack profiles.

**When to pursue:** After MediaPipe and bow detector are integrated. At that point onset detection becomes the primary remaining bottleneck for fast-passage accuracy.

---

## Calibration Plan (Phase 5)

**Goal:** All 7 audio metrics produce plausible scores on real recordings. Flagged timestamps match actual problem moments.

**Access:** Settings tab → "Audio Analysis Debug" (dev builds only). Pick any video from camera roll; runs full pipeline; shows raw intermediates + final scores; "Share Raw JSON" for logging.

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

Expect 2–3 passes through all 20 clips — adjusting one threshold can shift others. After calibration: validate flagged timestamps by spot-checking that the flagged moment in the video actually shows the problem.

---

## MediaPipe Integration Plan (Phase 7)

**Recommended path:** `react-native-vision-camera` + `react-native-fast-tflite` with official MediaPipe TFLite models. Native speed, avoids WASM entirely. Evaluate vs. `@mediapipe/tasks-vision` WASM bridge before committing.

### Steps
1. Install and configure chosen package
2. Create `src/services/videoAnalysis.ts` — samples frames at 2 fps, runs Pose + Hands models, calls `scorePoseMetrics()` from `poseScoring.ts`, returns `MetricScore[]`
3. Replace `runVideoAnalysis` stub in `src/services/analysis.ts`
4. Calibrate pose thresholds in `poseScoring.ts` against real recordings using debug screen
5. Extend `NoteEvent` in `noteFusion.ts` with video/pose fields: `wristCollapsed`, `shoulderRaised`, `bowContactPoint`, `bowAngle`, `bowDistanceFromBridge`, `bowZone`
6. Implement `inferString(noteName)` and `inferFinger(noteName, string)` in `noteFusion.ts`

---

## Real-Time Feedback Plan (Phase 10)

Requires MediaPipe (Phase 7) first.

### Architecture
```
CameraView (live recording)
  ├─► Frame processor at 2–5 fps → MediaPipe landmarks → Violation[]
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

Every warning logged as `{ metricKey, startTime, endTime }` → fed into `flaggedTimestamps` on `AnalysisResult` after recording stops.

### New files needed
- `src/services/realtimePose.ts` — landmarks → Violation[]
- `src/services/realtimePitch.ts` — rolling pitch check
- `src/components/analysis/RealtimeWarningOverlay.tsx`
- `src/components/analysis/WarningCard.tsx`

**Note:** `expo-av` doesn't stream PCM during recording — file only available after stop. Real-time pitch monitoring may need `react-native-audio-analyser` or a custom native module. Investigate before building.

---

## LLM Feedback Layer (Phase 8)

### Edge Function: `supabase/functions/analyze-feedback/index.ts`

**Input:**
```ts
{
  instrument: 'violin',
  piece?: { title: string; composer?: string },
  skillLevel: 'beginner' | 'intermediate' | 'advanced',
  metrics: { key: MetricKey; score: number; severity: SeverityBand; observationSummary: string }[]
}
```

**Prompt:** Expert violin teacher system prompt. For each metric with `needs_attention` or `critical` severity: one 2-sentence tip + exercise. Reference the piece where helpful. Return JSON `[{ metricKey, tip, exercise }]`.

**Cost:** ~575 tokens per session at Claude Haiku pricing = < $0.001.

**Client integration:** After `setResult(result)` in `processMedia`, call Edge Function, merge tips into result, cache on session row so re-viewing doesn't re-call.

`MetricCard.tsx` reads `metric.tip` if present, otherwise falls back to static `METRIC_META[key].tips[severity]`.

---

## Open Questions

1. **MediaPipe path:** `react-native-vision-camera` + `react-native-fast-tflite` vs. `@mediapipe/tasks-vision` WASM bridge. Evaluate both before committing.

2. **Android audio:** `VideoAudioExtractor` is iOS-only (AVFoundation). Android needs a Supabase Edge Function accepting video → returning PCM WAV, or use `expo-av` recording events directly (limits DSP options).

3. **Real-time pitch stream:** `expo-av` only gives a file after recording stops. May need `react-native-audio-analyser` or a custom native module for rolling pitch feedback during recording.

4. **Supabase session backfill:** Once Supabase is wired, query `sessions` + `metric_scores` on app startup and populate `sessionResultCache`. Unblocks `/session/[id]` for historical sessions from previous app runs.
