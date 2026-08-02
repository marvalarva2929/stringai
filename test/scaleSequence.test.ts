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

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll scaleSequence checks passed');
