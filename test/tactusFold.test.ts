import { foldToTactus } from '../src/lib/practiceBlocks';
let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
console.log('\nTactus folding (the 160 BPM bug):');
// bpmEst inverts the modal inter-onset interval, so it reports a NOTE rate.
// Eighth notes at quarter=80 report 160; the old code clamped with Math.min(160,…)
// and asked the player to bow one note per click at that rate — twice the speed
// they had just played, and always the same round number.
check('eighth notes at quarter=80 fold back to 80', foldToTactus(160) === 80, String(foldToTactus(160)));
check('sixteenths at 84 fold to 84', Math.round(foldToTactus(336)!) === 84, String(foldToTactus(336)));
check('a plausible pulse is left alone', foldToTactus(80) === 80, String(foldToTactus(80)));
check('a genuinely slow pulse is not doubled', foldToTactus(44) === 44, String(foldToTactus(44)));
check('44 stays 44 rather than becoming 88', foldToTactus(44) !== 88);
check('no value survives above the plausible ceiling', [160, 200, 240, 336, 400].every((b) => foldToTactus(b)! <= 100));
check('nothing folds below a tappable pulse', [101, 110, 120, 160, 240].every((b) => foldToTactus(b)! >= 50), 
  [101,110,120,160,240].map((b)=>`${b}->${foldToTactus(b)!.toFixed(0)}`).join(' '));
check('missing input yields null', foldToTactus(undefined) === null && foldToTactus(null) === null);
check('nonsense input yields null', foldToTactus(0) === null && foldToTactus(-5) === null && foldToTactus(NaN) === null);
if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nAll tactus checks passed');
