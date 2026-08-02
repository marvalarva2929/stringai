/**
 * Bow usage analysis test harness.
 *
 *   node --experimental-strip-types --loader ./test/ts-resolver.mjs test/bowUsage.test.ts
 *   (or: npm run test:bowusage)
 *
 * analyzeBowUsage must catch the case raw min/max range cannot: playing only
 * one region of the bow with wide local travel, and must resist outlier
 * detection frames faking full-bow usage.
 */

import { analyzeBowUsage, bowZoneLabel } from '../src/lib/bowAnalysis';

let failures = 0;

function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** n samples uniformly spread over [lo, hi]. */
function sweep(lo: number, hi: number, n = 60): number[] {
  return Array.from({ length: n }, (_, i) => lo + ((hi - lo) * i) / (n - 1));
}

// ─────────────────────────────────────────────────────────────
console.log('\nFull-bow détaché');
{
  const u = analyzeBowUsage(sweep(0.1, 0.9))!;
  check('robust range ≈ full', u.robustRange > 0.65, `got ${u.robustRange.toFixed(2)}`);
  check('no camping', u.campedZone === null, `got ${u.campedZone}`);
}

console.log('\nUpper-half-only playing (the reported bug)');
{
  // Contact sweeps 0.5 → 1.0 repeatedly — raw range would be ~0.5 ("good")
  const u = analyzeBowUsage(sweep(0.5, 1.0))!;
  check('camping detected', u.campedZone !== null, `campedZone=${u.campedZone}`);
  check('camped in upper half', u.campedZone === 'upper half' || u.campedZone === 'upper',
    `got ${u.campedZone}`);
  check('camped share ≈ 100%', u.campedShare > 0.95, `got ${u.campedShare.toFixed(2)}`);
  check('upperHalfShare ≈ 1', u.upperHalfShare > 0.95, `got ${u.upperHalfShare.toFixed(2)}`);
}

console.log('\nTip-only playing');
{
  const u = analyzeBowUsage(sweep(0.7, 0.95))!;
  check('camped in upper third', u.campedZone === 'upper', `got ${u.campedZone}`);
  check('label mentions the tip', bowZoneLabel(u.campedZone!).includes('tip'));
}

console.log('\nFrog-only playing');
{
  const u = analyzeBowUsage(sweep(0.05, 0.28))!;
  check('camped in lower third', u.campedZone === 'lower', `got ${u.campedZone}`);
  check('label mentions the frog', bowZoneLabel(u.campedZone!).includes('frog'));
}

console.log('\nOutlier robustness');
{
  // Narrow middle usage + two glitched frames at the extremes: raw range
  // would read 0.9; robust range must stay narrow.
  const vals = [...sweep(0.45, 0.55, 58), 0.02, 0.95];
  const u = analyzeBowUsage(vals)!;
  check('robust range stays narrow', u.robustRange < 0.2, `got ${u.robustRange.toFixed(2)}`);
  check('camped in middle', u.campedZone === 'middle', `got ${u.campedZone}`);
}

console.log('\nBalanced two-zone playing is not camping');
{
  // Half the samples near the frog, half near the tip — unusual but not camping
  const u = analyzeBowUsage([...sweep(0.1, 0.3, 30), ...sweep(0.7, 0.9, 30)])!;
  check('no camping', u.campedZone === null, `got ${u.campedZone}`);
  check('wide robust range', u.robustRange > 0.6, `got ${u.robustRange.toFixed(2)}`);
}

console.log('\nEdge cases');
{
  check('empty input → null', analyzeBowUsage([]) === null);
  const single = analyzeBowUsage([0.5])!;
  check('single sample handled', single.n === 1 && single.robustRange === 0);
}

// ─────────────────────────────────────────────────────────────
console.log('');
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('All bow usage checks passed');
