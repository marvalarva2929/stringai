# StringAI — Progress & Codebase Reference

## Current Status: Signal Fusion Built — Video Features Polish Next

Audio DSP, signal fusion (`noteFusion.ts` → `NoteEvent[]`), video replay with frame-accurate seeking, note-marker scrubber, speed controls, and octave-aware intonation analysis are all in place. State persists across app restarts via Zustand + AsyncStorage. User's current focus: finish remaining video features. Next after that: calibration clips, Supabase wiring, MediaPipe.

---

## Tech Stack

| Layer | Choice |
|---|---|
| Mobile | React Native + Expo (managed workflow) |
| Routing | Expo Router (file-based) |
| State | Zustand (+ persist middleware with AsyncStorage) |
| Backend | Supabase (Postgres + Auth + Storage + Edge Functions) — written, not yet connected |
| Payments | RevenueCat — wired, paywall commented out |
| Audio DSP | Custom on-device pipeline in `audioEngine.ts` |
| Video | Native iOS `VideoAudioExtractor` module (AVFoundation) |
| CV / Pose | MediaPipe — planned (Phase 7) |

---

## Completed

### Foundation
- [x] Expo + Expo Router project scaffolded (TypeScript, Zustand, NativeWind)
- [x] Navigation: `(auth)` group, `(tabs)` group, `paywall` modal, root auth gate
- [x] Onboarding flow — 5-slide carousel
- [x] Login + Register screens (UI complete, Supabase auth code written)
- [x] Core UI components: Button, Card, ScoreGauge, MetricCard, AnalysisTimeline
- [x] Instrument config system — violin defined, viola/cello stubs in place
- [x] `scripts/run.sh` + `scripts/build.sh`, `.env.example`

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
  - YIN pitch detection (1024-sample window ~23ms, **50ms hop** — reduce to 20ms is a planned improvement)
  - Cooley-Tukey in-place FFT + Hann window
  - RMS envelope + onset detection
  - 7 scored metrics: pitchAccuracy, intonationStability, toneQuality, bowSmoothness, rhythmAccuracy, dynamicControl, vibrato
  - Each scoring fn returns `MetricScore` with `events`, `occurrenceRate`, `observationSummary`, `flaggedTimestamps`
- [x] `modules/video-audio-extractor/` — native iOS module (AVFoundation); extracts PCM from any video URI (`ph://`, `file://`) and writes a WAV file

### Signal Fusion Layer
- [x] `src/lib/noteFusion.ts` — audio-only `NoteEvent[]` pipeline:
  - `segmentByPitch()`: pitch-class-transition segmentation (`MIN_DURATION_S=0.05`, `HOP_S=0.025`, `MAX_NULL_GAP=4`)
  - `filterArtifacts()`: removes short notes with neighbor-similarity guard (`SHORT_S=0.15`, `MAX_PASSES=6`)
  - `deriveIntonationAnalysis()`: groups by full note name incl. octave (B4/B5 are separate; was stripping octave — caused B4/B5 to merge)
- [x] `NoteEvent` carries: `startSeconds`, `endSeconds`, `noteName`, `pitchHz`, `centsDeviation`, `inTune`, `midiNote`; video/pose fields (string, finger, wristCollapsed, bowContactPoint) planned after MediaPipe
- [x] `PitchClassIssue.pitchClass` holds full note name incl. octave (e.g. "B4", "F#5"); `representativeMidi` provided so reference note lookups remain correct

### Video Replay Feature
- [x] `src/types/analysis.ts` — `videoUri?` and `noteEvents?` added to `AnalysisResult`; `exampleTimestamps?` added to `PitchClassIssue`
- [x] `src/lib/intonationAnalysis.ts` — surfaces up to 3 out-of-tune example timestamps per `PitchClassIssue`
- [x] `src/services/llmFeedback.ts` — deduplicates items by metricKey (pitchAccuracy + intonationStability → single intonation coaching card)
- [x] `src/components/analysis/VideoReplayModal.tsx` — full-screen slide-up modal player (used by standalone AnalysisTimeline)
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

### Video Analysis Stub
- [x] `runVideoAnalysis` — returns 4 mock video metrics with realistic structure; replaced by real scoring once MediaPipe is integrated
- [x] `src/lib/poseScoring.ts` — complete rule-based pose scoring: `FrameKeypoints` type, MediaPipe landmark index constants, 6 scoring functions (bowPlacement, bowAngle, bowArmLevel, bowDistribution, leftHandWrist, posture), `scorePoseMetrics()` entry point. No MediaPipe dependency — pure functions on landmark arrays.

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
                          Pure functions on FrameKeypoints[]; no MediaPipe dependency
    sessionAssessment.ts  Classifies player as foundation|refinement from metrics
    intonationAnalysis.ts analyzeIntonation(PitchFrame[]) → IntonationAnalysis
                          Surfaces exampleTimestamps (up to 3) per PitchClassIssue
    practicePlan.ts       Computes practice plan from MetricHistoryEntry[]
  services/
    audioEngine.ts        On-device DSP (~750 lines)
                          analyzeMediaFile(uri) → AudioAnalysisOutput
                          YIN pitch, FFT tone, RMS, onset, vibrato → 7 MetricScores
                          analyzeMediaFileWithDebug() → AudioDebugInfo (raw intermediates)
    analysis.ts           Pipeline orchestration + Supabase persistence
                          runAudioAnalysis() / runVideoAnalysis() (STUB)
                          buildSessionFeedback() / saveSession() / fetchSessionHistory()
    llmFeedback.ts        buildSessionFeedback() — local stub returning coaching text
                          Deduplicates by metricKey (pitch + stability → single card)
    auth.ts               Supabase auth helpers
    videoAudioExtractor.ts Native iOS module wrapper (AVFoundation)
  store/
    useAnalysisStore.ts   Phase state machine + session/metric history + sessionResultCache
                          Zustand persist middleware (AsyncStorage)
    useAuthStore.ts       Auth state + onboarding + playerCategory
    useUserStore.ts       UserProfile (instrument, skillLevel, playerCategory)
  types/
    analysis.ts           All analysis types (see Key Types below)

modules/
  video-audio-extractor/ Native iOS AVFoundation module: extractAudioFromVideo() → wavUri
pose-camera/             Native module: getPoseCameraView(), startRecording(), stopRecording()
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
}

interface NoteEvent {
  startSeconds: number;
  endSeconds: number;
  noteName: string;        // "F#4" (full name incl. octave)
  pitchHz: number;
  centsDeviation: number;  // signed: + sharp, − flat
  inTune: boolean;         // |centsDeviation| ≤ 25
  midiNote: number;
  // Video/pose fields: null until MediaPipe integrated
  wristCollapsed: boolean | null;
  shoulderRaised: boolean | null;
  bowContactPoint: number | null;  // 0=frog, 1=tip
  // etc. — see architecture.md for full planned schema
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
  noteEvents?: NoteEvent[];    // per-note fusion output; drives scrubber markers + intonation
}
```

### Analysis Pipeline (`analyze.tsx: processMedia`)

```
processMedia(uri, durationSec, isVideo)
  │
  ├─ persistVideo(uri) → videoUri
  │    file:// → copies to documentDirectory/sessions/ (10-session retention)
  │    ph://   → returned as-is (Photos library, directly playable)
  │    failure → falls back to original uri
  │
  ├─ runAudioAnalysis(uri) → AudioAnalysisOutput
  │    └─ analyzeMediaFile → analyzeWavFile
  │         ├─ detectPitches() → PitchFrame[]
  │         ├─ noteFusion.segmentByPitch + filterArtifacts → NoteEvent[]
  │         ├─ 7 scoring fns → MetricScore[] (events/occurrenceRate/summary)
  │         └─ deriveIntonationAnalysis(noteEvents) → IntonationAnalysis
  │              groups by full note name incl. octave; up to 3 exampleTimestamps each
  │
  ├─ runVideoAnalysis(uri) → MetricScore[]  ← STUB (mock data)
  │
  ├─ computeOverallScore(audio, video, weights)
  ├─ buildSessionAssessment(videoMetrics, userCategory) → SessionAssessment
  ├─ buildSessionFeedback(allMetrics, category, piece, prev, intonation) → LLMFeedback
  │
  └─ AnalysisResult { videoUri, noteEvents, ... } → Supabase + store cache
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
- MediaPipe pose detection (`runVideoAnalysis` is a stub returning mock MetricScores)
- Supabase project (migrations written, `.env` empty)
- RevenueCat paywall (commented out)
- LLM Edge Function (`buildSessionFeedback` uses local templates)
- Android audio extraction (iOS native module only)
- YIN hop size reduction in `audioEngine.ts` (still 50ms; `noteFusion.ts` uses 25ms for segmentation timestamps, but YIN detection hop is unchanged)
- `NoteEvent` video/pose fields: `wristCollapsed`, `bowContactPoint`, etc. (all null until MediaPipe)
- `sessionResultCache` for sessions from previous app runs (clears on restart; Supabase backfill will fix this)

---

## Key Architectural Decisions

| Decision | Rationale |
|---|---|
| No raw video to backend | Only keypoint JSON (~5 KB). Keeps per-analysis cost ~$0. |
| MediaPipe on-device | Privacy-first, no per-frame API cost. |
| Free tier = 2 lifetime analyses | Simple to enforce; never resets. |
| LLM tips via Edge Function | API key stays off client; easy to swap models. |
| Static tips as fallback | Results always show something even if LLM call fails. |
| 2 fps video sampling | Enough for bow tracking, keeps processing load light. |
| `poseScoring.ts` has no MediaPipe dependency | Pure functions on landmark arrays — unit-testable, swappable between MediaPipe versions. |
| `noteFusion.ts` audio-only first | NoteEvent[] pipeline delivers value (intonation, markers) before MediaPipe is integrated. |
| `sessionResultCache` in-memory only | Full results needed for session detail. Supabase will backfill on load once wired. |
| Zustand persist skips `sessionResultCache` | Cache can be large; `currentResult` alone is sufficient to show results on relaunch. |
| Frame-accurate seeks only on chip press | Drag-scrub uses fast/tolerant mode for UX; chip presses use `toleranceMillisBefore/After: 0` for precision. |
| +30ms seek offset on timestamp press | YIN detection latency: flagged `startSeconds` is mid-note, not the actual attack. +30ms puts the video at the note onset. |
| Octave-aware intonation grouping | B4 and B5 have different pitch issues; grouping by pitch class (stripping octave) merged them incorrectly. |

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
