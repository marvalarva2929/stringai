/**
 * Opt-in live eval for the L10 coaching prompt — calls the real Claude API
 * (bypasses Supabase entirely, so this works even while the Edge Function
 * project is unreachable) with a handful of hand-planted scenarios and checks:
 *
 *   1. Grounding holds against REAL model output, not hand-crafted output —
 *      test/practiceCuration.test.ts only ever feeds groundCuratedPlan()
 *      fixtures a human wrote; this is the one place the real thing gets
 *      graded against the real grounding guards.
 *   2. The response is actually specific to the planted evidence, not generic
 *      "practice more" boilerplate — the direct regression test for "feedback
 *      is generic."
 *
 * NOT part of test:all / CI: costs real API calls and is nondeterministic,
 * same spirit as test:corpus. Requires ANTHROPIC_API_KEY.
 *
 *   ANTHROPIC_API_KEY=sk-ant-... node --experimental-strip-types --loader ./test/ts-resolver.mjs test/llmEval.test.ts
 */

import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT, OUTPUT_SCHEMA, buildUserContent, type CoachingInput } from '../supabase/functions/_shared/coachingPrompt';
import { groundCuratedPlan, parseCuratedResponse } from '../src/lib/practiceCuration';
import type { PracticeEvidence } from '../src/lib/practiceEvidence';

if (!process.env.ANTHROPIC_API_KEY) {
  console.log('ANTHROPIC_API_KEY not set — skipping live LLM eval.');
  console.log('Run with: ANTHROPIC_API_KEY=sk-ant-... npm run test:llm-eval');
  process.exit(0);
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function issue(over: Partial<PracticeEvidence> & { id: string; title: string; reason: string; evidenceSummary: string }): PracticeEvidence {
  return {
    kind: 'metric_fallback', metricKey: 'toneQuality', priority: 80, confidence: 0.8,
    supportsLive: true, requiresMic: true, requiresCamera: false,
    measurementAvailable: true, sessionCount: 1, target: { metricKey: 'toneQuality' },
    ...over,
  };
}

interface Fixture {
  name: string;
  issues: PracticeEvidence[];
  input: CoachingInput;
  /** At least one of these (case-insensitive) must appear in the model's text
   *  output — proof the response engaged with THIS evidence, not boilerplate. */
  expectAnyKeyword: string[];
  /** When set, the grounded root causes must include one covering at least
   *  this many of the planted issue ids (tests cross-signal merging). */
  expectMergedCauseOver?: number;
  /** When true, grounded root causes must be empty (clean-session case). */
  expectNoRootCauses?: boolean;
}

const toneIssue = issue({
  id: 'metric:toneQuality', title: 'Tone quality',
  reason: 'Ponticello — glassy, weak fundamental — in the upper half of the bow around 20s-35s and 50s-58s, where the bow sits too close to the bridge.',
  evidenceSummary: 'Recent score 58; severity needs_attention.',
});
const FIXTURES: Fixture[] = [
  {
    name: 'tone: ponticello fault',
    issues: [toneIssue],
    input: {
      instrument: 'violin', skillLevel: 'intermediate', playerCategory: 'refinement',
      metrics: [{ key: 'toneQuality', score: 58, severity: 'needs_attention', observationSummary: toneIssue.reason }],
      patternFindings: [],
      issues: [{ id: toneIssue.id, summary: `${toneIssue.title}: ${toneIssue.reason} ${toneIssue.evidenceSummary}`, quality: 'high' }],
    },
    expectAnyKeyword: ['bridge', 'ponticello', 'glassy'],
  },
  {
    name: 'vibrato: unstable on one note',
    issues: [issue({
      id: 'vibrato:primary', title: 'Vibrato consistency', metricKey: 'vibrato',
      reason: 'Vibrato was least stable on a sustained note in the middle of the piece — the oscillation is present but irregular.',
      evidenceSummary: '4.1 Hz, 12 cents depth, note score 48.',
    })],
    input: {
      instrument: 'violin', skillLevel: 'intermediate', playerCategory: 'refinement',
      metrics: [{ key: 'vibrato', score: 55, severity: 'needs_attention', observationSummary: 'Vibrato was inconsistent on sustained notes.' }],
      patternFindings: [],
      issues: [{ id: 'vibrato:primary', summary: 'Vibrato consistency: Vibrato was least stable on a sustained note — the oscillation is present but irregular. 4.1 Hz, 12 cents depth, note score 48.', quality: 'high' }],
    },
    expectAnyKeyword: ['vibrato'],
  },
  {
    name: 'cross-signal: bow-arm weight (camping + upper-bow tone + tip ceiling)',
    issues: (() => {
      const camping = issue({
        id: 'pattern:bow_zone_camping', title: 'Bow distribution', metricKey: 'bowDistribution',
        reason: 'Bow spent 78% of the session within the frog third of the bow — rarely reaching the middle or tip.',
        evidenceSummary: 'Frog zone: 78%; tip zone: 4%.',
      });
      const upperTone = issue({
        id: 'pattern:upper_bow_tone_degradation', title: 'Upper-bow tone', metricKey: 'toneQuality',
        reason: 'Tone quality drops sharply whenever the bow reaches the upper half.',
        evidenceSummary: 'Upper-bow tone score 41 vs lower-bow tone score 74.',
      });
      const tipCeiling = issue({
        id: 'pattern:tip_dynamic_ceiling', title: 'Tip dynamic ceiling', metricKey: 'dynamicControl',
        reason: 'Volume drops sharply whenever the bow nears the tip, capping the loudest dynamics.',
        evidenceSummary: 'Tip-zone loudness 45% lower than frog-zone loudness.',
      });
      return [camping, upperTone, tipCeiling];
    })(),
    input: {
      instrument: 'violin', skillLevel: 'intermediate', playerCategory: 'refinement',
      metrics: [
        { key: 'bowDistribution', score: 52, severity: 'needs_attention', observationSummary: 'Bow spent 78% of the session within the frog third.' },
        { key: 'toneQuality', score: 55, severity: 'needs_attention', observationSummary: 'Tone thins in the upper half of the bow.' },
        { key: 'dynamicControl', score: 58, severity: 'needs_attention', observationSummary: 'Volume drops sharply near the tip.' },
      ],
      patternFindings: [
        { testId: 'bow_zone_camping', summary: 'Bow spent 78% of the session within the frog third.', evidence: { groupA: { label: 'frog', value: 78 }, groupB: { label: 'tip', value: 4 } }, severity: 'significant' },
        { testId: 'upper_bow_tone_degradation', summary: 'Tone quality drops in the upper half of the bow.', evidence: { groupA: { label: 'upper', value: 41 }, groupB: { label: 'lower', value: 74 } }, severity: 'significant' },
        { testId: 'tip_dynamic_ceiling', summary: 'Volume drops sharply near the tip.', evidence: { groupA: { label: 'tip', value: 45 }, groupB: { label: 'frog', value: 82 } }, severity: 'moderate' },
      ],
      issues: [
        { id: 'pattern:bow_zone_camping', summary: 'Bow distribution: Bow spent 78% of the session within the frog third. Frog zone: 78%; tip zone: 4%.', quality: 'high' },
        { id: 'pattern:upper_bow_tone_degradation', summary: 'Upper-bow tone: Tone quality drops sharply whenever the bow reaches the upper half. Upper-bow tone score 41 vs lower-bow tone score 74.', quality: 'high' },
        { id: 'pattern:tip_dynamic_ceiling', summary: 'Tip dynamic ceiling: Volume drops sharply whenever the bow nears the tip. Tip-zone loudness 45% lower than frog-zone loudness.', quality: 'high' },
      ],
    },
    expectAnyKeyword: ['weight', 'arm', 'frog', 'camp'],
    expectMergedCauseOver: 1,
  },
  {
    name: 'clean session: no issues, must not hallucinate a root cause',
    issues: [],
    input: {
      instrument: 'violin', skillLevel: 'advanced', playerCategory: 'refinement',
      metrics: [
        { key: 'pitchAccuracy', score: 92, severity: 'excellent', observationSummary: 'Intonation was clean throughout.' },
        { key: 'toneQuality', score: 90, severity: 'excellent', observationSummary: 'Tone was clean and consistent.' },
      ],
      patternFindings: [],
      issues: [],
    },
    expectAnyKeyword: [], // no keyword requirement — nothing to be specific about
    expectNoRootCauses: true,
  },
];

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) console.log(`    ✓ ${name}`);
  else { failures++; console.error(`    ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function runFixture(fixture: Fixture) {
  console.log(`\n${fixture.name}`);
  let response;
  try {
    response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      output_config: { format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
      messages: [{ role: 'user', content: buildUserContent(fixture.input) }],
    } as any);
  } catch (err) {
    check('API call succeeded', false, err instanceof Error ? err.message : String(err));
    return;
  }

  const textBlock = (response as any).content?.find((b: any) => b.type === 'text');
  if (!textBlock) {
    check('response has a text block', false);
    return;
  }
  let data: any;
  try {
    data = JSON.parse(textBlock.text);
  } catch {
    check('response is valid JSON', false, textBlock.text.slice(0, 200));
    return;
  }

  const grounded = groundCuratedPlan({
    llm: parseCuratedResponse(data),
    issues: fixture.issues,
    fallback: [],
  });

  check(
    'no root cause rejected as unknown-issue (model invented an id)',
    !grounded.rejected.rootCauses.some((r) => r.reason === 'unknown-issue'),
    JSON.stringify(grounded.rejected.rootCauses),
  );

  if (fixture.expectNoRootCauses) {
    check('no hallucinated root cause on a clean session', grounded.plan.rootCauses.length === 0);
  }

  if (fixture.expectMergedCauseOver != null) {
    check(
      `at least one root cause merges >${fixture.expectMergedCauseOver} planted issues`,
      grounded.plan.rootCauses.some((c) => c.issueIds.length > fixture.expectMergedCauseOver!),
      JSON.stringify(grounded.plan.rootCauses.map((c) => c.issueIds)),
    );
  }

  if (fixture.expectAnyKeyword.length > 0) {
    const haystack = [
      data.summary,
      ...(data.insights ?? []).flatMap((i: any) => [i.observation, i.feedback]),
      ...(data.root_causes ?? []).flatMap((c: any) => [c.label, c.explanation]),
    ].join(' ').toLowerCase();
    const hit = fixture.expectAnyKeyword.find((k) => haystack.includes(k.toLowerCase()));
    check(
      `response is specific to the evidence (mentions one of: ${fixture.expectAnyKeyword.join(', ')})`,
      !!hit,
      haystack.slice(0, 300),
    );
  }
}

(async () => {
  for (const fixture of FIXTURES) {
    await runFixture(fixture);
  }
  if (failures > 0) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\nall passed');
})();
