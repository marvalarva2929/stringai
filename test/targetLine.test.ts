/**
 * targetLine / noteNameToMidi tests.
 *
 *   node --experimental-strip-types --loader ./test/ts-resolver.mjs test/targetLine.test.ts
 */

import { noteNameToMidi } from '../src/lib/pitchNaming';
import { targetLine } from '../src/lib/practiceCopy';
import type { PracticeBlock } from '../src/lib/practiceBlocks';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ── noteNameToMidi ────────────────────────────────────────────────────────
check('B3 -> 59', noteNameToMidi('B3') === 59, String(noteNameToMidi('B3')));
check('F#4 -> 66', noteNameToMidi('F#4') === 66, String(noteNameToMidi('F#4')));
check('Bb3 -> 58', noteNameToMidi('Bb3') === 58, String(noteNameToMidi('Bb3')));
check('A4 -> 69', noteNameToMidi('A4') === 69, String(noteNameToMidi('A4')));
check('garbage -> null', noteNameToMidi('not a note') === null);

// ── targetLine ───────────────────────────────────────────────────────────
function block(target: PracticeBlock['target']): PracticeBlock {
  return {
    id: 'x', type: 'pitch_landing', title: 'Fallback Title', subtitle: '', reason: '',
    estimatedMinutes: 5, coachIntensity: 'balanced', instructions: [], target,
    liveMode: { label: '', signals: [], requiresMic: true, requiresCamera: false, status: 'ready' },
    successCriteria: { summary: '' }, fallbackCriteria: '', coachPromptContext: '', evidenceRefs: [],
  };
}

{
  const line = targetLine(block({ metricKey: 'pitchAccuracy', noteName: 'B3', midiNote: 59 }));
  check('B3 with midiNote -> real fingering prose', line === 'B3, 2nd finger on G string', line);
}

{
  // intonation_stability evidence has noteName but no midiNote — should still resolve via noteNameToMidi.
  const line = targetLine(block({ metricKey: 'intonationStability', noteName: 'F#4' }));
  check('F#4 without midiNote resolves via noteNameToMidi', line === 'F#4, 2nd finger on D string', line);
}

{
  const line = targetLine(block({ metricKey: 'pitchAccuracy', noteName: 'A4', midiNote: 69, scaleName: 'A major' }));
  check('scaleName appended after the fingering prose', line === 'Open A string (Concert A) · A major', line);
}

{
  // No note info at all -> falls back to block title.
  const line = targetLine(block({ metricKey: 'bowAngle' }));
  check('no target info falls back to block title', line === 'Fallback Title', line);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll targetLine checks passed');
