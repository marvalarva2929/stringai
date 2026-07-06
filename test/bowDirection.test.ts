/**
 * Bow direction test harness.
 *
 *   node --experimental-strip-types --loader ./test/ts-resolver.mjs test/bowDirection.test.ts
 *   (or: npm run test:bowdirection)
 *
 * Builds synthetic RawBowFrame sequences with a known contact-point trajectory
 * and checks that deriveBowTimeSeries().bowDirection recovers stroke direction,
 * holds steady through single-frame jitter (hysteresis), degrades to null on
 * contact gaps, and uses the tip-projection fallback when contact is missing.
 */

import { deriveBowTimeSeries } from '../src/lib/bowAnalysis';
import type { BowDirection } from '../src/lib/bowAnalysis';
import type { RawBowFrame } from '../src/types/signals';

let failures = 0;

function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// Horizontal bow: frog at x=0.2, tip at x=0.8, both at y=0.5.
// Contact point parameter u maps to contact x = 0.2 + u * 0.6.
const FROG = { x: 0.2, y: 0.5 };
const TIP  = { x: 0.8, y: 0.5 };

/** Frame at time t with the contact at parameter u along the frog→tip axis. */
function frameAtU(t: number, u: number, opts: { contactVisible?: boolean } = {}): RawBowFrame {
  return {
    timestamp: t,
    tipX: TIP.x,   tipY: TIP.y,   tipVisible: true,
    frogX: FROG.x, frogY: FROG.y, frogVisible: true,
    contactX: FROG.x + u * (TIP.x - FROG.x),
    contactY: FROG.y,
    contactVisible: opts.contactVisible ?? true,
    confidence: 0.9,
  };
}

/** 10 fps sequence following a u(t) trajectory. */
function sequence(us: number[], startT = 0): RawBowFrame[] {
  return us.map((u, i) => frameAtU(startT + i * 0.1, u));
}

function directions(frames: RawBowFrame[]): Array<BowDirection | null> {
  const series = deriveBowTimeSeries(frames).bowDirection;
  return series.points.map((p) => p.v);
}

// ─────────────────────────────────────────────────────────────
console.log('\nSteady tipward stroke');
{
  // u climbs 0.05/frame = 0.5 bow-lengths/sec, well above the 0.05 threshold
  const dirs = directions(sequence([0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45]));
  const settled = dirs.slice(2);
  check('later frames all +1', settled.every((d) => d === 1), `got ${JSON.stringify(dirs)}`);
  check('no -1 anywhere', dirs.every((d) => d !== -1), `got ${JSON.stringify(dirs)}`);
}

console.log('\nSteady frogward stroke');
{
  const dirs = directions(sequence([0.9, 0.85, 0.8, 0.75, 0.7, 0.65, 0.6, 0.55]));
  const settled = dirs.slice(2);
  check('later frames all -1', settled.every((d) => d === -1), `got ${JSON.stringify(dirs)}`);
}

console.log('\nStationary bow');
{
  // u drifts ±0.001/frame = 0.01 bow-lengths/sec, under the stationary threshold
  const dirs = directions(sequence([0.5, 0.501, 0.5, 0.499, 0.5, 0.501, 0.5]));
  const settled = dirs.filter((d) => d !== null);
  check('all settled frames are 0', settled.every((d) => d === 0), `got ${JSON.stringify(dirs)}`);
}

console.log('\nDirection change (tipward → frogward)');
{
  const dirs = directions(sequence([0.1, 0.2, 0.3, 0.4, 0.5, 0.4, 0.3, 0.2, 0.1]));
  check('starts +1', dirs[2] === 1, `got ${JSON.stringify(dirs)}`);
  check('ends -1', dirs[dirs.length - 1] === -1, `got ${JSON.stringify(dirs)}`);
  const firstNeg = dirs.indexOf(-1);
  check('flip happens after the turn', firstNeg > 4, `first -1 at index ${firstNeg}`);
}

console.log('\nSingle-frame jitter does not flip direction (hysteresis)');
{
  // Steady climb with one glitched sample dropping backwards
  const dirs = directions(sequence([0.1, 0.15, 0.2, 0.25, 0.18, 0.3, 0.35, 0.4, 0.45]));
  const settled = dirs.slice(2);
  check('direction stays +1 through the glitch', settled.every((d) => d === 1), `got ${JSON.stringify(dirs)}`);
}

console.log('\nContact-null gap uses tip-projection fallback');
{
  // Whole bow (tip + frog) translating rightward with contact never visible:
  // tip moves along the bow axis — fallback should still read tipward motion.
  const frames: RawBowFrame[] = [];
  for (let i = 0; i < 8; i++) {
    const dx = i * 0.03; // 0.3/sec along a 0.6-length bow = 0.5 bow-lengths/sec
    frames.push({
      timestamp: i * 0.1,
      tipX: TIP.x + dx,  tipY: TIP.y,  tipVisible: true,
      frogX: FROG.x + dx, frogY: FROG.y, frogVisible: true,
      contactX: 0, contactY: 0, contactVisible: false,
      confidence: 0.9,
    });
  }
  const dirs = directions(frames);
  const settled = dirs.slice(2);
  check('fallback reads +1', settled.every((d) => d === 1), `got ${JSON.stringify(dirs)}`);
}

console.log('\nLong gap resets direction to null');
{
  const first = sequence([0.1, 0.2, 0.3, 0.4]);
  const second = sequence([0.5, 0.5, 0.5], 2.0); // 1.6s gap
  const dirs = directions([...first, ...second]);
  check('frame after gap is null or 0 (not stale +1)', dirs[4] !== 1, `got ${JSON.stringify(dirs)}`);
}

console.log('\nEmpty and tiny inputs');
{
  check('empty input → empty series', directions([]).length === 0);
  const single = directions([frameAtU(0, 0.5)]);
  check('single frame → null direction', single.length === 1 && single[0] === null, `got ${JSON.stringify(single)}`);
}

// ─────────────────────────────────────────────────────────────
console.log('');
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('All bow direction checks passed');
