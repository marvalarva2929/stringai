/**
 * Positions: correct naming, and never generating above what the player was asked.
 *
 *   node --experimental-strip-types --loader ./test/ts-resolver.mjs test/positionCap.test.ts
 *
 * Two separate bugs met here. A shifting ladder on the A string asked a player
 * to go B4 → E5 off the back of a single "yes, I can shift to 3rd position":
 *
 *   1. POSITION_BASE had `fifth` at +7 and `seventh` at +10 semitones, which are
 *      4th and 6th position. So the drill both picked a note it shouldn't have
 *      and told the player the wrong hand position to play it in.
 *   2. Nothing capped generation at the only position the app ever asks about.
 */

import {
  GENERATABLE_POSITIONS,
  POSITION_BASE,
  clampPosition,
  midiFor,
} from '../src/lib/exercises/fingerboard';
import { midiToNoteName } from '../src/lib/pitchNaming';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ── Position naming ─────────────────────────────────────────────────────────
//
// Positions count diatonic steps up the string, so the 1st finger climbs one
// scale degree per position. On the A string: 1st B4, 2nd C#5, 3rd D5, 4th E5,
// 5th F#5.
console.log('\nPosition names match where the 1st finger actually sits:');
{
  const onA = (p: Parameters<typeof midiFor>[1]) => midiToNoteName(midiFor('A', p, 1));
  const onG = (p: Parameters<typeof midiFor>[1]) => midiToNoteName(midiFor('G', p, 1));

  check('A string, 1st position 1st finger is B4', onA('first') === 'B4', onA('first'));
  check('A string, 3rd position 1st finger is D5', onA('third') === 'D5', onA('third'));
  check('A string, 5th position 1st finger is F#5', onA('fifth') === 'F#5', onA('fifth'));
  check('A string, 7th position 1st finger is A5', onA('seventh') === 'A5', onA('seventh'));

  check('G string, 1st position 1st finger is A3', onG('first') === 'A3', onG('first'));
  check('G string, 3rd position 1st finger is C4', onG('third') === 'C4', onG('third'));
  check('G string, 5th position 1st finger is E4', onG('fifth') === 'E4', onG('fifth'));
  check('G string, 7th position 1st finger is G4', onG('seventh') === 'G4', onG('seventh'));

  // The specific mislabel: E5 on the A string is 4th position, and calling it
  // 5th is what made the old +7 wrong.
  check(
    'E5 on the A string is NOT any generatable position name',
    onA('third') !== 'E5' && onA('fifth') !== 'E5',
    `third=${onA('third')} fifth=${onA('fifth')}`,
  );
  check('positions climb by at least a whole step each', POSITION_BASE.seventh > POSITION_BASE.fifth
    && POSITION_BASE.fifth > POSITION_BASE.third
    && POSITION_BASE.third > POSITION_BASE.first);
}

// ── The cap ─────────────────────────────────────────────────────────────────
console.log('\nGenerated drills stay inside what the player was asked about:');
{
  check(
    'nothing generatable above third',
    !GENERATABLE_POSITIONS.includes('fifth') && !GENERATABLE_POSITIONS.includes('seventh'),
    GENERATABLE_POSITIONS.join(','),
  );
  check(
    'first and third are available',
    GENERATABLE_POSITIONS.includes('first') && GENERATABLE_POSITIONS.includes('third'),
  );
  check('fifth clamps to third', clampPosition('fifth') === 'third');
  check('seventh clamps to third', clampPosition('seventh') === 'third');
  check('third is unchanged', clampPosition('third') === 'third');
  check('first is unchanged', clampPosition('first') === 'first');

  // The reported ladder, clamped: it now tops out on the 3rd-position note.
  check(
    'a clamped A-string ladder tops out at D5',
    midiToNoteName(midiFor('A', clampPosition('fifth'), 1)) === 'D5',
    midiToNoteName(midiFor('A', clampPosition('fifth'), 1)),
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll position checks passed');
