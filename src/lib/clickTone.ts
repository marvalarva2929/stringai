/**
 * The metronome click: what it sounds like, and why the analyzer can't mistake it
 * for a note.
 *
 * The click is played right on the beat — exactly where a well-timed note is also
 * expected to land — and the phone's speaker sits inches from its own mic, so the
 * click is always in the recording. It therefore has to be a sound a pitch detector
 * structurally cannot report.
 *
 * It used to be a 1 kHz sine held for 50 ms, which is the opposite of that: 50 clean
 * cycles of a pure tone, detected at periodicity 0.998 (higher than real playing ever
 * reaches) and landing on B5 +27¢, a common E-string note. Every beat planted two
 * voiced frames of a phantom note.
 *
 * What keeps it out of the pitch track is that it is APERIODIC — a damped noise burst
 * rather than a tone. YIN's difference function never dips below its threshold, so
 * there is no period to report at any octave. That single property is load-bearing,
 * and two things follow from it:
 *
 *   • Being high-pitched is neither necessary nor sufficient. Not sufficient: a pure
 *     3.5 kHz sine sits above MAX_VIOLIN_HZ, but YIN skips its true period (shorter
 *     than tauMin) and locks onto the 2nd and 3rd subharmonics, reporting a confident
 *     1646 Hz / 1155 Hz. Not necessary: this click's body sits at 1.4 kHz, right inside
 *     the violin's range, and measures as clean as a 3–5 kHz hiss did — because noise
 *     has no subharmonics to fall back on. Sitting in the mid-range is what lets it
 *     sound like a metronome instead of a tape hiss.
 *
 *   • Resonance is the thing to avoid, and Q is the dial. A high-Q bandpass on noise
 *     is very nearly a sine wave and puts the pitch back: at Q=12 the damage rises to
 *     41 bent frames on the corpus below, against 11 at Q=2 and 4 at the Q=0.4 shipped
 *     here. Raising CLICK_Q to make the tick more tuned/pitched trades directly against
 *     detectability — see CLICK_Q for the measured clarity-vs-Q curve.
 *
 * Measured against the fixture corpus with the click mixed in at the recording's own
 * peak level (a louder metronome than any real take), summed over 12 takes /
 * 12,036 voiced frames:
 *
 *              phantom notes   frames bent >25¢
 *   1 kHz sine       439 (3.6%)      563 (4.7%)
 *   noise tock        14 (0.1%)       11 (0.1%)
 *
 * A frequency notch cannot substitute for this, which is why the ±35¢ filter around
 * 1000 Hz that used to live here is gone. Measured on the same corpus, against the old
 * sine click, a notch catches 79% of the phantom notes but only 48% of the bent ones —
 * because when the click lands on top of a note (the common case, since the player is
 * playing on the beat) YIN reports a frequency pulled somewhere BETWEEN the note and
 * the click, which is not near 1000 Hz and so is invisible to the notch. It leaves 386
 * damaged frames uncorrected and deletes 109 genuine B5s as collateral. The click has
 * to be undetectable at the source; it cannot be filtered out afterwards.
 *
 * KNOWN GAP — onsets. This fixes pitch, not onset detection. The click is still an
 * audible transient, so it trips computeSpectralFluxOnsets exactly as often as the
 * old one did (~452 extra onsets over the same corpus, unchanged). That pollutes
 * anything reading `onsetTimestamps` from analyzeWavFile — rhythm scoring above all,
 * where a click-generated onset sits perfectly on the beat and flatters the player.
 * Three fixes were measured and rejected:
 *   • Gating onsets at beat times deletes the player's ON-TIME notes too — the click
 *     and a well-played note land at the same instant by design.
 *   • Band-limiting the flux to under 2100 Hz does mute the click (452 → 42) but is a
 *     different detector, not a cleaner one: against today's onsets it peaks at 60%
 *     recall / 13% precision, and no threshold setting recovers both.
 *   • Requiring pitch to corroborate an onset doesn't discriminate — during sustained
 *     playing there is voiced pitch under the click anyway (and it drops ~40% of real
 *     onsets).
 * The practice-exercise rhythm path is unaffected: it segments on voiced pitch runs
 * (runEvaluator.rhythmAttemptsFromBeats), which an aperiodic click cannot enter.
 * For the main analysis path the real fix is to keep the click out of the mic —
 * headphones, or the visual-only metronome this hook already supports via `muted`.
 *
 * Kept here, pure and dependency-free, so the synthesis is unit-testable under Node
 * (useMetronome pulls in expo-av) and the hook has one definition to import.
 * test/metronomeClick.test.ts asserts the properties above against the real detector.
 */

export const CLICK_SAMPLE_RATE = 22050;
/** Short enough to read as a percussive tick rather than a pitch. */
export const CLICK_DURATION_S = 0.014;
/** Centre of the woodblock body. Mid-range so it reads as a metronome, not a hiss. */
const CLICK_BODY_HZ = 1400;
/**
 * Bandpass sharpness. Higher = more tuned and more detectable; see the header.
 *
 * Lowered from 2.0 when the detector stopped bailing out on windows that never
 * dip below YIN's absolute threshold (services/dsp.ts now falls back to the
 * global minimum, matching the native tuner, because bailing out was dropping
 * most real playing). The click had been surviving only on that bail-out: it is
 * not periodic enough to trip the threshold, but its resonant body does carry
 * enough clarity to win a global-minimum search.
 *
 * Peak clarity of the click across beat phases, measured through detectPitches
 * over a 4s track at 208 bpm — the gate is CLARITY_GATE = 0.55:
 *
 *   Q     0.707   0.6    0.5    0.45   0.4
 *   peak  0.58    0.57   0.56   0.55   none voiced
 *
 * Broadband noise floors around 0.50 clarity no matter what, so the usable
 * margin is narrow and Q has to come well down to clear it. 0.4 also happens to
 * be the quietest setting on the corpus (4 phantom frames, 76 bent, against 36
 * and 126 at Q=2.0), and a broader filter gives a sharper attack transient —
 * easier to play to, not harder.
 */
const CLICK_Q = 0.4;
/** Exponential amplitude decay, in nepers/second. */
const CLICK_DECAY = 300;
const CLICK_PEAK = 0.9;
/** Fixed so every render is byte-identical and the cached WAV is stable. */
const CLICK_NOISE_SEED = 0x5eed1;

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/**
 * Renders the click as mono float samples in [-1, 1] at CLICK_SAMPLE_RATE.
 * Deterministic: same samples every call.
 */
export function renderClick(): Float32Array {
  const n = Math.round(CLICK_SAMPLE_RATE * CLICK_DURATION_S);
  const out = new Float32Array(n);
  const rand = mulberry32(CLICK_NOISE_SEED);

  // White noise through a biquad bandpass (constant peak gain), then an exponential
  // decay: a struck-woodblock shape. The bandpass gives it a pitch centre to the ear
  // without the periodicity a detector needs — at Q=0.4 the impulse response is broad
  // enough that no window, at any beat phase, clears the voicing gate. See CLICK_Q.
  const w0 = 2 * Math.PI * CLICK_BODY_HZ / CLICK_SAMPLE_RATE;
  const alpha = Math.sin(w0) / (2 * CLICK_Q);
  const a0 = 1 + alpha;
  const b0 = (CLICK_Q * alpha) / a0;
  const b2 = -(CLICK_Q * alpha) / a0;
  const a1 = (-2 * Math.cos(w0)) / a0;
  const a2 = (1 - alpha) / a0;

  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const x = rand() * 2 - 1;
    const y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2; // b1 is 0 for a bandpass
    x2 = x1; x1 = x;
    y2 = y1; y1 = y;
    out[i] = Math.exp((-i / CLICK_SAMPLE_RATE) * CLICK_DECAY) * y;
    peak = Math.max(peak, Math.abs(out[i]));
  }

  // Normalize to a fixed peak so the click's loudness doesn't depend on which
  // noise samples the seed happened to produce.
  if (peak > 0) {
    const gain = CLICK_PEAK / peak;
    for (let i = 0; i < n; i++) out[i] *= gain;
  }
  return out;
}

/** Renders the click as a mono 16-bit PCM WAV file. */
export function buildClickWav(): Uint8Array {
  const samples = renderClick();
  const dataBytes = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const str = (off: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };

  str(0, 'RIFF'); v.setUint32(4, 36 + dataBytes, true);
  str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, CLICK_SAMPLE_RATE, true);
  v.setUint32(28, CLICK_SAMPLE_RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, dataBytes, true);

  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, Math.round(clamped * 32767), true);
  }
  return new Uint8Array(buf);
}
