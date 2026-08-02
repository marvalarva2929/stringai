/**
 * L10 coaching data-pipeline tests — the plumbing between L1-L9 evidence and
 * what actually reaches (and comes back from) the LLM. Deterministic, no
 * network. Complements test/practiceCuration.test.ts (grounding logic itself)
 * by exercising the client wiring around it.
 *
 *   node --experimental-strip-types --loader ./test/ts-resolver.mjs test/llmFeedback.test.ts
 */

import { issuesForCoaching, buildCoachingInput } from '../src/lib/coachingInput';
import { applyCuratedCopy, type CuratedBlockSpec } from '../src/lib/practiceCuration';
import type { PracticeEvidence } from '../src/lib/practiceEvidence';
import type { PracticeBlock } from '../src/lib/practiceBlocks';
import type { MetricScore } from '../src/types/analysis';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

function evidence(over: Partial<PracticeEvidence>): PracticeEvidence {
  return {
    id: 'x', kind: 'metric_fallback', metricKey: 'toneQuality', title: 'Tone quality',
    reason: '', evidenceSummary: '', priority: 60, confidence: 0.6,
    supportsLive: true, requiresMic: true, requiresCamera: false,
    measurementAvailable: true, sessionCount: 1, target: { metricKey: 'toneQuality' },
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────
console.log('issuesForCoaching preserves specific detail (regression: reason was being dropped)');
{
  // This is exactly the tone-quality shape addMetricEvidence produces today:
  // `reason` carries the specific per-section fault narrative from
  // toneAnalysis.ts's buildObservation(); `evidenceSummary` is the generic
  // score/severity fallback. Both must survive into the compacted string.
  const tone = evidence({
    id: 'metric:toneQuality',
    reason: 'Scratch in the upper bow around 12s-15s — ease bow pressure near the frog.',
    evidenceSummary: 'Recent score 62; severity moderate.',
  });
  const [compacted] = issuesForCoaching([tone]);
  check('specific fault text present', compacted.summary.includes('Scratch'), compacted.summary);
  check('generic score text also present', compacted.summary.includes('Recent score 62'), compacted.summary);

  // Vibrato/rhythm/pitch (dedicated evidence builders) already put their
  // specific detail in evidenceSummary with an empty-ish reason in some
  // paths — make sure a reason-less issue still compacts cleanly.
  const noReason = evidence({ id: 'vibrato:primary', reason: '', evidenceSummary: '5.2 Hz, 18 cents depth, note score 61.' });
  const [compacted2] = issuesForCoaching([noReason]);
  check('no leading/trailing junk when reason is empty', compacted2.summary === 'Tone quality: 5.2 Hz, 18 cents depth, note score 61.', compacted2.summary);
}

// ─────────────────────────────────────────────────────────────
console.log('\nissuesForCoaching maps measurement quality');
{
  const proxy = evidence({ id: 'a', measurementQuality: 'proxy' });
  const high = evidence({ id: 'b', measurementQuality: undefined });
  const [a, b] = issuesForCoaching([proxy, high]);
  check('proxy preserved', a.quality === 'proxy');
  check('undefined maps to high', b.quality === 'high');
}

// ─────────────────────────────────────────────────────────────
console.log('\nbuildCoachingInput threads issues/phraseFeatures/findings through');
{
  const metrics: MetricScore[] = [{
    key: 'toneQuality', score: 62, severity: 'needs_attention', flaggedTimestamps: [],
    events: [], occurrenceRate: 0.3, observationSummary: 'Some scratch in the upper bow.',
  }];
  const issues = [evidence({ id: 'metric:toneQuality', reason: 'Scratch in the upper bow.' })];
  const input = buildCoachingInput(metrics, 'refinement', 'intermediate', undefined, [], undefined, issues);
  check('metrics mapped', input.metrics.length === 1 && input.metrics[0].key === 'toneQuality');
  check('issues compacted via issuesForCoaching', input.issues?.[0]?.summary.includes('Scratch') ?? false);
  check('skillLevel/playerCategory threaded', input.skillLevel === 'intermediate' && input.playerCategory === 'refinement');

  const noIssues = buildCoachingInput(metrics, 'refinement', 'intermediate');
  check('issues undefined when not provided', noIssues.issues === undefined);
}

// ─────────────────────────────────────────────────────────────
console.log('\napplyCuratedCopy overlays whyThisDrill by shared issue id, nothing else changes');
{
  const blocks: PracticeBlock[] = [
    {
      id: 'block-bow', type: 'bow_control', title: 'Frog-to-tip draws', subtitle: '', reason: 'deterministic reason',
      estimatedMinutes: 6, coachIntensity: 'balanced', instructions: [],
      target: {} as PracticeBlock['target'], liveMode: {} as PracticeBlock['liveMode'],
      successCriteria: {} as PracticeBlock['successCriteria'], fallbackCriteria: '', coachPromptContext: '',
      evidenceRefs: [{ evidenceId: 'pattern:bow_zone_camping', title: '', reason: '' }],
    },
    {
      id: 'block-pitch', type: 'pitch_landing', title: 'F# landing', subtitle: '', reason: 'unrelated deterministic reason',
      estimatedMinutes: 5, coachIntensity: 'balanced', instructions: [],
      target: {} as PracticeBlock['target'], liveMode: {} as PracticeBlock['liveMode'],
      successCriteria: {} as PracticeBlock['successCriteria'], fallbackCriteria: '', coachPromptContext: '',
      evidenceRefs: [{ evidenceId: 'pitch_note:F#4', title: '', reason: '' }],
    },
  ];
  const curated: CuratedBlockSpec[] = [
    { title: 'Bow weight drill', minutes: 6, issueIds: ['pattern:bow_zone_camping'], whyThisDrill: 'Your bow never carries weight past the middle.' },
  ];
  const result = applyCuratedCopy(blocks, curated);
  check('matched block gets curated reason', result[0].reason === 'Your bow never carries weight past the middle.');
  check('matched block keeps its id/type/target identity', result[0].id === 'block-bow' && result[0].type === 'bow_control');
  check('unmatched block keeps deterministic reason', result[1].reason === 'unrelated deterministic reason');
  check('empty curated list is a no-op', applyCuratedCopy(blocks, [])[0].reason === 'deterministic reason');
}

// ─────────────────────────────────────────────────────────────
if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
} else {
  console.log('\nall passed');
}
