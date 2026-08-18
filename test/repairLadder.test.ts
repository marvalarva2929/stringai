/**
 * The repair ladder's rung structure.
 *
 *   node --experimental-strip-types --loader ./test/ts-resolver.mjs test/repairLadder.test.ts
 */

import { buildStages, REQUIRED_ALONE, REQUIRED_INTERVAL } from '../src/lib/repairLadder';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

console.log('\nEvery miss gets the note alone, then the note approached:');
{
  const stages = buildStages(['B3', 'E4'], ['A3', 'D4']);
  check('two notes make four rungs', stages.length === 4, String(stages.length));
  check('isolated rung comes first for each note',
    stages[0].from === null && stages[2].from === null,
    stages.map((s) => `${s.from ?? '-'}->${s.note}`).join(' '));
  check('interval rung follows its own note',
    stages[1].note === 'B3' && stages[1].from === 'A3'
    && stages[3].note === 'E4' && stages[3].from === 'D4',
    stages.map((s) => `${s.from ?? '-'}->${s.note}`).join(' '));
  check('the isolated rung asks for more landings',
    stages[0].required === REQUIRED_ALONE && stages[1].required === REQUIRED_INTERVAL);
}

console.log('\nA miss with nothing before it gets only the isolated rung:');
{
  // The first note of a scale is arrived at from silence in the take too, so
  // there is no interval to drill.
  const stages = buildStages(['G3'], ['']);
  check('one rung only', stages.length === 1, String(stages.length));
  check('and it is the isolated one', stages[0].from === null);
}

console.log('\nDegenerate inputs:');
{
  check('no notes, no rungs', buildStages([], []).length === 0);
  check('missing predecessors are tolerated', buildStages(['A4', 'B4'], []).length === 2);
  // A repeated note is not an interval — drilling "A4 approached from A4" would
  // be the isolated rung wearing a hat.
  const repeated = buildStages(['A4'], ['A4']);
  check('a note approached from itself gets no interval rung', repeated.length === 1, String(repeated.length));
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nAll repair ladder checks passed');
