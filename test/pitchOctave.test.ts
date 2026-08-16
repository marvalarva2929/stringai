/**
 * Octave-error correction in YIN.
 *
 * A first-finger A on the G string is 220Hz with a second harmonic at 440Hz
 * that is often *louder* than the fundamental. Reported as 440Hz it becomes an
 * open A, the string inference reads it as the A string, and the app tells the
 * player they crossed G to A — two strings apart, from playing two notes on one.
 *
 *   node --experimental-strip-types --loader ./test/ts-resolver.mjs test/pitchOctave.test.ts
 */

import { yinWindow, detectPitches } from '../src/services/dsp';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const SR = 44100;

/**
 * A bowed-string tone. `harmonics` are amplitudes for the 1st, 2nd, 3rd…
 * partials — a weak fundamental with a strong 2nd is exactly what the G string
 * produces and exactly what fools a plain first-dip search.
 */
function tone(freqHz: number, durS: number, harmonics: number[]): Float32Array {
  const n = Math.floor(SR * durS);
  const out = new Float32Array(n);
  const norm = harmonics.reduce((s, a) => s + Math.abs(a), 0) || 1;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let v = 0;
    for (let h = 0; h < harmonics.length; h++) {
      v += harmonics[h] * Math.sin(2 * Math.PI * freqHz * (h + 1) * t);
    }
    out[i] = (0.6 * v) / norm;
  }
  return out;
}

function detectedHz(samples: Float32Array): number | null {
  const { frequency } = yinWindow(samples, 0, 1024, SR);
  return frequency;
}

const cents = (a: number, b: number) => Math.abs(1200 * Math.log2(a / b));

// ─────────────────────────────────────────────────────────────
console.log('the reported case: A3 on the G string');
{
  // Fundamental weaker than the 2nd harmonic — the G string's actual profile.
  const a3 = tone(220, 0.2, [0.35, 1.0, 0.5, 0.3, 0.2]);
  const hz = detectedHz(a3);
  check('A3 is heard, not silence', hz != null, String(hz));
  check('A3 is not reported an octave high (as open A)',
    hz != null && cents(hz, 220) < 60, `${hz?.toFixed(1)}Hz`);

  // Open G, same profile — the other note in the reported pair.
  const g3 = detectedHz(tone(196, 0.2, [0.4, 1.0, 0.5, 0.3, 0.2]));
  check('open G is not reported an octave high',
    g3 != null && cents(g3, 196) < 60, `${g3?.toFixed(1)}Hz`);

  // The two together must sit on the same string — which is the whole point.
  const stringOf = (f: number) => (f >= 659 ? 'E' : f >= 440 ? 'A' : f >= 294 ? 'D' : 'G');
  check('both land on the G string, so there is no crossing',
    stringOf(detectedHz(a3)!) === 'G' && stringOf(g3!) === 'G',
    `${stringOf(detectedHz(a3)!)} / ${stringOf(g3!)}`);
}

// ─────────────────────────────────────────────────────────────
console.log('correction does not drag real notes down');
{
  // Genuinely high notes must survive: over-correcting is the same bug mirrored.
  const cases: [string, number][] = [
    ['open A', 440], ['open E', 659], ['B4', 493.9], ['A5', 880], ['D5', 587.3],
  ];
  for (const [label, freq] of cases) {
    const hz = detectedHz(tone(freq, 0.2, [1.0, 0.5, 0.33, 0.22, 0.14]));
    check(`${label} stays at pitch`, hz != null && cents(hz, freq) < 60, `${hz?.toFixed(1)}Hz`);
  }

  // A pure tone has no harmonics to be confused by.
  const pure = detectedHz(tone(440, 0.2, [1]));
  check('a pure 440 is still 440', pure != null && cents(pure, 440) < 30, `${pure?.toFixed(1)}Hz`);
}

// ─────────────────────────────────────────────────────────────
console.log('the violin range is respected');
{
  // Nothing below open G can be played, so a subharmonic read must be rejected
  // rather than reported as a real note.
  const tooLow = detectedHz(tone(110, 0.2, [1.0, 0.5, 0.3]));
  check('a pitch below the G string is not reported', tooLow === null, String(tooLow));

  const openG = detectedHz(tone(196, 0.2, [1.0, 0.5, 0.3]));
  check('open G itself is still reported', openG != null && cents(openG, 196) < 40, String(openG));
}

// ─────────────────────────────────────────────────────────────
console.log('detectPitches over a full clip');
{
  const clip = tone(220, 0.5, [0.35, 1.0, 0.5, 0.3, 0.2]);
  const frames = detectPitches(clip, SR).filter((f) => f.frequency != null);
  check('most of the clip is voiced', frames.length > 5, String(frames.length));
  const octaveUp = frames.filter((f) => cents(f.frequency!, 440) < 60).length;
  check('no frame reports the octave above',
    octaveUp === 0, `${octaveUp} of ${frames.length} frames read as 440Hz`);
  const correct = frames.filter((f) => cents(f.frequency!, 220) < 60).length;
  check('frames agree on 220Hz', correct / frames.length > 0.9,
    `${correct}/${frames.length}`);
}

console.log(failures === 0 ? '\nAll pitch octave tests passed.' : `\n${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
