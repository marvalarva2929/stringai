/**
 * LLM curation grounding tests (Phase 3).
 *
 *   node --experimental-strip-types --loader ./test/ts-resolver.mjs test/practiceCuration.test.ts
 */

import { groundCuratedPlan, candidatesFromBlocks, parseCuratedResponse, type CuratedPlan } from '../src/lib/practiceCuration';
import type { PracticeEvidence } from '../src/lib/practiceEvidence';
import type { PracticeBlock } from '../src/lib/practiceBlocks';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

function issue(id: string, quality?: 'high' | 'proxy' | 'low'): PracticeEvidence {
  return {
    id, kind: 'pitch_note', metricKey: 'pitchAccuracy', title: id, reason: '', evidenceSummary: '',
    priority: 100, confidence: 0.8, supportsLive: true, requiresMic: true, requiresCamera: false,
    measurementAvailable: true, measurementQuality: quality, sessionCount: 1, target: { metricKey: 'pitchAccuracy' },
  };
}

const ISSUES: PracticeEvidence[] = [
  issue('pattern:finger_accuracy_gap'),                 // high (undefined)
  issue('pattern:bow_zone_camping'),                    // high
  issue('metric:leftHandWrist', 'proxy'),               // proxy — must not ground a root cause
  issue('metric:bowDistribution', 'low'),               // low
];

const FALLBACK = candidatesFromBlocks([
  { title: 'Deterministic Bow Drill', estimatedMinutes: 6, reason: 'camping',
    evidenceRefs: [{ evidenceId: 'pattern:bow_zone_camping', title: '', reason: '' }] } as PracticeBlock,
]);

// ─────────────────────────────────────────────────────────────
console.log('valid LLM plan passes through');
{
  const llm: CuratedPlan = {
    rootCauses: [{ id: 'rc1', label: 'Finger 3', explanation: '', issueIds: ['pattern:finger_accuracy_gap'], confidence: 0.7 }],
    blocks: [{ title: 'Finger 3 Landing', minutes: 6, issueIds: ['pattern:finger_accuracy_gap', 'pattern:bow_zone_camping'], whyThisDrill: '' }],
  };
  const g = groundCuratedPlan({ llm, issues: ISSUES, fallback: FALLBACK });
  check('not fallback', g.usedFallback === false);
  check('root cause kept', g.plan.rootCauses.length === 1);
  check('block kept with all ids', g.plan.blocks[0].issueIds.length === 2);
  check('nothing rejected', g.rejected.rootCauses.length === 0 && g.rejected.blocks.length === 0);
}

// ─────────────────────────────────────────────────────────────
console.log('\nhallucinated issueId is rejected');
{
  const llm: CuratedPlan = {
    rootCauses: [{ id: 'rc', label: 'x', explanation: '', issueIds: ['vibrato:primary'], confidence: 0.6 }], // not in ISSUES
    blocks: [
      { title: 'Phantom Vibrato', minutes: 6, issueIds: ['vibrato:primary'], whyThisDrill: '' },            // all unknown → dropped
      { title: 'Bow Drill', minutes: 6, issueIds: ['pattern:bow_zone_camping', 'made:up'], whyThisDrill: '' }, // partial → kept, id stripped
    ],
  };
  const g = groundCuratedPlan({ llm, issues: ISSUES, fallback: FALLBACK });
  check('root cause on unknown id rejected', g.rejected.rootCauses[0]?.reason === 'unknown-issue');
  check('fully-hallucinated block dropped', !g.plan.blocks.some((b) => b.title === 'Phantom Vibrato'));
  check('partially-hallucinated block kept', g.plan.blocks.some((b) => b.title === 'Bow Drill'));
  check('unknown id stripped from kept block', g.plan.blocks.find((b) => b.title === 'Bow Drill')?.issueIds.join(',') === 'pattern:bow_zone_camping');
  check('dropped block recorded', g.rejected.blocks.some((r) => r.block.title === 'Phantom Vibrato' && r.reason === 'no-valid-issues'));
}

// ─────────────────────────────────────────────────────────────
console.log('\nroot cause resting only on proxy quality is rejected');
{
  const llm: CuratedPlan = {
    // The exact failure Haiku produced: wrist proxy metric promoted to a cause.
    rootCauses: [
      { id: 'rc-wrist', label: 'Wrist collapse', explanation: '', issueIds: ['metric:leftHandWrist'], confidence: 0.76 },
      { id: 'rc-mixed', label: 'Finger + wrist', explanation: '', issueIds: ['pattern:finger_accuracy_gap', 'metric:leftHandWrist'], confidence: 0.7 },
    ],
    blocks: [{ title: 'Drill', minutes: 6, issueIds: ['pattern:finger_accuracy_gap'], whyThisDrill: '' }],
  };
  const g = groundCuratedPlan({ llm, issues: ISSUES, fallback: FALLBACK });
  check('proxy-only root cause rejected', g.rejected.rootCauses.some((r) => r.cause.id === 'rc-wrist' && r.reason === 'low-quality-basis'));
  check('mixed cause with a high-quality basis is kept', g.plan.rootCauses.some((c) => c.id === 'rc-mixed'));
  check('low-quality-only excluded from final plan', !g.plan.rootCauses.some((c) => c.id === 'rc-wrist'));
}

// ─────────────────────────────────────────────────────────────
console.log('\nfallback when LLM output is unusable');
{
  const nullG = groundCuratedPlan({ llm: null, issues: ISSUES, fallback: FALLBACK });
  check('null LLM → fallback', nullG.usedFallback && nullG.plan.blocks === FALLBACK);

  const allBad: CuratedPlan = { rootCauses: [], blocks: [{ title: 'x', minutes: 5, issueIds: ['nope'], whyThisDrill: '' }] };
  const g = groundCuratedPlan({ llm: allBad, issues: ISSUES, fallback: FALLBACK });
  check('all-invalid blocks → fallback', g.usedFallback && g.plan.blocks.length === FALLBACK.length);
}

// ─────────────────────────────────────────────────────────────
console.log('\ncandidatesFromBlocks maps evidence refs to issueIds');
{
  const spec = candidatesFromBlocks([
    { title: 'T', estimatedMinutes: 7, reason: 'because',
      evidenceRefs: [{ evidenceId: 'a', title: '', reason: '' }, { evidenceId: 'b', title: '', reason: '' }] } as PracticeBlock,
  ]);
  check('maps title/minutes/why', spec[0].title === 'T' && spec[0].minutes === 7 && spec[0].whyThisDrill === 'because');
  check('maps evidence ids', spec[0].issueIds.join(',') === 'a,b');
}

// ─────────────────────────────────────────────────────────────
console.log('\nparseCuratedResponse maps the Edge (snake_case) payload');
{
  const parsed = parseCuratedResponse({
    summary: 'x', insights: [],
    root_causes: [{ label: 'Bow arm', explanation: 'e', issue_ids: ['pattern:bow_zone_camping'], confidence: 0.8 }],
    blocks: [{ title: 'Bow Drill', minutes: 6, issue_ids: ['pattern:bow_zone_camping'], why_this_drill: 'because' }],
  })!;
  check('block snake_case mapped', parsed.blocks[0].title === 'Bow Drill' && parsed.blocks[0].minutes === 6 && parsed.blocks[0].issueIds[0] === 'pattern:bow_zone_camping');
  check('why_this_drill mapped', parsed.blocks[0].whyThisDrill === 'because');
  check('root cause mapped with fallback id', parsed.rootCauses[0].id === 'rc-0' && parsed.rootCauses[0].label === 'Bow arm');

  check('no blocks → null (drives fallback)', parseCuratedResponse({ root_causes: [], blocks: [] }) === null);
  check('garbage → null', parseCuratedResponse(null) === null && parseCuratedResponse('nope') === null);

  // End-to-end: parse an Edge payload, then ground it against the real issues.
  const grounded = groundCuratedPlan({
    llm: parseCuratedResponse({ blocks: [{ title: 'B', minutes: 5, issue_ids: ['pattern:bow_zone_camping'], why_this_drill: '' }], root_causes: [] }),
    issues: ISSUES, fallback: FALLBACK,
  });
  check('parsed-then-grounded plan is usable', !grounded.usedFallback && grounded.plan.blocks[0].title === 'B');
}

console.log('');
if (failures > 0) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log('All curation grounding checks passed');
