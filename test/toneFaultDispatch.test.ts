/**
 * Fine-grained tone-fault dispatch tests (Step 5).
 *
 *   node --experimental-strip-types --loader ./test/ts-resolver.mjs test/toneFaultDispatch.test.ts
 */

import { buildSessionEvidence } from '../src/lib/practiceEvidence';
import { rankPracticeEvidence } from '../src/lib/practiceRanking';
import { buildPracticeBlocks } from '../src/lib/practiceBlocks';
import type { AnalysisResult, MetricScore } from '../src/types/analysis';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function toneMetric(score: number, faultType: string, count = 4): MetricScore {
  return {
    key: 'toneQuality',
    score,
    flaggedTimestamps: [],
    severity: 'needs_attention',
    events: Array.from({ length: count }, () => ({ type: faultType, startSeconds: 0, endSeconds: 1 })),
    occurrenceRate: 0.3,
    observationSummary: `Recurring ${faultType} tone.`,
  };
}

function session(metrics: MetricScore[]): AnalysisResult {
  return {
    sessionId: 's1', userId: 'u1', instrument: 'violin', durationSeconds: 60,
    recordedAt: '2026-07-10T12:00:00.000Z', overallScore: 70, metrics,
    audioMetrics: metrics, videoMetrics: [],
  };
}

function blocksFor(metric: MetricScore) {
  const evidence = buildSessionEvidence(session([metric]));
  const ranked = rankPracticeEvidence(evidence);
  return buildPracticeBlocks(ranked);
}

// ── thin tone routes to the thin-specific drill ──────────────────────────────
{
  const blocks = blocksFor(toneMetric(60, 'thin'));
  const block = blocks.find((b) => b.target.metricKey === 'toneQuality');
  check('thin tone → Bow Weight Trainer', block?.title === 'Bow Weight Trainer', block?.title);
  check('evaluator disallows only thin', block?.evaluator?.evaluatorId === 'toneFault'
    && JSON.stringify(block.evaluator.disallowedFaults) === JSON.stringify(['thin']));
}

// ── scratch tone routes to the pressure-specific drill ───────────────────────
{
  const blocks = blocksFor(toneMetric(60, 'scratch'));
  const block = blocks.find((b) => b.target.metricKey === 'toneQuality');
  check('scratch tone → Pressure Release Trainer', block?.title === 'Pressure Release Trainer', block?.title);
}

// ── an unrecognized fault falls back to the generic tone block ───────────────
{
  const blocks = blocksFor(toneMetric(60, 'whistle'));
  const block = blocks.find((b) => b.target.metricKey === 'toneQuality');
  check('whistle tone → generic Tone Contact Check (unhandled by the fine-grained evaluator)', block?.title === 'Tone Contact Check', block?.title);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll toneFaultDispatch checks passed');
