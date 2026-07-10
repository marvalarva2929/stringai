# Practice Feedback Consolidation Plan

## Status

- **Phase 0 — done.** `intonation_fatigue` fixed + covered; the three note-based
  tests now have regression coverage; progress store keyed by `planId` with v1→v2
  migration; `phraseFeatures` persisted.
- **Phase 2 — done.** `buildPracticeBlocks` folds corroborating evidence instead of
  dropping it; unmeasured evidence can corroborate but never seeds a technique
  block. Regression tests in `test/practicePlan.test.ts`.
- **Phase 1.1 / 1.2 / 1.4 — done.** `buildSessionEvidence` freezes per-session
  evidence at analysis time; persisted on `AnalysisResult.sessionEvidence` and in
  `metricHistory` (durable across restart). Plan prefers persisted evidence and is
  proven identical to re-derivation. Query layer `practiceIssues.ts`
  (`issuesForSession` / `issuesForPiece` / `issuesRecent`) with recurrence-boost +
  recency-decay merge, covered by `test/practiceIssues.test.ts`.
- **Phase 1.3 — done.** `buildPracticeEvidence` now aggregates through the shared
  query layer (`collectIssueSources` + `mergeIssues`), so the daily plan applies
  the same recurrence-boost + recency-decay as `issuesRecent` — one aggregation
  path, proven by a multi-session test where a recurring issue outranks an
  equal-base one-off through the whole plan. Clean-session cold-start bug fixed:
  `hasAnalyzedSessions` splits genuine cold start (record-a-baseline) from a clean
  session (maintenance blocks). Deleted the parallel `Issue[]` derivation
  (`buildIssues`, `ISSUE_INFO`, `foundationIssues`/`refinementIssues`) — it had
  zero UI/persistence/LLM consumers. `Issue`/`RecommendedExercise` types are now
  orphaned; left in place, low-value to remove.
- **Phase 3 — mostly done (grounding core complete; live wiring blocked on Supabase).**
  `practiceCuration.ts`: `groundCuratedPlan` enforces both guards from the
  experiment — hallucinated `issueId` → stripped/dropped; root cause resting only
  on non-`high` measurement quality → rejected — with deterministic fallback when
  the LLM output is unusable. `PracticeEvidence` now carries `measurementQuality`
  to power the quality guard. `parseCuratedResponse` maps the Edge payload;
  `candidatesFromBlocks` expresses deterministic blocks in the curated shape.
  `LLMFeedback.practicePlan[]` deleted (type + client parse + Edge schema). Edge
  Function schema/prompt rewritten to root-causes-first with mandatory
  verbatim-`issue_ids`; the frozen issue set is now sent in `CoachingInput`.
  Covered by `test/practiceCuration.test.ts`.
  - **Remaining in 3:** persist the curated plan under its `planId` and render it
    (3.5) — needs the session-plan surface (Phase 4) and a live Edge deploy to
    verify end to end. Model choice (3.7) left at `claude-haiku-4-5`; the
    structural guards now catch the Haiku failure modes, so an upgrade is a
    cost/quality call for you, not a correctness requirement.
- **Phase 4 — done (incl. 3.5 entry point).** `CurrentPiece` on the profile with
  `pinPiece`/`setPieceGoals`/`unpinPiece`. `computePracticePlan` takes a `scope`
  (`daily` | `session` | `piece`) filtering the window and stamping a distinct plan
  id, so the three plans coexist without colliding on progress. Hooks
  `usePracticePlan(scope)` / `useSessionPracticePlan` / `usePiecePracticePlan`.
  Screens: extracted the shared `PracticePlanView`; `train.tsx` (daily) and the new
  `app/practice/plan.tsx` (piece/session) both render it; runner + complete screens
  thread scope through routing so progress stays isolated. Home pinned-piece card;
  pin toggle on the piece screen; results `onDone` now routes into the
  session-scoped exercises (the submit→drill→resubmit loop). Verified by a full
  Metro iOS bundle (HTTP 200, no resolution failures, routes wired).
  - **Still needs a live pass:** the grounded curated plan (Phase 3) isn't yet the
    driver of the session plan render — it currently uses the deterministic
    candidates. Wiring the curated output in needs a Supabase deploy to exercise.
- **Phase 5 — harness done; corpus needs recording.** `test/audioCorpus.test.ts`
  runs real .wav takes through the actual audio DSP (`dsp.ts`) → note fusion → L8
  detection and emits a per-label confusion matrix, asserting each fault is
  perceived. A synthetic machinery self-test always runs (notes form, detection
  executes). Recording spec + labels in `test/fixtures/corpus/README.md`. WAV
  reader shared (`test/wav.ts`, deduped from the tone test).
  - **Needs you:** record the labelled takes (`intune`, `flat3rdfinger`,
    `flattendency`, `sharptendency`, `fatigue`, `monotone`) — I can't produce
    violin audio. Bow faults need on-device video-frame export (separate harness).

## Perception finding (from building Phase 5)

Running synthesized audio through the real DSP exposed a gap the reasoning tests
can't: a planted **−30-cent** 3rd finger is **measured as ~−14 cents** (pitch
detection biases toward equal temperament) — *below* `finger_accuracy_gap`'s
15-cent threshold, so a real fault can go undetected. Pushed to −55 cents, the
note **misclassifies into the neighbouring semitone**. The L8 thresholds are
tuned on hand-written note events; they need calibrating against what the DSP
actually measures from sound. That calibration is exactly what the corpus (once
recorded) provides.

## Detection coverage (added)

`test/detectionCoverage.test.ts` — a matrix that plants known issue sets in
hand-built note events + signals and asserts `runPatternDetection` recovers exactly
them. Covers each L8 test, the cross-signal cases (finger×string tendency,
bow-position×tone, bow-position×dynamics, time×error fatigue), the two-entangled-
causes disentanglement (flat 3rd finger + independent fatigue), confound rejection
(pure fatigue not read as a finger gap; uniform tone not read as a bow problem), and
a clean session firing nothing.

Note: the whole `SessionAssessment` payload except `playerCategory` (technique
summary, posture metrics, key observations) still has no UI consumer — a larger
dead-code question deferred, since it is persisted and part of pipeline contracts.

## Problem

The app has **three independent engines** that each answer "what should this student work on":

| Engine | Produces | Consumed by |
|---|---|---|
| L9 `sessionAssessment` | `foundationIssues` / `refinementIssues` (`Issue[]` + exercises) | Results UI |
| L10 `llmFeedback` (Claude) | `overallTake`, `items[].exercise`, `phraseFeedback[]`, `practicePlan[]` | Results UI |
| `computePracticePlan` | `PracticeEvidence` → ranked → `PracticeBlock[]` | Train tab |

They read overlapping inputs, can disagree, and nothing reconciles them. Claude's
`practicePlan[]` is grounded in nothing persisted.

**Target architecture:** issues are the single source of truth. Selection is negotiable.

- L1–L8 observe. Output is a deterministic, persisted `PracticeEvidence[]` ("issues").
- One query layer over the issue store: `issuesForSession`, `issuesForPiece`, `issuesRecent`.
- One block builder over any issue set. The *only* thing that varies between
  post-session exercises and the daily plan is the **evidence window**.
- The LLM curates and writes copy. It never invents an issue. Every block it emits
  cites `issueIds` that exist in the store.

This yields the intended loop: **submit song → exercises → resubmit → exercises → improve**,
plus a pinned piece with user-stated goals, without duplicate feedback surfaces.

---

## Evidence base

A synthetic session with three **planted** root causes was run through the real
`runPatternDetection`, then the resulting findings were given to six Claude instances
(fixtures reproducible via seeded PRNG).

Planted: (A) bow arm never carries weight past the middle, (B) 3rd finger sits flat,
(C) genuine fatigue drift.

Findings:

1. **L8 already does root-cause synthesis.** `upper_bow_tone_degradation` and
   `tip_dynamic_ceiling` are cross-signal tests that ship causal hypotheses. They
   recovered causes A and B deterministically. The LLM is not needed for this.
2. **`intonation_fatigue` is dead code.** It never fires. Cause C was invisible.
3. **The block builder, not L8, destroys advice quality.** Every LLM variant — including
   Haiku on distilled findings — beat the algorithm's baseline plan.
4. **Haiku on raw data is unsafe.** It fabricated note indices and group sizes, missed
   the 78% frog camping and the 45% tip volume drop, and filed the (computable) fatigue
   under `notObservable`. This empirically vindicates the L1–L8 distillation.
5. **The LLM is nondeterministic about epistemic status.** Two identical Haiku runs
   disagreed on whether wrist collapse is a root cause (`confidence 0.76`) or
   unsubstantiated speculation. Both Haiku runs promoted a `measurementQuality: 'proxy'`
   metric to a root cause; Opus refused, citing the proxy quality.
6. **Candidate drills anchor weaker models.** Haiku shown the algorithm's candidates
   inherited its redundant `G4 Landing` + `G major Scale Lock-In` pair. Haiku *not*
   shown them produced four distinct blocks.
7. **Opus on raw data found cause C exactly** (`first20 = 19.5c → last20 = 58.7c`), but
   rejected the *true* 78% camping finding as "weakly supported". LLM and deterministic
   tests catch different things; neither dominates.

Consequences for design:
- Raw data never enters the request path. Opus-on-raw is an **offline test-discovery
  instrument**: its output is new L8 tests, not runtime advice.
- LLM root causes must be rejected unless cited evidence is `measurementQuality: 'high'`.
- LLM output is persisted once per `planId` and never regenerated on render.
- Deterministic candidates are the fallback, so free/offline users get a plan.

---

## Phases

### Phase 0 — Prerequisites (needed regardless of everything else)

- **0.1** Fix `intonation_fatigue`. `normalizedSlope = slope / avgError` has units of
  1/sec (~0.01) and is fed to `confidenceFromEffect` as a unitless 0–1 effect size.
  Reaching `confidence >= 0.4` requires ~845 cents of drift on a 140s session.
- **0.2** Add regression tests for the three uncovered note-based tests
  (`intonation_fatigue`, `finger_accuracy_gap`, `pitch_tendency`).
  `test/patternDetection.test.ts` currently covers only the four bow tests.
- **0.3** Key `usePracticeProgressStore` by `planId` (`Record<planId, string[]>`).
  Today a single `planId` field silently wipes completions when the plan changes —
  session-scoped and daily plans cannot coexist.
- **0.4** Persist `phraseFeatures` (L7) on `AnalysisResult`. It is plain serializable
  data, currently computed and handed only to Claude, so the `phrase_repair` block type
  can never receive a real phrase window.

### Phase 2 — Fix the candidate generator (before any LLM curation)

- **2.1** `buildPracticeBlocks` must **attach corroborating evidence** to an existing
  block instead of dropping it. Today `usedTypes`/`usedMetrics` discard
  `upper_bow_tone_degradation` and `tip_dynamic_ceiling` — the two findings that explain
  *why* the student camps at the frog.
- **2.2** Do not emit blocks for evidence with no underlying measurement.
  `vibrato:primary` ranks `p=106 c=0.75` off `eligibleCount` alone while
  `vibratoAnalysis.notes` is empty.
- **2.3** Do not let one evidence item produce two competing blocks that crowd the budget
  (`pitch_landing` + `scale_lock` from the same `pitch_note`).

### Phase 1 — Issues as the single source of truth

- **1.1** Move `buildPracticeEvidence` into `runSessionPipeline` as the real L9.
  Add `pieceId`. Persist `sessionEvidence: PracticeEvidence[]` on `AnalysisResult`.
  It is computed at *render* time today, which is exactly why surfaces drift.
- **1.2** Query layer: `issuesForSession(id)`, `issuesForPiece(pieceId, window)`,
  `issuesRecent(window)`. Same table, different `WHERE`.
- **1.3** Re-point the results UI and `sessionAssessment` at stored issues. Delete the
  parallel `Issue[]` derivation (`sessionAssessment.ts` duplicates `exercisesForMetric`).
- **1.4** Merge across the window with recency decay + "still not fixed" boost. A
  recurring issue `id` across sessions of the same piece **is** the improvement signal.

### Phase 3 — LLM curation, grounded

- **3.1** Claude receives issues + candidates, returns `PracticeBlock[]` with mandatory
  `issueIds`. Reject blocks citing unknown ids.
- **3.2** Reject root causes resting on non-`high` `measurementQuality`.
- **3.3** Have the model commit root causes *before* it sees candidates (finding 6).
- **3.4** Drop `LLMFeedback.practicePlan[]`.
- **3.5** Persist the curated plan under its `planId`. Never regenerate on render.
- **3.6** Deterministic fallback = Phase 2 candidates.
- **3.7** Reconsider `claude-haiku-4-5` for the curation call; the epistemic-judgment gap
  was the largest in the experiment.

### Phase 4 — Pinned piece

- **4.1** `currentPiece` on profile: `pieceId`, user-written `goals`, `startedAt`.
- **4.2** Home card; "warm up first?" prompt on open, drawn from `issuesForPiece`.
- **4.3** Post-session plans scoped `planId = session:<sessionId>`;
  daily stays `daily:<date>`. Both coexist once 0.3 lands.

### Phase 5 — Real fault corpus (perception, not reasoning)

All of the above tests *reasoning* over hand-written `NoteEvent[]`. Nothing tests whether
L1–L3 can **perceive** a flat 3rd finger. Extend the existing
`test/fixtures/tone/{label}__{take}.wav` convention (16 real labeled takes, asserted as
layer 2 in `toneAnalysis.test.ts`) to the other detectors:

`flat3rdfinger__` / `intune__`, `frogcamp__` / `fullbow__`, `tipthin__`, and a genuinely
degrading 4-minute `fatigue__` take. Bow labels need video.

This buys a per-test confusion matrix, which currently exists for **zero** of the eight
tests. A single real fatigue take would have caught 0.1 the day it shipped.

---

## Order of execution

Phase 0 → Phase 2 → verify against the fixture → Phase 1 → Phase 3 → Phase 4 → Phase 5.

Phase 2 provably improves advice with no LLM and no new infrastructure. Phase 1 is the
structural change that makes "one source of truth" real. Phase 3 only makes sense on top
of a candidate generator that isn't broken.
