/**
 * Note grouping (L5) test harness.
 *
 *   node --experimental-strip-types --loader ./test/ts-resolver.mjs test/noteGrouping.test.ts
 *   (or: npm run test:notegrouping)
 *
 * Synthetic NoteEvent[] + bow direction series → verifies slur runs, détaché
 * boundaries, the every-note-in-exactly-one-group invariant, and degradation
 * to 'other' groups when the bow signal is absent.
 */

import { groupNotes } from '../src/lib/noteGrouping';
import type { NoteGroup } from '../src/lib/noteGrouping';
import type { NoteEvent } from '../src/lib/noteFusion';
import { createTimeSeries } from '../src/types/signals';
import type { TimeSeries, TimeSeriesPoint } from '../src/types/signals';

let failures = 0;

function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Minimal NoteEvent — only timing matters for grouping. */
function note(start: number, end: number): NoteEvent {
  return {
    startSeconds: start, endSeconds: end, durationSeconds: end - start,
    pitchHz: 440, noteName: 'A4', string: 'A', inferredFinger: 0, positionGroup: 'first',
    centsDeviation: 0, absCentsDeviation: 0, inTune: true,
    fundamentalRatio: 0.8, dynamicLevel: 0.5,
    bowContactPoint: null, bowAngle: null, bowDistanceFromBridge: null, bowZone: null,
    wristCollapsed: null, shoulderRaised: null,
    distanceFromCrossing: null, phrasePosition: 0, phraseDurationSeconds: 0,
  };
}

/** Direction series at 10fps from a piecewise map: [untilT, dir][]. */
function dirSeries(spans: Array<[number, -1 | 0 | 1 | null]>, duration: number): TimeSeries<-1 | 0 | 1 | null> {
  const pts: Array<TimeSeriesPoint<-1 | 0 | 1 | null>> = [];
  for (let t = 0; t < duration; t += 0.1) {
    const span = spans.find(([until]) => t < until);
    pts.push({ t, v: span ? span[1] : null });
  }
  return createTimeSeries(pts);
}

function invariantHolds(notes: NoteEvent[], groups: NoteGroup[]): boolean {
  const seen = new Set<number>();
  for (const g of groups) for (const id of g.noteIds) {
    if (seen.has(id)) return false;
    seen.add(id);
  }
  return seen.size === notes.length;
}

// ─────────────────────────────────────────────────────────────
console.log('\nThree notes under one bow → single slur group');
{
  const notes = [note(0, 0.4), note(0.4, 0.8), note(0.8, 1.2)];
  const dirs = dirSeries([[1.2, 1]], 1.2);
  const groups = groupNotes(notes, dirs);
  check('1 group', groups.length === 1, `got ${groups.length}`);
  check('type slur', groups[0]?.type === 'slur', `got ${groups[0]?.type}`);
  check('covers all 3 notes', groups[0]?.noteIds.length === 3);
  check('confidence 1', groups[0]?.confidence === 1, `got ${groups[0]?.confidence}`);
  check('invariant: every note in exactly one group', invariantHolds(notes, groups));
}

console.log('\nAlternating direction → détaché (one group per note)');
{
  const notes = [note(0, 0.5), note(0.5, 1.0), note(1.0, 1.5), note(1.5, 2.0)];
  const dirs = dirSeries([[0.5, 1], [1.0, -1], [1.5, 1], [2.0, -1]], 2.0);
  const groups = groupNotes(notes, dirs);
  check('4 groups', groups.length === 4, `got ${groups.length}: ${JSON.stringify(groups.map(g => g.noteIds))}`);
  check('all detache', groups.every(g => g.type === 'detache'), `got ${groups.map(g => g.type).join(',')}`);
  check('invariant holds', invariantHolds(notes, groups));
}

console.log('\nTwo slurred + two slurred (flip in the middle)');
{
  const notes = [note(0, 0.4), note(0.4, 0.8), note(0.8, 1.2), note(1.2, 1.6)];
  const dirs = dirSeries([[0.8, 1], [1.6, -1]], 1.6);
  const groups = groupNotes(notes, dirs);
  check('2 groups', groups.length === 2, `got ${groups.length}: ${JSON.stringify(groups.map(g => g.noteIds))}`);
  check('both slurs', groups.every(g => g.type === 'slur'), `got ${groups.map(g => g.type).join(',')}`);
  check('split 2+2', groups[0]?.noteIds.length === 2 && groups[1]?.noteIds.length === 2,
    `got ${JSON.stringify(groups.map(g => g.noteIds))}`);
  check('invariant holds', invariantHolds(notes, groups));
}

console.log('\nNo bow signal → all groups typed other, confidence 0');
{
  const notes = [note(0, 0.5), note(0.5, 1.0)];
  const dirs = dirSeries([[1.0, null]], 1.0);
  const groups = groupNotes(notes, dirs);
  check('all other', groups.every(g => g.type === 'other'), `got ${groups.map(g => g.type).join(',')}`);
  check('confidence 0', groups.every(g => g.confidence === 0));
  check('invariant holds', invariantHolds(notes, groups));
}

console.log('\nStationary samples are neutral (do not break a slur)');
{
  // Direction: +1, brief stationary during the middle note, +1 again
  const notes = [note(0, 0.4), note(0.4, 0.8), note(0.8, 1.2)];
  const dirs = dirSeries([[0.5, 1], [0.7, 0], [1.2, 1]], 1.2);
  const groups = groupNotes(notes, dirs);
  check('1 slur group', groups.length === 1 && groups[0].type === 'slur',
    `got ${groups.length} groups: ${groups.map(g => g.type).join(',')}`);
  check('invariant holds', invariantHolds(notes, groups));
}

console.log('\nEmpty input');
{
  const groups = groupNotes([], dirSeries([[1, 1]], 1));
  check('empty output', groups.length === 0);
}

// ─────────────────────────────────────────────────────────────
console.log('');
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('All note grouping checks passed');
