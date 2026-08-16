# StringAI — Progress & Codebase Reference

> **Update**: this document is a point-in-time snapshot from Jun 18–23, 2026 and
> several items below are now stale. Notably: the Supabase Edge Functions
> (`analyze-feedback`, `session-chat`, `delete-account`, `revenuecat-webhook`)
> are complete, production-quality implementations — not stubs — and just need
> `supabase functions deploy` run against the live project. The bow ML model has
> since been trained (see `ml/cloud/pipeline_summary.json`). The app is now
> subscription-only: `SubscribeGate` renders a mandatory paywall over the
> navigator once activation ends, and the free tier (daily analysis quota,
> per-feature locks) has been removed entirely. Treat the rest of this doc as
> historical context rather than current status.

## Current Status: Bow ML Pipeline — Critical Path to Full L1-L10 Analysis

**As of Jun 18, 2026.** The audio analysis pipeline (L1 audio, L2 note fusion, L3 signals, L4 basic pattern detection) is fully implemented in TypeScript and working on-device. The bow detector ML model is the critical missing piece: all four bow metrics return "unavailable," and L5 (slur detection), L7 (phrase features), and several L8 pattern tests are blocked until the bow detector provides real bow position/speed/angle data.

**Active sprint (Jun 18–23):** Build the Python bow ML pipeline (Wed), collect/label training data (Thu), train and export CoreML model (Fri), wire into app + implement real bow scoring (Fri-Sat), calibrate all L1 thresholds (Sat), implement L2–L5 improvements (Sat-Sun), implement L6–L7 phrase analysis (Mon), wire Supabase + LLM Edge Function (Mon).

**Philosophy adopted:** Layer-by-layer, bottom-up. Do not build L2 improvements on top of L1 proxy data. Do not validate L5-L10 until L1 bow data is real.

---

## Tech Stack

| Layer | Choice |
|---|---|
| Mobile | React Native + Expo (managed workflow) |
| Routing | Expo Router (file-based) |
| State | Zustand (+ persist middleware with AsyncStorage) |
| Backend | Supabase (Postgres + Auth + Storage + Edge Functions) — written, not yet connected |
| Payments | RevenueCat — subscription-only; mandatory paywall after activation |
| Audio DSP | Custom on-device pipeline in `audioEngine.ts` |
| Video | Native iOS `VideoAudioExtractor` module (AVFoundation) |
| CV / Pose | Apple Vision (in `PoseCameraModule.swift`) — working for pose; bow detector pending |
| Bow ML | YOLOv8n-pose → CoreML INT8 (~2 MB) — training in progress |
| ML Training | Python: Ultralytics YOLOv8, OpenCV — lives in `ml/` directory |
| Labeling | Roboflow (3-keypoint: tip, frog, contact) |
| LLM Coaching | Claude Haiku via Supabase Edge Function — planned Jun 23 |

---

## Layer Status (L1–L10)

| Layer | Name | Status | Blocker |
|---|---|---|---|
| **L1 Audio** | Signal Extraction (audio) | ✅ Complete | — |
| **L1 Vision** | Signal Extraction (pose) | ⚠️ Partial | `FrameKeypoints[]` not yet wired into post-hoc `processMedia()` scoring path |
| **L1 Bow** | Signal Extraction (bow) | ❌ Blocked | ML model not yet trained; Python pipeline being built Jun 18 |
| **L2** | Onset + Note Detection | ✅ Audio-only complete | Hybrid onset (+ bow speed) planned Jun 21 |
| **L3** | Time-Synced Feature Engine | ⚠️ Schema done | Vibrato series (zero-crossing only now), timbre missing; planned Jun 21-22 |
| **L4** | Event Detection | ⚠️ Partial | 3 audio tests in `patternDetection.ts`; bow events blocked on L1 bow |
| **L5** | Note Grouping (Slurs) | ❌ Not built | Needs bow direction from L1 bow |
| **L6** | Phrase Segmentation | ⚠️ Basic only | RMS-based only; composite energy improvement planned Jun 23 |
| **L7** | Phrase Feature Engine | ❌ Not built | `phraseFeatures.ts` planned Jun 23 |
| **L8** | Statistical Relationships | ⚠️ Partial | `patternDetection.ts` has 3 tests; bow-dependent tests blocked |
| **L9** | Musical Interpretation | ⚠️ Partial | `sessionAssessment.ts` works; phrase-level interpretation missing |
| **L10** | LLM Teacher | ⚠️ Stub | `llmFeedback.ts` uses static templates; Edge Function planned Jun 23 |

---

## Current Sprint Checklist (Jun 18–23)

### Wednesday Jun 18 — Python Pipeline
- [ ] Create `ml/` directory
- [ ] `ml/extract_frames.py` — 10fps extraction, near-duplicate deduplication, manifest.csv output
- [ ] `ml/data.yaml` — YOLOv8 pose config, `kpt_shape: [3,3]`, `flip_idx: [1,0,2]`
- [ ] `ml/train.py` — YOLOv8n-pose training script
- [ ] `ml/export_coreml.py` — CoreML INT8 export
- [ ] `ml/evaluate.py` — OKS evaluation with per-keypoint and per-zone breakdown
- [ ] `ml/requirements.txt`
- [ ] `modules/pose-camera/ios/BowDetector.swift` — CoreML wrapper (can write against spec before model exists)

### Thursday Jun 19 — Data Collection (User leads)
- [ ] Record violin videos (all bow zones, both strings, slow + fast)
- [ ] Run `extract_frames.py` on recordings
- [ ] Upload to Roboflow, label 500–1,000 frames (tip, frog, contact keypoints)
- [ ] `modules/pose-camera/ios/PoseCameraModule.swift` — extend `analyzeVideoFrames` with bow detection
- [ ] `src/services/videoAnalysis.ts` — parse bow keys → `RawBowFrame[]`

### Friday Jun 20 — Training + L1 Wiring
- [ ] Train model (`python ml/train.py`)
- [ ] Evaluate OKS (contact point > 0.75 required)
- [ ] Export + copy `best.mlpackage` to `modules/pose-camera/ios/`
- [ ] `app/(tabs)/analyze.tsx` — wire real pose + bow into `processMedia()`
- [ ] `src/lib/poseScoring.ts` — replace 4 stub bow scoring functions with real implementations

### Saturday Jun 21 — Calibration + L2 Improvements
- [ ] L1 calibration: tune bow angle threshold, bow distribution range, wrist collapse angle
- [ ] Audio calibration: tune `YIN_THRESHOLD`, `IN_TUNE_CENTS`, tone quality thresholds
- [ ] `src/services/audioEngine.ts` — reduce YIN hop 50ms → 25ms
- [ ] `src/services/audioEngine.ts` — vibrato fix (band-pass pitch contour, per-note rate/depth)
- [ ] `src/lib/noteFusion.ts` — hybrid onset function (bow speed derivative)

### Sunday Jun 22 — L3-L5 + Pattern Validation
- [ ] `src/services/audioEngine.ts` — spectral centroid + brightness (timbre proxies)
- [ ] `src/lib/sessionSignals.ts` — populate vibrato and timbre time series
- [ ] Wire L4 bow events (angle deviation) into `flaggedTimestamps`
- [ ] `src/lib/noteGrouping.ts` (NEW) — L5 slur/bow grouping
- [ ] `src/lib/patternDetection.ts` — add `bow_distribution_narrow` test; validate all 4 tests fire on real data

### Monday Jun 23 — L6-L10 + Backend
- [ ] `src/lib/noteFusion.ts` — improve L6 phrase segmentation (composite energy)
- [ ] `src/lib/phraseFeatures.ts` (NEW) — L7 phrase feature engine
- [ ] Fill `.env` with Supabase keys
- [ ] Run `supabase/migrations/001_initial_schema.sql`
- [ ] `supabase/functions/analyze-feedback/index.ts` (NEW) — L10 Edge Function → Claude Haiku
- [ ] `src/services/llmFeedback.ts` — replace stub with Edge Function call
- [ ] End-to-end test: record → all 13 real metrics → real LLM coaching → save to Supabase → reload in history

---

## Completed

### Foundation
- [x] Expo + Expo Router project scaffolded (TypeScript, Zustand, NativeWind)
- [x] Navigation: `(auth)` group, `(tabs)` group, root auth gate, subscribe gate over the navigator
- [x] Onboarding flow — 5-slide carousel
- [x] Login + Register screens (UI complete, Supabase auth code written)
- [x] Core UI components: Button, Card, ScoreGauge, MetricCard, AnalysisTimeline
- [x] Instrument config system — violin defined, viola/cello stubs in place
- [x] `scripts/run.sh` + `scripts/build.sh`, `.env.example`
- [x] Git repo initialized, remote: `git@github-personal:marvalarva2929/stringai.git` (SSH alias for multi-account GitHub setup — intentional, don't change)

### Home Tab
- [x] Analytics strip — sessions count, avg score, trend (last 3 vs previous 3), streak
- [x] Score trend sparkline card
- [x] Focus This Week card — derives weakest metric from recent sessions, shows exercise tip from `METRIC_META`
- [x] Piece group cards — title, session count, latest score, sparkline, improvement delta, "Continue Session" button; tapping navigates to `/session/[latestSessionId]`

### Analyze Tab (2-step flow)
- [x] **piece_input:** plain text input for song name + optional PDF upload + Next/Skip
- [x] **method_select:** "Record In-App" and "Upload a Video" option cards + back button
- [x] **Recording:** `CameraView` (expo-camera) front-facing camera + audio; REC badge, elapsed timer, stop button
- [x] **Processing:** 3-phase spinner (audio → video → saving)
- [x] **Results:** split layout — InlineVideoPlayer + swipeable CoachingReport drawer
- [x] `continueWithPiece(piece)` store action — skips piece_input, jumps to method_select

### Progress Tab
- [x] "By Song" view — sessions grouped by piece with sparklines and improvement delta
- [x] "All Sessions" view — flat session list
- [x] `app/piece/[id].tsx` — piece detail: stats row, bar chart (score per session), full session list newest-first

### Audio Analysis Engine
- [x] `src/services/audioEngine.ts` — full on-device DSP pipeline:
  - WAV parser (handles 8/16/32-bit PCM, any channel count)
  - YIN pitch detection (1024-sample window ~23ms, **50ms hop** — reduce to 25ms is planned Jun 21)
  - Cooley-Tukey in-place FFT + Hann window
  - RMS envelope + onset detection
  - 7 scored metrics: pitchAccuracy, intonationStability, toneQuality, bowSmoothness, rhythmAccuracy, dynamicControl, vibrato
  - Each scoring fn returns `MetricScore` with `events`, `occurrenceRate`, `observationSummary`, `flaggedTimestamps`
- [x] `modules/video-audio-extractor/` — native iOS module (AVFoundation); extracts PCM from any video URI (`ph://`, `file://`) and writes a WAV file

### Signal Fusion Layer (L1-L2 TypeScript Infrastructure)
- [x] `src/lib/noteFusion.ts` — audio-only `NoteEvent[]` pipeline:
  - `segmentByPitch()`: pitch-class-transition segmentation (`MIN_DURATION_S=0.05`, `HOP_S=0.025`, `MAX_NULL_GAP=4`)
  - `filterArtifacts()`: removes short notes with neighbor-similarity guard (`SHORT_S=0.15`, `MAX_PASSES=6`)
  - `deriveIntonationAnalysis()`: groups by full note name incl. octave (B4/B5 are separate; was stripping octave — caused B4/B5 to merge)
- [x] `src/types/signals.ts` — `TimeSeries<T>`, `SessionSignals`, `RawBowFrame` types; binary search for `sample()` and `window()` queries
- [x] `src/lib/bowAnalysis.ts` — `RawBowFrame[]` → `BowTimeSeries`:
  - Projection formula: `t = dot(contact − frog, tip − frog) / |tip − frog|²` (no calibration needed)
  - Spike rejection on single-frame tip.y outliers
  - `deriveBowTimeSeries()` filters low-confidence frames and spike outliers
- [x] `src/lib/sessionSignals.ts` — `buildSessionSignals()` assembles all 4 streams into `SessionSignals`
- [x] `src/lib/patternDetection.ts` — 3 statistical tests: `intonation_fatigue` (OLS regression), `finger_accuracy_gap` (group comparison), `pitch_tendency` (schema ready); min n=8 samples; confidence from effect size + sample size
- [x] `NoteEvent` carries: `startSeconds`, `endSeconds`, `noteName`, `pitchHz`, `centsDeviation`, `inTune`, `midiNote`; bow/pose fields all null (pending bow detector + pose wiring)
- [x] `PitchClassIssue.pitchClass` holds full note name incl. octave (e.g. "B4", "F#5"); `representativeMidi` for reference note lookups

### Video Replay Feature
- [x] `src/types/analysis.ts` — `videoUri?` and `noteEvents?` added to `AnalysisResult`; `exampleTimestamps?` added to `PitchClassIssue`
- [x] `src/lib/intonationAnalysis.ts` — surfaces up to 3 out-of-tune example timestamps per `PitchClassIssue`
- [x] `src/services/llmFeedback.ts` — deduplicates items by metricKey (pitchAccuracy + intonationStability → single intonation coaching card)
- [x] `src/components/analysis/VideoReplayModal.tsx` — full-screen slide-up modal player
- [x] `src/components/analysis/InlineVideoPlayer.tsx` — always-open compact player:
  - Props: `uri`, `seekVersion`, `seekSeconds`, `noteEvents`, `durationSeconds`, `onMarkerPress`, `fullScreen`
  - Speed controls: 0.25×/0.5×/1.0× with pitch correction (`setRateAsync(rate, true)`)
  - Note-event marker ticks on scrubber (amber, 2px wide, 10px tall)
  - Note name overlay in fullscreen mode (position: absolute, top-right)
  - Frame-accurate chip seeks: `{ toleranceMillisBefore: 0, toleranceMillisAfter: 0 }` — drag-scrub left as fast/tolerant
  - `effectiveDuration` priority: live `duration` state → `durationSeconds` prop → noteEvents estimate
  - Sets `Audio.setAudioModeAsync` on mount to restore playback after recording
- [x] `src/components/analysis/AnalysisTimeline.tsx` — tapping colored segments seeks inline player (carousel mode) or opens VideoReplayModal (standalone mode)
- [x] `src/components/analysis/CoachingReport.tsx` — peeking FlatList carousel: Summary card + coaching item cards + Intonation card; ▶ timestamp chips seek the inline player
- [x] `app/(tabs)/analyze.tsx` — results phase: split layout; `persistVideo()` copies to `sessions/` dir with 10-session retention; `handleTimestampPress(s)` adds +30ms offset to land at note onset rather than mid-note
- [x] `app/session/[id].tsx` — same split layout; passes `noteEvents`, `durationSeconds`, `onMarkerPress` to InlineVideoPlayer so markers appear when viewing session history
- [x] `app/(tabs)/home.tsx` — piece group cards navigate to `/session/[latestSessionId]`

### Pose Scoring Logic
- [x] `src/lib/poseScoring.ts` — complete rule-based pose scoring: `FrameKeypoints` type, MediaPipe landmark index constants, 6 scoring functions (bowPlacement, bowAngle, bowArmLevel, bowDistribution, leftHandWrist, posture), `scorePoseMetrics()` entry point. Pure functions on landmark arrays — no native dependency.
- [x] `src/lib/poseFramePrep.ts` — downsampling to 10fps, EMA smoothing (α=0.35), shoulder-midpoint normalization
- [x] `runVideoAnalysis` stub — returns 4 mock video metrics; replaced by real scoring in Jun 20 sprint

### Metric Detail Screen
- [x] `app/metric/[key].tsx` — full-screen metric detail: score gauge + severity badge + delta, filtered timeline, flagged timestamp list, MetricSparkline (shown when ≥2 sessions), "How to Fix" drill card
- [x] `src/components/analysis/MetricSparkline.tsx` — bar chart (no external library), colored by severity
- [x] `src/constants/metricMeta.ts` — `drill` field on all 13 metrics with specific practice exercises
- [x] `MetricCard.tsx` — expanded view shows "Full breakdown →" link to `/metric/[key]?sessionId=[id]`

### Session History Navigation
- [x] `app/session/[id].tsx` — full results for any cached session; tappable from All Sessions and piece session lists
- [x] `app/(tabs)/progress.tsx` — All Sessions rows tappable (with `›`), navigate to `/session/[id]`
- [x] `app/piece/[id].tsx` — session list rows tappable, navigate to `/session/[id]`

### Calibration Debug Tooling
- [x] `app/debug.tsx` — hidden screen (Settings → Developer in dev builds): pick any video, runs full audio analysis, displays final scores + all raw intermediate values per metric, "Share Raw JSON" button
- [x] `src/services/audioEngine.ts` — `analyzeMediaFileWithDebug()` export + `AudioDebugInfo` type; captures raw intermediates without affecting production code path

### Store & Data Model
- [x] `SessionSummary` carries piece context (`{ id, title, composer }`)
- [x] `sessionToSummary(result)` helper — derives `topIssue` from lowest-scoring metric
- [x] `addToHistory` called after every analysis so progress is visible immediately without Supabase
- [x] `metricHistory: MetricHistoryEntry[]` — per-session `MetricScore[]` stored for sparkline data
- [x] `sessionResultCache: Record<string, AnalysisResult>` — full result keyed by session ID; powers session detail screen
- [x] `overallDelta` — rolling 3-session average comparison computed in `processMedia`, stored on `AnalysisResult`

### State Persistence
- [x] `src/store/useAnalysisStore.ts` — Zustand `persist` middleware (AsyncStorage key `stringai-analysis-v1`)
  - Persisted: `phase`, `currentResult`, `sessionHistory`, `metricHistory`
  - Not persisted: `sessionResultCache` (in-memory), `recordingUri`, `selectedPiece`, `error`
  - Transient phases (`recording`, `processing_*`, `uploading`, `error`) reset to `piece_input` or `done` on rehydration

### Backend Code (written, not yet connected to live project)
- [x] `supabase/migrations/001_initial_schema.sql` — all tables, RLS policies, profile trigger, free-analyses increment RPC
- [x] `src/services/auth.ts` — signUp, signIn, signOut, fetchProfile, updateProfileFields, incrementFreeAnalysesInDb
- [x] `src/services/analysis.ts` — saveSession (piece upsert + session insert + metric_scores insert), fetchSessionHistory
- [x] Auth store: onboarding status persisted to AsyncStorage, session restored on startup, profile cleared on sign-out

---

## Codebase Reference

### Directory Structure

```
app/
  (auth)/
    onboarding.tsx        5-slide onboarding + goal picker
    login.tsx
    register.tsx
  (tabs)/
    home.tsx              Dashboard — piece group cards tap → /session/[latestId]
    analyze.tsx           Full recording + analysis + results flow (~1200 lines)
    progress.tsx          Session history: by-song and all-sessions views
    settings.tsx
  piece/[id].tsx          Piece detail screen
  session/[id].tsx        Historical session detail — split layout (video + drawer)
  metric/[key].tsx        Per-metric drill-down screen
  debug.tsx               Dev-only audio calibration screen

src/
  components/
    analysis/
      CoachingReport.tsx      Peeking horizontal FlatList carousel
                              Props: llmFeedback, assessment, intonationAnalysis,
                                videoUri, metrics, durationSeconds, onTimestampPress
      InlineVideoPlayer.tsx   Always-open video player (top of results screen)
                              Props: uri, seekVersion, seekSeconds, noteEvents,
                                durationSeconds, onMarkerPress, fullScreen
                              Speed controls, note markers, frame-accurate seeks
      VideoReplayModal.tsx    Full-screen slide-up modal (standalone AnalysisTimeline)
      AnalysisTimeline.tsx    Horizontal colour-coded timeline bar
      MetricCard.tsx          Per-metric card with inline expand + "Full breakdown →"
      MetricSparkline.tsx     Bar chart sparkline (no external library)
      PoseSkeleton.tsx        Live pose overlay during recording
    ui/
      Button.tsx, Card.tsx, ScoreGauge.tsx
  constants/
    metricMeta.ts         Labels, icons, tips, drill exercises per MetricKey (13 metrics)
    instruments.ts        InstrumentConfig (violin; viola/cello stubs)
    theme.ts              colors, spacing, radius
  lib/
    noteFusion.ts         PitchFrame[] → NoteEvent[] via pitch-class-transition
                          segmentation + artifact filtering
                          deriveIntonationAnalysis(): octave-aware intonation grouping
    poseScoring.ts        6 video scoring functions → MetricScore[]
                          Pure functions on FrameKeypoints[]; no native dependency
                          4 bow functions are stubs (unavailableMetric) pending bow detector
    bowAnalysis.ts        RawBowFrame[] → BowTimeSeries
                          Projection formula: contact onto frog→tip line → bow_position_u
                          Spike rejection, confidence filtering
    sessionSignals.ts     buildSessionSignals() — assembles SessionSignals from all 4 streams
    patternDetection.ts   3 statistical tests on NoteEvent[]; runPatternDetection() entry point
    sessionAssessment.ts  Classifies player as foundation|refinement from metrics
    intonationAnalysis.ts analyzeIntonation(PitchFrame[]) → IntonationAnalysis
                          Surfaces exampleTimestamps (up to 3) per PitchClassIssue
    poseFramePrep.ts      Downsampling, EMA smoothing, shoulder normalization
    practicePlan.ts       Computes practice plan from MetricHistoryEntry[]
    noteGrouping.ts       [PLANNED Jun 22] L5 slur/bow grouping → NoteGroup[]
    phraseFeatures.ts     [PLANNED Jun 23] L7 phrase feature extraction → PhraseFeatures[]
  services/
    audioEngine.ts        On-device DSP (~750 lines)
                          analyzeMediaFile(uri) → AudioAnalysisOutput
                          YIN pitch, FFT tone, RMS, onset, vibrato → 7 MetricScores
                          analyzeMediaFileWithDebug() → AudioDebugInfo (raw intermediates)
    analysis.ts           Pipeline orchestration + Supabase persistence
                          runAudioAnalysis() / runVideoAnalysis() (STUB — replaced Jun 20)
                          buildSessionFeedback() / saveSession() / fetchSessionHistory()
    llmFeedback.ts        buildSessionFeedback() — local stub returning static tips
                          WILL BE REPLACED with Edge Function call Jun 23
    auth.ts               Supabase auth helpers
    videoAudioExtractor.ts Native iOS module wrapper (AVFoundation)
    videoAnalysis.ts      [NEEDS WORK] Frame extraction + bow key parsing → {poseFrames, bowFrames}
  store/
    useAnalysisStore.ts   Phase state machine + session/metric history + sessionResultCache
                          Zustand persist middleware (AsyncStorage)
    useAuthStore.ts       Auth state + onboarding + playerCategory
    useUserStore.ts       UserProfile (instrument, skillLevel, playerCategory)
  types/
    analysis.ts           All analysis types (see Key Types below)
    signals.ts            TimeSeries<T>, SessionSignals, RawBowFrame

modules/
  video-audio-extractor/  Native iOS AVFoundation module: extractAudioFromVideo() → wavUri
  pose-camera/ios/
    PoseCameraModule.swift   10fps pose+hands inference; WILL BE EXTENDED with bow detection Jun 19
    BowDetector.swift        [PLANNED Jun 18-19] CoreML wrapper for bow keypoint model

ml/                       [PLANNED Jun 18] Python bow ML training pipeline
  extract_frames.py       10fps frame extraction + near-duplicate filtering
  data.yaml               YOLOv8 pose config (kpt_shape:[3,3], flip_idx:[1,0,2])
  train.py                YOLOv8n-pose training (150 epochs, AdamW)
  export_coreml.py        INT8 CoreML export → best.mlpackage
  evaluate.py             OKS evaluation (target: overall>0.82, contact>0.75)
  requirements.txt        ultralytics, opencv-python
  data/raw_frames/        Frame extraction output (not committed)
  runs/                   Training output (not committed)

supabase/
  migrations/
    001_initial_schema.sql  All tables, RLS, profile trigger — ready to deploy
  functions/
    analyze-feedback/     [PLANNED Jun 23] Edge Function → Claude Haiku coaching
```

### Key Types

```typescript
interface MetricScore {
  key: MetricKey;
  score: number;                    // INTERNAL: 0-100, for trend tracking only
  delta?: number;
  severity: SeverityBand;           // INTERNAL
  flaggedTimestamps: FlaggedTimestamp[];  // powers timeline + replay chips
  events: TechniqueEvent[];
  occurrenceRate: number;           // 0-1 fraction of session with issue
  observationSummary: string;       // "Left wrist collapsed 7 times"
  measurementQuality?: 'unavailable' | 'low' | 'normal';  // 'unavailable' excludes from overall score
}

interface NoteEvent {
  startSeconds: number;
  endSeconds: number;
  noteName: string;        // "F#4" (full name incl. octave)
  pitchHz: number;
  centsDeviation: number;  // signed: + sharp, − flat
  inTune: boolean;         // |centsDeviation| ≤ 25
  midiNote: number;
  // All null until L1 bow detector + pose wiring complete:
  wristCollapsed: boolean | null;
  shoulderRaised: boolean | null;
  bowContactPoint: number | null;  // 0=frog, 1=tip (projection formula)
  bowAngle: number | null;
  bowZone: 'sul_ponticello' | 'normal' | 'sul_tasto' | null;  // future (needs bridge detector)
}

interface PitchClassIssue {
  pitchClass: string;       // full note name incl. octave: "B4", "F#5"
  totalNoteEvents: number;
  outOfTuneCount: number;
  errorRate: number;
  avgDeviationCents: number;
  tendency: 'flat' | 'sharp' | 'mixed';
  exampleTimestamps?: { startSeconds: number; endSeconds: number }[];  // up to 3
  representativeMidi?: number;
}

interface RawBowFrame {
  timestamp: number;
  tipX: number;     tipY: number;     tipVisible: boolean;
  frogX: number;    frogY: number;    frogVisible: boolean;
  contactX: number; contactY: number; contactVisible: boolean;
  confidence: number;
}

interface SessionSignals {
  durationSeconds: number;
  // Dense audio (~40 Hz, 25ms hop):
  pitch:            TimeSeries<number | null>;   // Hz; null = unvoiced
  rms:              TimeSeries<number>;
  fundamentalRatio: TimeSeries<number>;
  // Sparse pose (10 fps):
  leftWristAngle:   TimeSeries<number | null>;
  rightElbowY:      TimeSeries<number | null>;
  shoulderDiff:     TimeSeries<number | null>;
  // Sparse bow (10 fps, high-confidence frames only):
  bowContactPoint:  TimeSeries<number | null>;   // 0=frog … 1=tip
  bowAngle:         TimeSeries<number | null>;
  bowSpeed:         TimeSeries<number | null>;   // norm coords/sec (tip velocity)
  // Segmentation:
  noteEvents: NoteEvent[];
}

interface NoteGroup {
  // [PLANNED L5 - Jun 22]
  id: number;
  type: 'slur' | 'detache' | 'other';
  noteIds: number[];
  start_t: number;
  end_t: number;
  confidence: number;
}

interface AnalysisResult {
  sessionId: string;
  userId: string;
  instrument: InstrumentId;
  piece?: Piece;
  durationSeconds: number;
  recordedAt: string;
  overallScore: number;
  overallDelta?: number;
  metrics: MetricScore[];
  audioMetrics: MetricScore[];
  videoMetrics: MetricScore[];
  sessionAssessment?: SessionAssessment;
  llmFeedback?: LLMFeedback;
  intonationAnalysis?: IntonationAnalysis;
  videoUri?: string;           // local file:// or ph:// path
  noteEvents?: NoteEvent[];    // powers scrubber markers + intonation replay chips
  sessionSignals?: SessionSignals;  // in-memory only, not persisted (too large)
}
```

### Analysis Pipeline (`analyze.tsx: processMedia`)

**Current (stub for video):**
```
processMedia(uri, durationSec, isVideo)
  ├─ persistVideo(uri) → videoUri
  ├─ runAudioAnalysis(uri) → AudioAnalysisOutput
  │    └─ analyzeMediaFile → analyzeWavFile
  │         ├─ detectPitches() → PitchFrame[]
  │         ├─ noteFusion.segmentByPitch + filterArtifacts → NoteEvent[]
  │         ├─ 7 scoring fns → MetricScore[]
  │         └─ deriveIntonationAnalysis(noteEvents) → IntonationAnalysis
  ├─ runVideoAnalysis(uri) → MetricScore[]  ← STUB (mock data)
  ├─ computeOverallScore(audio, video, weights)
  ├─ buildSessionAssessment(videoMetrics, userCategory) → SessionAssessment
  ├─ buildSessionFeedback(allMetrics, ...) → LLMFeedback  ← STUB (static templates)
  └─ AnalysisResult { videoUri, noteEvents } → Zustand + store cache
```

**Target (after Jun 20 wiring):**
```
processMedia(uri, durationSec, isVideo)
  ├─ persistVideo(uri) → videoUri
  ├─ runAudioAnalysis(uri) → AudioAnalysisOutput
  ├─ analyzeVideoFrames(uri) → { poseFrames: FrameKeypoints[], bowFrames: RawBowFrame[] }
  ├─ buildSessionSignals(audioOutput, poseFrames, bowFrames, noteEvents, duration) → SessionSignals
  ├─ scorePoseMetrics(signals, instrument) → MetricScore[]  (real bow + pose scores)
  ├─ runPatternDetection(signals, noteEvents) → StatisticalFinding[]
  ├─ computeOverallScore(audio, video, weights)
  ├─ buildSessionAssessment(videoMetrics, userCategory) → SessionAssessment
  ├─ buildSessionFeedback(metrics, findings, phraseFeatures, ...) → calls Edge Function → LLMFeedback
  └─ AnalysisResult { videoUri, noteEvents, sessionSignals } → Supabase + store cache
```

### Video Replay Architecture

```
Results screen (analyze.tsx or session/[id].tsx)
│
├─ State: seekVersion: number, seekSeconds: number
│  handleTimestampPress(s) → setSeekSeconds(s + 0.030); setSeekVersion(v+1)
│  (+30ms offset: YIN detection latency means flagged start is mid-note;
│   +30ms lands at note onset in the video)
│
├─ Animated.View (bottom = drawerAnim) — video fills area above drawer
│    └─ InlineVideoPlayer
│         uri={result.videoUri}
│         seekVersion / seekSeconds
│         noteEvents={result.noteEvents}      ← scrubber marker ticks
│         durationSeconds={result.durationSeconds}
│         onMarkerPress={handleTimestampPress}
│         Frame-accurate seeks: toleranceMillisBefore/After: 0
│         Speed: 0.25×/0.5×/1.0× (pitch-corrected)
│
└─ Animated.View drawer (height = drawerAnim, swipeable)
     └─ CoachingReport carousel or fallback metric list
          onTimestampPress → seeks InlineVideoPlayer, collapses drawer to DRAWER_MIN_H
          ▶ timestamp chips appear on cards that have flaggedTimestamps or exampleTimestamps
```

### Video Storage
- `FileSystem.documentDirectory + 'sessions/session_<timestamp>.<ext>'`
- 10-session retention (oldest deleted on new save)
- `ph://` library URIs are played directly — not copied
- Copy failure falls back to original URI so player always has something to show

### What Is NOT Yet Implemented

**Blocked on bow detector (ML model not yet trained):**
- All 4 bow metrics: `bowPlacement`, `bowAngle`, `bowArmLevel`, `bowDistribution` (return `unavailableMetric()`)
- L5 slur/bow grouping (`noteGrouping.ts`)
- L8 tests: `bow_distribution_narrow`, `upper_bow_tone_degradation`, `tip_dynamic_ceiling`, `sul_tasto_drift`, `phrase_end_pressure`
- Bow speed as hybrid onset signal

**In current sprint (Jun 18-23):**
- `ml/` Python pipeline (Wed Jun 18)
- `BowDetector.swift` CoreML wrapper (Wed-Thu Jun 18-19)
- Bow training data labeling (Thu Jun 19 — user task)
- Real pose + bow scoring wiring into `processMedia` (Fri Jun 20)
- Vibrato fix (band-pass, per-note) (Sat Jun 21)
- Timbre proxies (spectral centroid, brightness) (Sun Jun 22)
- `noteGrouping.ts` L5 slur detection (Sun Jun 22)
- `phraseFeatures.ts` L7 phrase engine (Mon Jun 23)
- Supabase `.env` + migration deployment (Mon Jun 23)
- Edge Function + real LLM coaching (Mon Jun 23)

**Deferred post-MVP:**
- MediaPipe library (using Apple Vision native module instead — already working)
- Bridge detector (Canny + Hough) for bow zone (sul tasto / sul ponticello) detection — needs camera-to-violin relationship
- Real-time feedback overlay during recording (Phase 10)
- Session chat with tool-use (Phase 16)
- Android audio extraction
- YIN hop size 50ms → 25ms (planned Jun 21 alongside other audio improvements)
- `sessionResultCache` for sessions from previous app runs (clears on restart; Supabase backfill will fix this)

---

## Key Architectural Decisions

| Decision | Rationale |
|---|---|
| No raw video to backend | Only keypoint JSON (~5 KB). Keeps per-analysis cost ~$0. |
| Apple Vision, not MediaPipe SDK | `pose-camera` native module already uses Vision framework; works, no reinstall needed |
| No wrist proxy for bow tracking | Wrist position cannot distinguish tip vs. frog; calibrating L2-L10 against proxy data would embed errors into all higher layers. Go straight to bow ML. |
| Layer-by-layer, bottom-up | Can't assess quality of L2+ without real data from L1. Validate each layer before building the next. |
| Bow ML over wrist proxy | Adds ~1 week but produces real bow_position_u (0=frog, 1=tip) via contact point projection — no calibration needed. |
| 3 keypoints: tip + frog + contact | Contact point detected directly by model. `t = dot(contact − frog, tip − frog) / |tip − frog|²` — no per-session calibration. Older design (2 keypoints + calibration UI) was deleted. |
| Free tier = 2 lifetime analyses | Simple to enforce; never resets. |
| LLM tips via Edge Function | API key stays off client; easy to swap models. |
| Static tips as fallback | Results always show something even if LLM call fails. |
| 10 fps video sampling | Enough for bow tracking, keeps processing load light. (Was 2fps in earlier plans — increased.) |
| `poseScoring.ts` has no native dependency | Pure functions on landmark arrays — unit-testable, swappable between Vision/MediaPipe versions. |
| `noteFusion.ts` audio-only first | NoteEvent[] pipeline delivers value (intonation, markers) before bow detector is integrated. |
| `sessionResultCache` in-memory only | Full results needed for session detail. Supabase will backfill on load once wired. |
| Zustand persist skips `sessionResultCache` | Cache can be large; `currentResult` alone is sufficient to show results on relaunch. |
| Frame-accurate seeks only on chip press | Drag-scrub uses fast/tolerant mode for UX; chip presses use `toleranceMillisBefore/After: 0` for precision. |
| +30ms seek offset on timestamp press | YIN detection latency: flagged `startSeconds` is mid-note, not the actual attack. +30ms puts the video at the note onset. |
| Octave-aware intonation grouping | B4 and B5 have different pitch issues; grouping by pitch class (stripping octave) merged them incorrectly. |
| patternDetection.ts uses pre-specified tests | No unsupervised correlation search — avoid spurious correlations from small samples. All tests pre-specified; gate on n ≥ 8 + confidence ≥ 0.4. |
| SSH alias for git remote | Multiple GitHub accounts require SSH alias `github-personal` in remote URL. This is intentional. Tools needing standard URL: add `git remote add github https://github.com/marvalarva2929/stringai.git` as a second remote. |

---

## Environment Variables

```
EXPO_PUBLIC_SUPABASE_URL=
EXPO_PUBLIC_SUPABASE_ANON_KEY=
EXPO_PUBLIC_REVENUECAT_API_KEY_IOS=
EXPO_PUBLIC_REVENUECAT_API_KEY_ANDROID=
```

## External Services

- [ ] Supabase project created at supabase.com (run `001_initial_schema.sql`)
- [ ] RevenueCat project + products configured in App Store Connect / Google Play Console
- [ ] EAS account linked (`eas login`)
- [ ] Roboflow project: 3-keypoint bow detector (`bow` class, kpt: tip/frog/contact) — for bow ML labeling
- [ ] Ultralytics account / local GPU for YOLOv8n-pose training

## Git Repository

- Remote: `git@github-personal:marvalarva2929/stringai.git`
- SSH alias `github-personal` is intentional (multi-account GitHub setup). Do not change.
- HTTPS equivalent: `https://github.com/marvalarva2929/stringai.git` (for tools that need it)
