# Tone-quality calibration fixtures

Drop real recordings here to calibrate and verify the tone-quality detector
(`src/services/toneAnalysis.ts`). The harness (`npm run test:tone`) globs every
`*.wav` in this folder and checks each clip's score against the band implied by
its filename label.

## Format
- **WAV (PCM)** only — `.m4a`/`.mp3` must be converted first:
  `ffmpeg -i in.m4a out.wav`
- Mono or stereo, any sample rate (channel 0 is used).
- ~5–15 s each. Include at least one **sustained note** and one **slow scale**
  so the per-note trajectory detectors (onset/decay/flicker) have material.

## Naming
`<label>__<freeform-desc>.wav`, where `<label>` is one of:

| label        | meaning                                   | expected band |
|--------------|-------------------------------------------|---------------|
| `good`       | clean, resonant tone                      | score ≥ 70    |
| `scratch`    | over-pressed / crunchy (the failing case) | score < 55    |
| `rasp`       | grainy / mildly rough                     | score < 72    |
| `thin`       | airy / under-pressure / surface sound     | score < 72    |
| `ponticello` | glassy, too close to the bridge           | score < 75    |
| `tasto`      | dull, too close to the fingerboard        | score < 75    |

Examples: `scratch__overpressed-clip.wav`, `good__d-string-mf.wav`,
`good__g-major-scale.wav`.

## Minimum to start
The offending **`scratch__…`** clip plus **2–3 `good__…`** clips. Add one clip
per other label as you can — each improves calibration of that detector.

Thresholds in `toneAnalysis.ts` (e.g. `P_FLOOR`, `SF_BAD`, `CN_PONT`, `SUB_BAD`)
are first-principles defaults; tune them against these real clips.
