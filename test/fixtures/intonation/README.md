# Intonation-stability calibration clips

Drop recordings here, then run `npm run calibrate:intonation`.

Video (`.mov/.mp4/.m4a`) is fine — it's auto-converted to mono 44.1 kHz WAV with ffmpeg
(cached next to it as `*.cal.wav`, which is gitignored). WAV works directly.

## Filenames

`<label>__<n>.<ext>` — the part before `__` is the label; `<n>` is just 1, 2, 3…

Record a few of EACH (≈3–5 per label is plenty — calibration needs the contrast between
groups, not volume):

| Filename | What to play | Expected |
|---|---|---|
| `steady-vibrato__1.mov`   | sustained notes with your normal, controlled **vibrato**, pitch center held in tune | HIGH score, no flags |
| `steady-flat__1.mov`      | long, **straight** tones (no vibrato), held dead steady | HIGH score, no flags |
| `unstable-flat__1.mov`    | held notes that **scoop / drift / waver** in center pitch, **no** vibrato | LOW score, flagged |
| `unstable-vibrato__1.mov` | vibrato on top of an **unsteady, wandering** center pitch (the hard case) | LOW score, flagged |

## Recording hygiene (so pitch tracking is clean)

- Solo, single line, one note at a time — no double stops, no accompaniment.
- Dry and close: minimal room reverb; phone a foot or two away is fine.
- A few seconds per note, several notes per clip; mix strings/registers across takes.
- The two "unstable" categories can be **deliberately bad** takes — exaggerate the fault.
  Deliberate faults give clean ground truth that great-playing-only clips can't.

## How calibration reads these

Each clip reduces to one number: **center-line drift in cents** (vibrato removed). The
harness prints the drift + score per clip, then the drift range for the `steady-*` group vs
the `unstable-*` group. If the groups separate, it suggests the threshold constants in
`src/services/pitchContour.ts` (`STABILITY_*`). If they overlap, that points at the detrend
window rather than the thresholds.
