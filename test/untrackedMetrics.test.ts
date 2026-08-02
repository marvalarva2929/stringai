/**
 * bowArmLevel / leftHandWrist should never generate practice evidence or
 * exercise recommendations — their camera measurement isn't tracked.
 *
 *   node --experimental-strip-types --loader ./test/ts-resolver.mjs test/untrackedMetrics.test.ts
 */

import { buildSessionEvidence } from '../src/lib/practiceEvidence';
import { scorePoseMetrics } from '../src/lib/poseScoring';
import type { AnalysisResult, MetricScore } from '../src/types/analysis';
import type { FrameKeypoints } from '../src/lib/poseScoring';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function metric(key: MetricScore['key'], score: number): MetricScore {
  return {
    key,
    score,
    flaggedTimestamps: [],
    severity: 'critical',
    events: [],
    occurrenceRate: 0.5,
    observationSummary: `${key} needs work.`,
  };
}

// ── scorePoseMetrics never computes these two metrics ───────────────────────
{
  const frame: FrameKeypoints = { timestamp: 0, poseLandmarks: null, leftHandLandmarks: null, rightHandLandmarks: null };
  const scores = scorePoseMetrics([frame], [], 'violin', 1);
  const keys = scores.map((s) => s.key);
  check('scorePoseMetrics never returns bowArmLevel', !keys.includes('bowArmLevel'), keys.join(','));
  check('scorePoseMetrics never returns leftHandWrist', !keys.includes('leftHandWrist'), keys.join(','));
}

// ── even a low-scoring bowArmLevel/leftHandWrist metric never becomes evidence ─
{
  const session: AnalysisResult = {
    sessionId: 's1', userId: 'u1', instrument: 'violin', durationSeconds: 60,
    recordedAt: '2026-07-10T12:00:00.000Z', overallScore: 40,
    metrics: [metric('bowArmLevel', 20), metric('leftHandWrist', 15)],
    audioMetrics: [], videoMetrics: [metric('bowArmLevel', 20), metric('leftHandWrist', 15)],
  };
  const evidence = buildSessionEvidence(session);
  check('a bad bowArmLevel/leftHandWrist session produces no evidence for them', !evidence.some((e) => e.metricKey === 'bowArmLevel' || e.metricKey === 'leftHandWrist'), evidence.map((e) => e.metricKey).join(','));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll untrackedMetrics checks passed');
