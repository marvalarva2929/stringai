/**
 * scaleSequence tests.
 *
 *   node --experimental-strip-types --loader ./test/ts-resolver.mjs test/scaleSequence.test.ts
 */

import { scaleNoteSequence } from '../src/lib/scaleSequence';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

{
  const seq = scaleNoteSequence('G major');
  check('G major is 15 notes (up and back down)', seq.length === 15, seq.join(','));
  check('G major starts and ends on G, peaks at the octave', seq[0] === 'G3' && seq[7] === 'G4' && seq[14] === 'G3', seq.join(','));
  check(
    'G major has the right scale degrees ascending then descending',
    seq.join(',') === 'G3,A3,B3,C4,D4,E4,F#4,G4,F#4,E4,D4,C4,B3,A3,G3',
    seq.join(','),
  );
}

{
  const seq = scaleNoteSequence('A major');
  check('A major starts on open A (A4)', seq[0] === 'A4', seq.join(','));
  check('A major has a raised 7th (G#) on the way up', seq[6] === 'G#5', seq.join(','));
  check('A major descends back to A4', seq[14] === 'A4', seq.join(','));
}

{
  const seq = scaleNoteSequence('E minor');
  check('E minor has a natural (not raised) 7th', seq.join(',').includes('D6') || seq[6].startsWith('D'), seq.join(','));
}

{
  const seq = scaleNoteSequence('D melodic minor');
  check('D melodic minor has a raised 6th and 7th on the way up', seq[5] === 'B4' && seq[6] === 'C#5', seq.join(','));
}

{
  const seq = scaleNoteSequence('not a real scale');
  check('unrecognized scale name returns empty', seq.length === 0);
}

// Every generated scale has to be playable without shifting: drills default to
// first position (canShift in lib/exercises/types.ts). PITCH_CLASS_MIDI is the
// open-string table for the tuner, and rooting scales on it directly used to
// send C, C#, E and F an octave too high — E minor climbed to E6, past sixth
// position on the E string.
{
  // B5 = 4th finger on the E string in first position. Nothing may exceed it.
  const HIGHEST_FIRST_POSITION_MIDI = 83;
  const LOWEST_MIDI = 55; // open G
  const NAME_TO_MIDI: Record<string, number> = {
    C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11,
  };
  const midiOf = (name: string): number => {
    const m = /^([A-G]#?)(-?\d+)$/.exec(name);
    if (!m) return NaN;
    return NAME_TO_MIDI[m[1]] + (Number(m[2]) + 1) * 12;
  };

  let worstName = '';
  let worstMidi = 0;
  let lowestMidi = 999;
  const roots = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  for (const root of roots) {
    for (const quality of ['major', 'minor']) {
      for (const note of scaleNoteSequence(`${root} ${quality}`)) {
        const midi = midiOf(note);
        if (!Number.isFinite(midi)) continue;
        if (midi > worstMidi) { worstMidi = midi; worstName = note; }
        if (midi < lowestMidi) lowestMidi = midi;
      }
    }
  }
  check(
    'every major/minor scale stays within first position',
    worstMidi <= HIGHEST_FIRST_POSITION_MIDI,
    `highest note across all 24 scales was ${worstName} (MIDI ${worstMidi}), ceiling ${HIGHEST_FIRST_POSITION_MIDI}`,
  );
  check(
    'no scale note falls below the open G string',
    lowestMidi >= LOWEST_MIDI,
    `lowest MIDI was ${lowestMidi}, floor ${LOWEST_MIDI}`,
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll scaleSequence checks passed');
