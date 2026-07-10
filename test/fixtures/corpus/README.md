# Perception corpus

Real violin recordings that test whether the pipeline can **perceive** a fault
from sound — as opposed to every other test, which feeds hand-written
`NoteEvent[]` and only tests reasoning. Run with `npm run test:corpus`.

## Why this exists

The statistical detectors (`src/lib/patternDetection.ts`) are tuned against
hand-written note events. But those thresholds only matter if the audio DSP
actually *measures* the fault at the assumed magnitude. It doesn't always:

- A synthesized 3rd finger played 30 cents flat is **measured as ~14 cents** —
  pitch detection biases toward equal temperament — which is below
  `finger_accuracy_gap`'s 15-cent bar. The fault is real but invisible.
- Pushed to 55 cents, the note **misclassifies into the neighbouring semitone**,
  so the error attaches to the wrong note entirely.

Neither shows up in a reasoning test. Only real recordings reveal the true
perception-to-detection gap and let us calibrate the thresholds against it.

## How to contribute takes

Record **mono .wav, 44.1 kHz** into this folder, named `<label>__<take>.wav`
(e.g. `flat3rdfinger__1.wav`). Aim for **3+ takes per label**. Each take needs
**≥ ~20 notes**, and the finger labels need **≥ 8 notes on the target finger**,
or the statistical tests can't reach quorum.

| label            | what to play |
|------------------|--------------|
| `intune`         | A scale/passage played cleanly, in tune. **Control — must fire nothing.** |
| `flat3rdfinger`  | Same scale, but consistently drop the 3rd finger ~30 cents flat on every 3rd-finger note; keep other fingers accurate. |
| `flattendency`   | One finger/string consistently ~25 cents flat. |
| `sharptendency`  | One finger/string consistently ~25 cents sharp. |
| `fatigue`        | A long (3–4 min) take: clean intonation early, drifting steadily worse toward the end. |
| `monotone`       | A passage at one unchanging dynamic (no cresc/dim). |

The expected detections per label live in `EXPECTED` in
`test/audioCorpus.test.ts`. With takes present, the harness prints a per-label
confusion matrix (detection rate + false-positive count) and asserts each
label's expected fault fires in every take.

## Not covered here

Bow faults (`frogcamp`, `fullbow`, `tipthin`) are **not audio-testable** — they
need video frames through the native pose/bow detector. Capturing those requires
exporting `RawBowFrame[]` from a device recording; a separate harness.
