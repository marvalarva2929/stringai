/**
 * Shift planning — where a teacher would put the shift, not where the notes force it.
 *
 *   node --experimental-strip-types --loader ./test/ts-resolver.mjs test/fingeringPlan.test.ts
 */

import { planFingering, firstPositionCeiling } from '../src/lib/exercises/fingeringPlan';
import { OPEN_MIDI } from '../src/lib/exercises/fingerboard';
import { buildTechniqueStaple } from '../src/lib/exercises/techniqueStaple';
import { GENERATORS } from '../src/lib/exercises/registry';
import { sequenceStepsFor } from '../src/lib/sequenceSteps';
import { noteNameToMidi } from '../src/lib/pitchNaming';
import type { RankedPracticeEvidence } from '../src/lib/practiceRanking';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const D = OPEN_MIDI.D;

// ─────────────────────────────────────────────────────────────
console.log('first position is left alone');
{
  // D major scale on the D string, one octave — entirely in first position.
  const plan = planFingering([D, D + 2, D + 4, D + 5, D + 7, D + 9, D + 11, D + 12], { preferString: 'D' });
  check('no shift when none is needed', plan.shiftCount === 0, String(plan.shiftCount));
  check('reports that it stays put', plan.requiresShifting === false);
  check('one position only', plan.positions.join(',') === 'first', plan.positions.join(','));
  check('open string is finger 0', plan.notes[0].finger === 0);
  check('no step mentions a position it is not in',
    plan.notes.every((n) => !/3rd position|5th position/.test(n.annotation)),
    JSON.stringify(plan.notes.map((n) => n.annotation)));
}

// ─────────────────────────────────────────────────────────────
console.log('crossing beats shifting');
{
  // A one-octave scale from open D needs no position change at all: you take
  // the top half on the A string. Forcing it onto one string and shifting is a
  // fingering no teacher would give.
  const scale = [D, D + 2, D + 4, D + 5, D + 7, D + 9, D + 11, D + 12];
  const natural = planFingering(scale, { preferString: 'D' });
  check('a one-octave scale never shifts', natural.shiftCount === 0, String(natural.shiftCount));
  check('it crosses to the next string instead',
    new Set(natural.notes.map((n) => n.string)).size > 1,
    JSON.stringify(natural.notes.map((n) => `${n.noteName}:${n.string}`)));

  // Locked to one string it has no choice but to shift — which is right for a
  // drill that is deliberately about that string.
  const locked = planFingering(scale, { preferString: 'D', lockToString: true });
  check('locking to one string forces the shift', locked.shiftCount > 0, String(locked.shiftCount));
  check('and keeps every note there',
    locked.notes.every((n) => n.string === 'D'),
    JSON.stringify(locked.notes.map((n) => n.string)));
}

// ─────────────────────────────────────────────────────────────
console.log('the shift goes early, not at the last possible note');
{
  // Up the E string, where there is no higher string to escape onto, so the
  // hand genuinely has to move.
  const E = OPEN_MIDI.E;
  const ceiling = firstPositionCeiling('E');
  const midis = [E, E + 2, E + 4, E + 5, E + 7, E + 9, E + 11, E + 12];
  const plan = planFingering(midis, { preferString: 'E' });

  check('it does shift', plan.shiftCount >= 1, String(plan.shiftCount));
  check('and says so', plan.requiresShifting === true);

  const shiftIndex = plan.notes.findIndex((n) => n.isShift);
  const forcedIndex = midis.findIndex((m) => m > ceiling);
  check('the shift happens before the note that forces it',
    shiftIndex >= 0 && forcedIndex >= 0 && shiftIndex < forcedIndex,
    `shift at ${shiftIndex}, forced at ${forcedIndex}`);

  // "Shift to 3rd position" is not an instruction; naming the finger is.
  const shiftNote = plan.notes[shiftIndex];
  check('the shift names the travelling finger',
    /slides to/.test(shiftNote.annotation), shiftNote.annotation);
  check('the shift names the destination position',
    /3rd position|5th position/.test(shiftNote.annotation), shiftNote.annotation);
  check('the shift names a direction', /SHIFT (up|back)/.test(shiftNote.annotation), shiftNote.annotation);
}

// ─────────────────────────────────────────────────────────────
console.log('shifts do not land on the weakest finger');
{
  // High on the E string, where shifts are unavoidable.
  const E = OPEN_MIDI.E;
  const midis = [E, E + 4, E + 7, E + 9, E + 11, E + 12, E + 14, E + 11, E + 7, E];
  const plan = planFingering(midis, { preferString: 'E' });
  const shifts = plan.notes.filter((n) => n.isShift);
  check('shifts exist to check', shifts.length > 0);
  check('no shift arrives on the 4th finger',
    shifts.every((n) => n.finger !== 4),
    JSON.stringify(shifts.map((n) => `${n.noteName}:${n.finger}`)));
}

// ─────────────────────────────────────────────────────────────
console.log('first-position-only mode never asks for a shift');
{
  const E = OPEN_MIDI.E;
  const midis = [E, E + 4, E + 7, E + 9, E + 12, E + 14];
  const locked = planFingering(midis, { preferString: 'E', allowShifting: false });
  check('no shifts at all', locked.shiftCount === 0, String(locked.shiftCount));
  check('no annotation claims a position change',
    locked.notes.every((n) => !/SHIFT/.test(n.annotation)),
    JSON.stringify(locked.notes.map((n) => n.annotation)));
  // Out-of-reach notes are reported so a caller can pick a different register
  // rather than silently handing over something unplayable.
  check('unreachable notes are reported', locked.unreachable.length > 0, JSON.stringify(locked.unreachable));

  const free = planFingering(midis, { preferString: 'E', allowShifting: true });
  check('the same notes shift when allowed', free.shiftCount > 0);
}

// ─────────────────────────────────────────────────────────────
console.log('descending shifts read as coming back');
{
  const E = OPEN_MIDI.E;
  const plan = planFingering([E + 14, E + 12, E + 11, E + 7, E + 4, E], { preferString: 'E' });
  const back = plan.notes.find((n) => n.isShift && /SHIFT back/.test(n.annotation));
  check('a downward shift is described as going back', back != null,
    JSON.stringify(plan.notes.filter((n) => n.isShift).map((n) => n.annotation)));
}

// ─────────────────────────────────────────────────────────────
console.log('generated drills respect the setting');
{
  function evidence(over: Partial<RankedPracticeEvidence> = {}): RankedPracticeEvidence {
    return {
      id: 'figure_shift:test', kind: 'figure_shift', metricKey: 'pitchAccuracy',
      title: 't', reason: 'r', evidenceSummary: 's', priority: 110, confidence: 0.8,
      supportsLive: true, requiresMic: true, requiresCamera: false,
      measurementAvailable: true, sessionCount: 1, rankScore: 140,
      target: { metricKey: 'pitchAccuracy', string: 'A', fromPosition: 'first', toPosition: 'third' },
      ...over,
    };
  }

  // The shifting ladder IS the shift — there is no first-position version.
  check('the shift ladder declines when shifting is off',
    GENERATORS.shifting_ladder({ evidence: evidence(), intensity: 'balanced', canShift: false }) === null);
  check('and appears when shifting is on',
    GENERATORS.shifting_ladder({ evidence: evidence(), intensity: 'balanced', canShift: true }) != null);

  // The daily warm-up swaps a shift drill for the frame check rather than
  // skipping a day of general work.
  const staple = buildTechniqueStaple({ intensity: 'balanced', kind: 'shift_prep', canShift: false });
  check('the shift warm-up falls back to the frame check',
    staple.id === 'staple:finger_frame', staple.id);
  check('and is the real thing when shifting is on',
    buildTechniqueStaple({ intensity: 'balanced', kind: 'shift_prep', canShift: true }).id === 'staple:shift_prep');

  // An advanced two-octave arpeggio needs a shift; without one it drops an octave.
  const locked = GENERATORS.arpeggio_cycle({
    evidence: evidence({ kind: 'figure_intonation', target: { metricKey: 'pitchAccuracy', keyName: 'G major' } }),
    intensity: 'advanced',
    canShift: false,
  });
  const free = GENERATORS.arpeggio_cycle({
    evidence: evidence({ kind: 'figure_intonation', target: { metricKey: 'pitchAccuracy', keyName: 'G major' } }),
    intensity: 'advanced',
    canShift: true,
  });
  check('a locked arpeggio is shorter than a free one',
    sequenceStepsFor(locked?.evaluator).length < sequenceStepsFor(free?.evaluator).length,
    `${sequenceStepsFor(locked?.evaluator).length} vs ${sequenceStepsFor(free?.evaluator).length}`);
  check('and never asks for a shift',
    sequenceStepsFor(locked?.evaluator).every((s) => !/SHIFT/.test(s.annotation ?? '')),
    JSON.stringify(sequenceStepsFor(locked?.evaluator).map((s) => s.annotation)));
}

// ─────────────────────────────────────────────────────────────
console.log('every staple stays put when shifting is off');
{
  for (const kind of ['scale', 'arpeggio', 'finger_frame', 'shift_prep'] as const) {
    const block = buildTechniqueStaple({ intensity: 'advanced', keyName: 'G major', kind, canShift: false });
    const steps = sequenceStepsFor(block.evaluator);
    check(`${kind}: no shift requested`,
      steps.every((s) => !/SHIFT/.test(s.annotation ?? '')),
      JSON.stringify(steps.map((s) => s.annotation)));
    const midis = steps.map((s) => noteNameToMidi(s.note)!).filter(Boolean);
    check(`${kind}: notes stay within reach`,
      planFingering(midis).requiresShifting === false || midis.length === 0,
      JSON.stringify(steps.map((s) => s.note)));
  }
}

console.log(failures === 0 ? '\nAll fingering plan tests passed.' : `\n${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
