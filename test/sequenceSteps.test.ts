/**
 * Sequence-step resolution — the one list both the runner and the evaluator read.
 *
 *   node --experimental-strip-types --loader ./test/ts-resolver.mjs test/sequenceSteps.test.ts
 */

import {
  sequenceStepsFor,
  expectedNotesFor,
  sequenceBpmFor,
  DEFAULT_SEQUENCE_BPM,
} from '../src/lib/sequenceSteps';
import { scaleNoteSequence } from '../src/lib/scaleSequence';
import { runEvaluator } from '../src/lib/runEvaluator';
import type { EvaluatorParams } from '../src/lib/practiceBlocks';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const SR = 44100;

function synthTone(freqHz: number, durS: number, sr = SR): Float32Array {
  const n = Math.floor(sr * durS);
  const out = new Float32Array(n);
  const harm = [1, 0.5, 0.33, 0.22, 0.14];
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const env = Math.min(1, t / 0.03) * Math.min(1, (durS - t) / 0.05);
    let v = 0;
    for (let h = 0; h < harm.length; h++) v += harm[h] * Math.sin(2 * Math.PI * freqHz * (h + 1) * t);
    out[i] = (0.5 * env * v) / 1.7;
  }
  return out;
}

function silence(durS: number, sr = SR): Float32Array {
  return new Float32Array(Math.floor(sr * durS));
}

function concat(parts: Float32Array[]): Float32Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; }
  return out;
}

const midiToFreq = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

// ─────────────────────────────────────────────────────────────
console.log('sequenceStepsFor');
{
  check('no evaluator → no steps', sequenceStepsFor(undefined).length === 0);

  const nonPaced: EvaluatorParams = { evaluatorId: 'pitchLanding', centsThreshold: 10, requiredStreak: 3 };
  check('unpaced evaluator → no steps', sequenceStepsFor(nonPaced).length === 0);

  const scale: EvaluatorParams = { evaluatorId: 'scale', scaleName: 'G major', centsThreshold: 12 };
  const scaleSteps = sequenceStepsFor(scale);
  check('scale alias still expands', scaleSteps.length === scaleNoteSequence('G major').length && scaleSteps.length > 0);
  check('scale alias matches scaleNoteSequence exactly',
    scaleSteps.map((s) => s.note).join(',') === scaleNoteSequence('G major').join(','));
  // A bare note name leaves a beginner hunting for the note; the scale path
  // gets fingerings from the same helper the generators use.
  check('scale steps carry fingerings', scaleSteps.every((s) => (s.annotation ?? '').length > 0),
    JSON.stringify(scaleSteps.slice(0, 3)));
  check('fingering names a string', scaleSteps.some((s) => /G|D|A|E/.test(s.annotation ?? '')));

  const rooted: EvaluatorParams = {
    evaluatorId: 'scale', scaleName: 'G major', centsThreshold: 12, rootMidiNote: 67,
  };
  check('scale alias honours the anchor octave',
    sequenceStepsFor(rooted).map((s) => s.note).join(',') === scaleNoteSequence('G major', 67).join(','));

  const sequence: EvaluatorParams = {
    evaluatorId: 'sequence',
    bpm: 72,
    centsThreshold: 10,
    steps: [
      { note: 'D4', annotation: 'D string' },
      { note: 'A4', annotation: 'cross to A' },
      { note: 'E4' },
    ],
  };
  check('explicit sequence passes through', sequenceStepsFor(sequence).length === 3);
  check('annotations survive', sequenceStepsFor(sequence)[1].annotation === 'cross to A');
  check('expectedNotesFor drops annotations',
    expectedNotesFor(sequence).join(',') === 'D4,A4,E4');
}

// ─────────────────────────────────────────────────────────────
console.log('sequenceBpmFor');
{
  check('sequence carries its own tempo',
    sequenceBpmFor({ evaluatorId: 'sequence', bpm: 96, centsThreshold: 10, steps: [{ note: 'D4' }] }) === 96);
  check('scale falls back to the default',
    sequenceBpmFor({ evaluatorId: 'scale', scaleName: 'G major', centsThreshold: 12 }) === DEFAULT_SEQUENCE_BPM);
  check('no evaluator falls back to the default', sequenceBpmFor(undefined) === DEFAULT_SEQUENCE_BPM);
}

// ─────────────────────────────────────────────────────────────
console.log('runEvaluator — sequence takes');
{
  // Three clean notes, one per beat, played exactly as asked.
  const notes = [62, 69, 64];
  const noteDur = 0.6;
  const gap = 0.4;
  const samples = concat(
    notes.flatMap((midi) => [synthTone(midiToFreq(midi), noteDur), silence(gap)]),
  );
  const beatTimestamps = notes.map((_, i) => i * (noteDur + gap));

  const params: EvaluatorParams = {
    evaluatorId: 'sequence',
    bpm: 60,
    centsThreshold: 25,
    steps: [{ note: 'D4', annotation: 'D string' }, { note: 'A4', annotation: 'cross to A' }, { note: 'E4' }],
  };

  const result = runEvaluator(params, { samples, sampleRate: SR, beatTimestamps });
  check('sequence take is judged', result != null && result.attempts > 0, JSON.stringify(result?.feedback));
  check('every note is reported back',
    (result?.attemptResults?.length ?? 0) === 3, String(result?.attemptResults?.length));
  check('results are labelled with the expected notes',
    result?.attemptResults?.map((a) => a.label).join(',') === 'D4,A4,E4',
    result?.attemptResults?.map((a) => a.label).join(','));
  check('a correctly played sequence passes', result?.passed === true, result?.feedback);

  // The same audio graded against a different expected sequence must fail —
  // this is the guard that the screen and the verdict share one list.
  const wrong = runEvaluator(
    { ...params, steps: [{ note: 'G3' }, { note: 'C4' }, { note: 'F4' }] } as EvaluatorParams,
    { samples, sampleRate: SR, beatTimestamps },
  );
  check('wrong notes fail', wrong?.passed === false, wrong?.feedback);

  check('no take → zero attempts', runEvaluator(params, null)?.attempts === 0);
}

console.log(failures === 0 ? '\nAll sequence step tests passed.' : `\n${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
