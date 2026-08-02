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
  check('feedback names the specific note (3rd, B3) and direction', /Note 3 \(B3\) was sharp/.test(result.feedback), result.feedback);
}

// ── fewer notes detected than expected -> flags the count mismatch ──────────
{
  const attempts = inTuneAttempts(G_MAJOR.slice(0, 6));
  const result = evaluateScale(attempts, G_MAJOR, { centsThreshold: 12 });
  check('a short take fails', result.passed === false);
  check('feedback flags the note-count mismatch', /Detected 6 notes, expected 8/.test(result.feedback), result.feedback);
}

// ── one note slightly out of tune -> still passes (intonation, not a wrong note) ──
{
  const attempts = inTuneAttempts(G_MAJOR);
  // 25 cents sharp: clearly still a B3, just not centered.
  attempts[2] = { medianFreqHz: midiToFreq(noteNameToMidi('B3')!) * Math.pow(2, 25 / 1200), confidence: 0.8 };
  const result = evaluateScale(attempts, G_MAJOR, { centsThreshold: 12 });
  check('a single slightly-flat/sharp note still passes the scale', result.passed === true, result.feedback);
  check('feedback still credits the clean notes', /good enough to move on/i.test(result.feedback), result.feedback);
}

// ── two notes out of tune -> exceeds the allowance for an 8-note scale ──────
{
  const attempts = inTuneAttempts(G_MAJOR);
  const sharp = (note: string) => midiToFreq(noteNameToMidi(note)!) * Math.pow(2, 25 / 1200);
  attempts[2] = { medianFreqHz: sharp('B3'), confidence: 0.8 };
  attempts[5] = { medianFreqHz: sharp('E4'), confidence: 0.8 };
  const result = evaluateScale(attempts, G_MAJOR, { centsThreshold: 12 });
  check('two off notes exceed the 1-note allowance and fail', result.passed === false, result.feedback);
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
