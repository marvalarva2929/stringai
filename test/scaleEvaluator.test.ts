/**
 * scaleEvaluator tests.
 *
 *   node --experimental-strip-types --loader ./test/ts-resolver.mjs test/scaleEvaluator.test.ts
 */

import { evaluateScale } from '../src/lib/scaleEvaluator';
import { midiToFreq, noteNameToMidi } from '../src/lib/pitchNaming';
import type { ScaleAttempt } from '../src/lib/scaleEvaluator';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const G_MAJOR = ['G3', 'A3', 'B3', 'C4', 'D4', 'E4', 'F#4', 'G4'];

function inTuneAttempts(sequence: string[], confidence = 0.8): ScaleAttempt[] {
  return sequence.map((note) => ({ medianFreqHz: midiToFreq(noteNameToMidi(note)!), confidence }));
}

// ── every note in tune, correct count -> pass ────────────────────────────────
{
  const result = evaluateScale(inTuneAttempts(G_MAJOR), G_MAJOR, { centsThreshold: 12 });
  check('all 8 in-tune notes pass', result.passed === true, result.feedback);
  check('attemptResults has one label per scale degree', result.attemptResults?.map((r) => r.label).join(',') === G_MAJOR.join(','));
}

// ── one note off by a full semitone -> fails, names the note ────────────────
{
  const attempts = inTuneAttempts(G_MAJOR);
  attempts[2] = { medianFreqHz: midiToFreq(noteNameToMidi('B3')! + 1), confidence: 0.8 }; // a semitone sharp
  const result = evaluateScale(attempts, G_MAJOR, { centsThreshold: 12 });
  check('a semitone-sharp note fails', result.passed === false);
  // A semitone out is a different note, and isIntonationSlip already treated it
  // as a hard miss for the verdict — the wording now agrees with that instead
  // of calling it "sharp by 100¢", which reads as intonation when it isn't.
  check('feedback names the specific note and what was heard',
    /B3 came out as C4/.test(result.feedback), result.feedback);
  // The score can be high while the take still fails — the message has to say
  // why, or a 88/100 beside "Not yet" reads as a bug.
  check('feedback explains why a good score still failed',
    /wrong note rather than a near miss/.test(result.feedback), result.feedback);
}

// ── fewer notes detected than expected -> flags the count mismatch ──────────
{
  const attempts = inTuneAttempts(G_MAJOR.slice(0, 6));
  const result = evaluateScale(attempts, G_MAJOR, { centsThreshold: 12 });
  check('a short take fails', result.passed === false);
  check('feedback flags the note-count mismatch', /heard 6 notes, expected 8/.test(result.feedback), result.feedback);
}

// ── one note slightly out of tune -> still passes (intonation, not a wrong note) ──
{
  const attempts = inTuneAttempts(G_MAJOR);
  // 25 cents sharp: clearly still a B3, just not centered.
  attempts[2] = { medianFreqHz: midiToFreq(noteNameToMidi('B3')!) * Math.pow(2, 25 / 1200), confidence: 0.8 };
  const result = evaluateScale(attempts, G_MAJOR, { centsThreshold: 12 });
  check('a single slightly-flat/sharp note still passes the scale', result.passed === true, result.feedback);
  check('feedback still credits the clean notes', /7 of 8 notes dead on/i.test(result.feedback), result.feedback);
  check('and reports a score', /\d+\/100/.test(result.feedback), result.feedback);
}

// ── two slightly-off notes -> still a good scale, but it costs ─────────────
{
  // Under the old fixed allowance this failed. That allowance is exactly what
  // the holistic score replaced: two notes 25¢ sharp is a scale worth passing
  // with something to polish, not a failure.
  const attempts = inTuneAttempts(G_MAJOR);
  const sharp = (note: string) => midiToFreq(noteNameToMidi(note)!) * Math.pow(2, 25 / 1200);
  attempts[2] = { medianFreqHz: sharp('B3'), confidence: 0.8 };
  attempts[5] = { medianFreqHz: sharp('E4'), confidence: 0.8 };
  const result = evaluateScale(attempts, G_MAJOR, { centsThreshold: 12 });
  check('two slightly-off notes still pass', result.passed === true, result.feedback);

  const oneOff = inTuneAttempts(G_MAJOR);
  oneOff[2] = { medianFreqHz: sharp('B3'), confidence: 0.8 };
  const single = evaluateScale(oneOff, G_MAJOR, { centsThreshold: 12 });
  check('but two cost more than one',
    (result.score?.score ?? 0) < (single.score?.score ?? 0),
    `${result.score?.score} vs ${single.score?.score}`);

  const clean = evaluateScale(inTuneAttempts(G_MAJOR), G_MAJOR, { centsThreshold: 12 });
  check('and a clean scale still scores highest',
    (single.score?.score ?? 0) < (clean.score?.score ?? 0),
    `${single.score?.score} vs ${clean.score?.score}`);
}

// ── low confidence attempt is not silently counted as correct ───────────────
{
  const attempts = inTuneAttempts(G_MAJOR);
  attempts[0] = { medianFreqHz: midiToFreq(noteNameToMidi('G3')!), confidence: 0.1 };
  const result = evaluateScale(attempts, G_MAJOR, { centsThreshold: 12, minConfidence: 0.5 });
  check('a low-confidence attempt fails even if the pitch would be correct', result.passed === false, result.feedback);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll scaleEvaluator checks passed');
