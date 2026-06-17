# StringAI — Analysis Architecture

## Overview

The analysis pipeline has five distinct layers. Each layer has a single responsibility and a clean interface to the next. The key design principle is **separation of measurement from interpretation**: the first three layers are deterministic code, the fourth is statistical pattern detection, and the LLM touches only the final coaching step where natural language and judgment are actually needed.

```
Video + Audio
     │
     ▼
┌─────────────────────────────────┐
│  LAYER 1: Signal Extraction     │  On-device, parallel, deterministic
└─────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────┐
│  LAYER 2: Signal Fusion         │  On-device, NoteEvent[] output
└─────────────────────────────────┘
     │
     ├──────────────────────────────────────────────────────────┐
     ▼                                                          ▼
┌──────────────────────┐                          ┌────────────────────────┐
│  LAYER 3: MetricScore│                          │  LAYER 4: Statistical  │
│  (deterministic,     │                          │  Pattern Detection     │
│   Progress tab)      │                          │  (StatisticalFinding[])│
└──────────────────────┘                          └────────────────────────┘
                                                           │
                                                           ▼
                                                  ┌────────────────────────┐
                                                  │  LAYER 5: LLM Coaching │
                                                  │  (Edge Function)       │
                                                  └────────────────────────┘
```

---

## Layer 1: Signal Extraction

Runs in parallel immediately after recording stops. All on-device. No network calls.

### 1a. Audio DSP (`src/services/audioEngine.ts`)

| Output | How | Key parameters |
|---|---|---|
| `PitchFrame[]` | YIN autocorrelation | 1024-sample window (~23ms), **20ms hop** (reduced from 50ms for fast-passage accuracy) |
| `ToneFrame[]` | FFT → fundamental/total power ratio | 50ms windows, Hann-windowed |
| `RmsFrame[]` | RMS envelope | 20ms windows |
| `OnsetEvent[]` | Energy flux threshold on RMS | Min 80ms gap between onsets |

The 20ms hop is critical. At 50ms hop, 16th notes at 160 BPM get 1–2 pitch readings per note. At 20ms hop they get 4–5 — enough for reliable detection with no other changes to the algorithm.

### 1b. MediaPipe Pose + Hands

Video is sampled at 2fps. Each sampled frame produces:

| Output | Source | Landmarks |
|---|---|---|
| Body pose | MediaPipe Pose | 33 landmarks: shoulders, elbows, wrists, nose |
| Left hand | MediaPipe Hands | 21 landmarks: wrist, MCP joints, fingertips |
| Right hand | MediaPipe Hands | 21 landmarks |

Output: `FrameKeypoints[]` — one per sampled frame, timestamped.

### 1c. Bow Detector (ML model, planned)

A lightweight object detection model (YOLO-nano or MobileNetV2-SSD) trained on labeled violin video. Runs on the same 2fps frames as MediaPipe.

**Labels needed**: bounding box of bow stick in each frame (~2,000–5,000 labeled frames sufficient for YOLO-nano).

**Outputs per frame**:
```typescript
interface BowFrame {
  timestamp: number
  tipX: number        // 0-1 normalized, bow tip position
  tipY: number
  frogX: number       // bow frog position
  frogY: number
  confidence: number  // 0-1, model confidence
}
```

From tip + frog: bow angle (vector direction), bow length in frame, which portion of bow is over the string contact point.

**Model size when INT8-quantized**: ~2–4 MB. Fast enough for 2fps on-device.

### 1d. Bridge Top Detector (traditional CV, planned)

The top bar of the violin bridge is the critical spatial anchor for all bow position measurements. Bow contact point is defined as distance from this line.

**Approach**: Traditional CV is sufficient here — no ML model required.
1. Use body landmarks from MediaPipe to estimate the region of interest (roughly: below chin, above tailpiece, near frame center)
2. Run Canny edge detection on the ROI
3. Hough line transform looking for short near-horizontal line segments
4. Bridge top = the highest such line in the ROI (strings run above, body wood below)

**Output** (computed once per session, or re-estimated every 30 frames):
```typescript
interface BridgeAnchor {
  topBarY: number     // normalized y-coordinate of bridge top bar
  topBarXLeft: number
  topBarXRight: number
  confidence: number
}
```

**Camera angle note**: From a front-facing selfie camera, bridge visibility depends on violin tilt. Players holding the violin more parallel to the floor will show more bridge; those tilting away may partially occlude it. `confidence` gates whether bridge measurements are used in downstream analysis. If confidence < 0.6, bow contact point is marked as unavailable for that session and the wrist proxy is used as fallback.

---

## Layer 2: Signal Fusion → `NoteEvent[]`

This is the core new component. It takes all four extraction streams, joins them by timestamp, and segments the session into individual notes — each with all relevant signals attached.

**File**: `src/lib/noteFusion.ts` — audio-only phase built; video/pose fields added after MediaPipe.

### Segmentation

Currently uses pitch-class-transition segmentation (built). Final design joins onset events from audioEngine as boundaries with pitch stability confirmation:
1. Each `OnsetEvent` marks a note start
2. The note continues until the next onset or until pitch changes by > 50 cents (for legato passages)
3. Minimum note duration: 40ms (shorter events are discarded as artifacts)
4. For each segment: compute median pitch (more robust than mean against edge noise)

### Per-note signal joining

For each note segment:

**From audio**:
- `pitchHz`: median YIN frequency over the segment
- `noteName`: nearest chromatic note (e.g., "F#4")
- `centsDeviation`: signed deviation from nearest note (+ = sharp, − = flat)
- `fundamentalRatio`: mean tone quality (FFT) over the segment duration
- `dynamicLevel`: mean RMS, normalized 0–1 relative to session max

**Inferred from pitch**:
- `string`: which violin string ('G' | 'D' | 'A' | 'E') from frequency range
  - G-string: 196–294 Hz
  - D-string: 294–440 Hz  
  - A-string: 440–659 Hz
  - E-string: 659 Hz+
- `inferredFinger`: semitones above open string → finger position in first position
  - 0 semitones → open string
  - 1–2 → 1st finger
  - 3–4 → 2nd finger
  - 5–6 → 3rd finger
  - 7–8 → 4th finger
- `positionGroup`: frequency-based position estimate ('first' | 'third' | 'fifth' | 'higher')

**From video (MediaPipe)** — nearest frame by timestamp:
- `wristCollapsed`: boolean, from left hand landmark angle
- `shoulderRaised`: boolean, from pose landmark y-difference
- `bowArmLevel`: right elbow y relative to shoulder

**From bow detector** — nearest frame by timestamp:
- `bowContactPoint`: 0 (frog) to 1 (tip), computed from tip position relative to estimated string midpoint
- `bowAngle`: degrees from perpendicular to string axis

**From bridge detector**:
- `bowDistanceFromBridge`: normalized distance of bow contact from bridge top bar
  - < 0.15 → sul ponticello zone
  - 0.15–0.6 → normal zone
  - > 0.6 → sul tasto zone

**Computed tags**:
- `distanceFromCrossing`: how many notes since the last string crossing (null if no crossing in previous 5 notes)
- `phrasePosition`: 0–1, position within the currently detected phrase (0 = onset, 1 = end)
- `phraseDurationSeconds`: total duration of the phrase this note belongs to

### `NoteEvent` schema

```typescript
interface NoteEvent {
  // Timing
  startSeconds: number
  endSeconds: number
  durationSeconds: number

  // Pitch identity
  pitchHz: number
  noteName: string            // "F#4"
  string: 'G' | 'D' | 'A' | 'E'
  inferredFinger: 0 | 1 | 2 | 3 | 4
  positionGroup: 'first' | 'third' | 'fifth' | 'higher'

  // Pitch accuracy
  centsDeviation: number      // signed: + sharp, − flat
  absCentsDeviation: number
  inTune: boolean             // |cents| ≤ 25

  // Tone & dynamics
  fundamentalRatio: number    // 0–1, higher = cleaner tone
  dynamicLevel: number        // 0–1, normalized RMS

  // Bow signals (null when detector unavailable)
  bowContactPoint: number | null    // 0=frog, 1=tip
  bowAngle: number | null           // degrees
  bowDistanceFromBridge: number | null
  bowZone: 'sul_ponticello' | 'normal' | 'sul_tasto' | null

  // Left hand (null when MediaPipe unavailable)
  wristCollapsed: boolean | null
  shoulderRaised: boolean | null

  // Context tags
  distanceFromCrossing: number | null
  phrasePosition: number            // 0–1 within phrase
  phraseDurationSeconds: number
}
```

**Typical session size**: 200–600 note events. At ~60 tokens per event in compact JSON: 12,000–36,000 tokens. This is small enough to send to the LLM directly but as established, we don't — the statistical layer processes it first.

---

## Layer 3: `MetricScore[]` (Deterministic Scoring)

Computed from `NoteEvent[]` using the existing scoring pipeline in `audioEngine.ts` and `poseScoring.ts`, modified to consume `NoteEvent[]` as input rather than raw pitch frames and landmarks separately.

These scores are:
- **Deterministic**: same input always produces same output
- **Comparable across sessions**: the Progress tab trend charts depend on this
- **Not sent to the LLM**: they're for the UI and stored in Supabase only

The LLM never sees these numbers directly. It sees the `StatisticalFinding[]` from Layer 4 instead, which are more meaningful and specific.

---

## Layer 4: Statistical Pattern Detection

**File**: `src/lib/patternDetection.ts` (to be created)

Takes `NoteEvent[]` as input. Runs ~20–25 pre-specified tests, each looking for a specific known pattern. Each test either fires or doesn't. This is the checklist-of-known-faults layer.

### What a test looks like

```typescript
interface StatisticalFinding {
  testId: string
  fired: boolean
  severity: 'minor' | 'moderate' | 'significant'
  confidence: number           // 0–1, based on sample size + effect magnitude
  summary: string              // human-readable description of what was found
  evidence: {
    groupA: { label: string; value: number; n: number }
    groupB: { label: string; value: number; n: number }
    effectSize: number         // ratio or slope or correlation
  }
  timestamps: { startSeconds: number; endSeconds: number }[]
}
```

### The test suite

**Intonation tests**
| Test ID | What it detects | Correlation it looks for |
|---|---|---|
| `crossing_intonation_drop` | Notes go out of tune after string crossings | `avg(absCentsOff \| distanceFromCrossing ≤ 1)` vs. baseline |
| `position_accuracy_gap` | Third/fifth position significantly worse than first | `inTuneRate` by `positionGroup` |
| `finger_accuracy_gap` | One specific finger consistently worse | `avg(absCentsOff)` by `inferredFinger` |
| `pitch_tendency` | Systematic sharpness or flatness per finger/string | `mean(centsDeviation)` — signed, detects directional bias |
| `intonation_fatigue` | Pitch drifts out of tune in later portion of session | Linear regression of `absCentsOff` on `startSeconds` |

**Bow technique tests**
| Test ID | What it detects | Correlation it looks for |
|---|---|---|
| `upper_bow_tone_degradation` | Tone quality worse in upper bow vs. middle/lower | `fundamentalRatio` by `bowContactPoint` zone |
| `tip_dynamic_ceiling` | Volume fails to increase in upper bow during forte attempts | `dynamicLevel` vs. `bowContactPoint`, conditioned on rising dynamic intent |
| `sul_tasto_drift` | Bow spends too much time near fingerboard | `bowZone` histogram — sul_tasto proportion |
| `phrase_end_pressure` | Tone degrades consistently toward end of long phrases | Linear regression of `fundamentalRatio` on `phrasePosition` within phrases > 2s |
| `bow_distribution_narrow` | Player using less than half the bow length | `bowContactPoint` range (max − min across session) |

**Left hand tests**
| Test ID | What it detects | Correlation it looks for |
|---|---|---|
| `wrist_collapse_intonation` | Wrist collapse correlates with pitch going flat | Pearson correlation: `wristCollapsed` × `centsDeviation` |
| `wrist_collapse_finger` | Wrist collapse happens more on specific fingers | `wristCollapsed` rate by `inferredFinger` |
| `position_shift_timing` | Intonation poor in first 2 notes after a position shift | `absCentsOff` by position change events |

**Posture and stamina tests**
| Test ID | What it detects | Correlation it looks for |
|---|---|---|
| `shoulder_raise_onset` | Shoulder tension rises during difficult passages | `shoulderRaised` rate in high-note-density windows |
| `dynamic_range_narrow` | Player has a small dynamic range (mono-dynamic) | `max(dynamicLevel) / min(dynamicLevel)` across session |
| `rhythm_rush_on_difficulty` | Tempo rushes during dense passages | IOI variance conditioned on note density |

**Confidence gating**: tests with fewer than 8 data points in any group, or where the underlying signals were unavailable (e.g., bow detector not present), are marked `confidence < 0.4` and not passed to the LLM. Low-confidence findings are stored in Supabase for future analysis once more data accumulates.

### Why pre-specified tests and not unsupervised discovery

A completely open-ended statistical search over 30+ NoteEvent fields would produce spurious correlations — with 300 notes and 15 fields, you can always find something that correlates with something. Pre-specified tests avoid this by committing to what you're looking for before looking. Each test is grounded in a known physical mechanism that violin teachers recognize.

Novel issues are still catchable via anomaly detection: a separate pass computes statistical outliers in the NoteEvent distribution (notes that are extreme in multiple dimensions simultaneously) and surfaces these as `type: 'anomaly'` findings. These get passed to the LLM with lower confidence and a note that they're unexpected.

---

## Layer 5: LLM Coaching (Supabase Edge Function)

### What the LLM receives

Total input: approximately 3–6 KB.

```typescript
interface CoachingInput {
  // Player and session context
  playerProfile: {
    skillLevel: 'beginner' | 'intermediate' | 'advanced'
    sessionsTotal: number
    instrumentYearsPlaying?: number
  }
  piece?: {
    title: string
    composer?: string
    style?: string   // "baroque" | "romantic" | "contemporary" | "folk"
  }
  sessionOverview: {
    durationSeconds: number
    noteCount: number
    overallScore: number       // for context only, not the focus
  }

  // What was found this session
  findings: StatisticalFinding[]  // only fired=true, confidence ≥ 0.4

  // Historical context (from Supabase)
  historicalPatterns: {
    findingId: string
    sessionsFired: number       // how many of last 8 sessions this appeared
    trend: 'improving' | 'stable' | 'worsening'
  }[]
  metricTrends: {
    metric: string
    direction: 'improving' | 'declining' | 'plateau'
    changeOverLastNSessions: number
  }[]
}
```

### What the LLM is asked to do

The prompt gives the LLM two jobs:

**Job 1: Prioritize**. Not all findings are equally important. A wrist collapse that's been present for 6 sessions is more important than a slightly narrow dynamic range. A finding that correlates with two other findings (wrist collapse + flat 4th finger = one root cause) should be consolidated, not listed as two separate issues. The LLM decides what the one or two things are that this player most needs to work on right now.

**Job 2: Explain causally and specifically**. Not "your intonation needs work." The LLM has enough information to say *why* — "your F# on the D-string lands flat specifically when you play it with your 4th finger, and on 14 of 16 occurrences your wrist was collapsed at the same moment. The collapse is shortening your 4th-finger reach." This is the coaching quality the app is aiming for.

### What the LLM produces

```typescript
interface CoachingReport {
  overallTake: string           // 1–2 sentence summary of the session
  items: CoachingItem[]         // 2–3 items maximum
  generatedAt: string
}

interface CoachingItem {
  title: string                 // e.g., "4th finger reach on D-string"
  observation: string           // what the data shows, in plain language
  explanation: string           // physical/mechanical reason why
  exercise: string              // specific practice prescription
  timestamps: { startSeconds: number; endSeconds: number }[]
  relatedFindings: string[]     // which testIds contributed
}
```

### Why 2–3 items maximum

More than 3 coaching items is counterproductive. A real teacher ends a lesson with "work on this one thing this week." Giving a student 7 things to fix is demoralizing and they'll work on none of them. The LLM's prioritization job is real — it has to decide what matters most given the player's level and history.

---

## Data Storage (Supabase)

```sql
-- Per-session data
sessions (id, user_id, piece_id, recorded_at, duration_seconds, overall_score)
metric_scores (session_id, metric_key, score, delta)

-- New tables
note_events (session_id, start_seconds, end_seconds, note_name, string,
             inferred_finger, cents_deviation, fundamental_ratio,
             dynamic_level, bow_contact_point, wrist_collapsed,
             distance_from_crossing, phrase_position)

statistical_findings (session_id, test_id, fired, severity, confidence,
                      summary, evidence jsonb, timestamps jsonb)

coaching_reports (session_id, overall_take, items jsonb, generated_at)
```

**NoteEvent storage enables**:
- Historical queries: "has F# been flat across multiple sessions?"
- Pattern tracking: "does `crossing_intonation_drop` fire every session or just this one?"
- Future ML: stored NoteEvent history becomes training data for a future classifier

---

## Build Status

| Component | Status | Notes |
|---|---|---|
| Audio DSP (YIN, FFT, RMS, onset) | ✅ Built | YIN hop still 50ms in audioEngine.ts; reduce to 20ms for fast-passage accuracy |
| `src/lib/noteFusion.ts` | ✅ Built (audio-only) | PitchFrame[] → NoteEvent[]; video/pose fields added after MediaPipe |
| Intonation analysis (octave-aware) | ✅ Built | Groups by full note name incl. octave; B4/B5 are separate entries |
| `InlineVideoPlayer` (full-featured) | ✅ Built | Speed controls, note marker scrubber, frame-accurate seeks, note overlay |
| Zustand persist middleware | ✅ Built | phase/currentResult/sessionHistory/metricHistory persist across restarts |
| `poseScoring.ts` scoring logic | ✅ Built | Needs MediaPipe data wired |
| MetricScore types and Supabase schema | ✅ Built | Schema not yet run on live project |
| `llmFeedback.ts` | ✅ Stub | Replace with real edge function |
| MediaPipe integration | ⏳ Planned | Next major milestone |
| `src/lib/patternDetection.ts` | ❌ Not built | ~20 statistical tests |
| Bow detector ML model | ❌ Not built | ~2,000 labeled frames needed |
| Bridge top detector (CV) | ❌ Not built | Traditional CV, no training data |
| Supabase `note_events` table | ❌ Not built | New migration needed |
| Real LLM edge function | ❌ Not built | Replaces local stub |

---

## What the Architecture Gets Right

**Determinism where it matters**: MetricScore numbers used for trend tracking never have an LLM in the loop. The Progress tab's trend line means something because it's computed the same way every session.

**LLM where it matters**: The LLM never touches raw numbers. It receives a handful of pre-interpreted findings in plain English and writes coaching. It can't hallucinate a "pattern" because the patterns are found by code first. It can connect findings in ways that weren't pre-programmed — noticing that two separate findings have a common physical cause — which is genuinely where LLM reasoning adds value.

**Graceful degradation**: Every signal has a `null` path. No bow detector? `bowContactPoint = null` and bow-dependent tests don't fire. No MediaPipe? `wristCollapsed = null`. Audio-only analysis still catches pitch, tone, dynamics, and rhythm patterns. The app is useful before every component is built.

**Grows over time**: Stored `NoteEvent[]` history accumulates. Patterns that only emerge over many sessions (chronic 4th-finger flatness, position-shift degradation worsening as the student attempts harder repertoire) become detectable in later sessions even if they weren't obvious in session one.

---

## Session Chat (Layer 6)

The automated coaching pipeline (Layers 1–5) produces a `CoachingReport` at the end of each session. Session Chat is an optional follow-up: a multi-turn conversation grounded in that session's data, where the student can ask questions, provide context, or push back.

### Why tool-use is right here

In the automated pipeline, tool-use was rejected: the LLM calling back into a "calculator" introduces latency and inconsistency — bad for a fully automated process that should feel instant. Session Chat is different: there is a human waiting, responses don't need to be instantaneous, and the LLM genuinely doesn't know in advance what the student will ask. Tool-use is appropriate precisely because the questions are open-ended and unpredictable.

### Tools the LLM has in chat

```typescript
query_metric_window(metric: string, startSeconds: number, endSeconds: number): number
get_findings(minSeverity?: 'low' | 'medium' | 'high'): StatisticalFinding[]
get_finding_history(testId: string, lastNSessions: number): { fired: boolean; severity: number }[]
get_coaching_report(): CoachingReport
get_notes(startSeconds: number, endSeconds: number): NoteEvent[]
```

### The key interaction

The student says "that was me trying to add phrasing" in response to the LLM flagging upper-bow usage. The LLM cross-checks: did the dynamic also rise in those passages? Did the note intensity match a phrase arc? If yes, the phrasing intent was plausible; if no, the student may have rationalized a bad habit. The LLM updates its interpretation and explains what it found.

Other common queries:
- "Which measure kept tripping me up?" → LLM queries notes in timestamp buckets, finds error clusters
- "Am I worse on the E string than the A string?" → LLM queries intonation by string
- "Is my tone getting worse as the session goes on?" → LLM queries first half vs. second half
- "Am I actually improving?" → LLM uses `get_finding_history` across sessions

### Architecture

Each chat turn is a Supabase Edge Function call. The function receives `sessionId`, `userId`, and `messages[]` (full conversation history). The session's `CoachingReport` is in the system prompt as baseline context. If Claude calls tools, the function executes them against `note_events` and `statistical_findings`, feeds results back to Claude, then returns the final reply.

### Supabase schema

```sql
chat_sessions (id, user_id, session_id, started_at, last_message_at)
chat_messages (id, chat_session_id, role, content, tool_calls jsonb, created_at)
chat_memory (id, user_id, piece_id, summary, created_at)
```

After each chat, an Edge Function summarizes key points the student raised (intent to phrase a passage, struggling with a specific shift) into `chat_memory` entries, injected into future conversations for the same piece so the LLM doesn't start cold.

---

## Phrasing and Stylistic Analysis

Phrasing and stylistic advice require a different kind of analysis than technique metrics. Technique has right/wrong answers. Style is about intentional variation, musical context, and expression within appropriate bounds.

### Phase 1: DSP Phrasing Detection (build with pattern detection)

Phrasing is detectable without an LLM. Core signal: slow-moving RMS envelope.

1. Compute RMS at 50ms windows, smooth with a 500ms rolling average
2. Detect phrase arcs — unsupervised: a phrase is a segment with a local RMS maximum (peak) bounded by lower-dynamic endpoints
3. Classify envelope shape: rising arc (crescendo), falling arc (diminuendo), arch (classical), flat, or choppy
4. Extract phrase statistics: duration, peak intensity, rise/fall ratio, bow usage at peak (wrist displacement), whether peak lands at musically expected moments

Each note carries `phrasePosition: 'beginning' | 'rising' | 'peak' | 'falling' | 'end'` in `NoteEvent`.

Pattern tests for phrasing (in `patternDetection.ts`):
- `phrase_peak_lacks_bow_speed` — phrase dynamic peak coincides with slow bow
- `phrase_end_pressure_maintained` — bow pressure stays high into phrase endings instead of releasing
- `short_phrase_durations` — phrase arcs shorter than ~4 seconds (no long-line thinking)
- `flat_dynamic_profile` — narrow dynamic range across the session (< 15 RMS units variation)

### Phase 2: LLM Style Interpretation (no new infrastructure needed)

Phrasing `StatisticalFinding[]` flow into the same coaching pipeline as technique findings. The LLM interprets them stylistically using the `piece.style` field on `CoachingInput` (`"baroque" | "romantic" | "contemporary" | "folk"`):

- Flat phrasing in a Romantic-era piece → LLM knows Romantic style calls for expressive dynamic arcs
- Arch phrasing executed at wrong moments → LLM can suggest repositioning the peak
- Baroque phrasing expectations are entirely different from Romantic — the LLM's style knowledge handles this without separate rules

### Phase 3: Multimodal Audio LLM (medium-term, 6–12 months)

For finer stylistic judgment — whether a student's phrasing "reads" to a real listener, whether tone color matches musical character — a multimodal audio model is more capable than text-based reasoning over statistics.

**When to trigger**: Only for flagged passages where phrasing statistics are ambiguous, or when the student asks "how does this sound?" in Session Chat. Send the flagged 15–30 second audio clip to a multimodal audio API.

**What it adds**:
- Actual tone color description ("your tone sounds pinched in the upper register, which works against the singing quality this passage needs")
- Nuance beyond statistics — timing micro-variations that create or destroy musical tension
- Cost-controlled by limiting to premium subscribers and only flagged passages, not every session

### Phase 4: Reference Performance Comparison (long-term)

Compare the student's dynamic envelope, tempo variation, and phrase arcs to a reference recording of the same piece. Comparison is envelope-to-envelope, not note-to-note, so it works across different tempos. Example output: "Professional recordings typically peak the dynamic 60–70% through the phrase. Yours peaks at 85% — the release comes too late."
