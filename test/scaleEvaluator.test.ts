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

// ── one note outside tolerance -> does not pass, and is named for a redo ─────
// Passing a tuning drill means every note was in tune. The score stays generous
// (it measures how close the take was); the pass does not. What makes that
// reasonable is that the miss is named, so it can be drilled on its own instead
// of costing a repeat of the whole scale.
{
  const attempts = inTuneAttempts(G_MAJOR);
  // 25 cents sharp: clearly still a B3, just not in tune.
  attempts[2] = { medianFreqHz: midiToFreq(noteNameToMidi('B3')!) * Math.pow(2, 25 / 1200), confidence: 0.8 };
  const result = evaluateScale(attempts, G_MAJOR, { centsThreshold: 12 });
  check('a single out-of-tolerance note fails the scale', result.passed === false, result.feedback);
  check('feedback names the note to redo', /B3/.test(result.feedback), result.feedback);
  check('the score still reflects that the rest was good', (result.score?.score ?? 0) >= 90, result.feedback);
  check('and reports a score', /\d+\/100/.test(result.feedback), result.feedback);
}

// ── a note inside tolerance is clean, even if not dead centre ────────────────
{
  const attempts = inTuneAttempts(G_MAJOR);
  // 9 cents sharp against a 12 cent tolerance — inside the bar, so it passes.
  attempts[2] = { medianFreqHz: midiToFreq(noteNameToMidi('B3')!) * Math.pow(2, 9 / 1200), confidence: 0.8 };
  const result = evaluateScale(attempts, G_MAJOR, { centsThreshold: 12 });
  check('within tolerance still passes', result.passed === true, result.feedback);
}

// ── two off notes -> both named, and two cost more than one on the score ────
{
  const attempts = inTuneAttempts(G_MAJOR);
  const sharp = (note: string) => midiToFreq(noteNameToMidi(note)!) * Math.pow(2, 25 / 1200);
  attempts[2] = { medianFreqHz: sharp('B3'), confidence: 0.8 };
  attempts[5] = { medianFreqHz: sharp('E4'), confidence: 0.8 };
  const result = evaluateScale(attempts, G_MAJOR, { centsThreshold: 12 });
  check('two out-of-tolerance notes fail', result.passed === false, result.feedback);
  check('and both are named for redoing', /B3/.test(result.feedback) && /E4/.test(result.feedback), result.feedback);

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
