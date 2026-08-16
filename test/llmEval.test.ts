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
 * same spirit as test:corpus. Requires HF_TOKEN.
 *
 *   HF_TOKEN=hf_... node --experimental-strip-types --loader ./test/ts-resolver.mjs test/llmEval.test.ts
 */

import OpenAI from 'openai';
import {
  BANNED_GENERIC_PHRASES,
  SYSTEM_PROMPT,
  COACHING_BASE_URL,
  COACHING_MODEL,
  COACHING_EXTRA_PARAMS,
  RESPONSE_FORMAT,
  buildUserContent,
  type CoachingInput,
} from '../supabase/functions/_shared/coachingPrompt';
import { groundCuratedPlan, parseCuratedResponse } from '../src/lib/practiceCuration';
import type { PracticeEvidence } from '../src/lib/practiceEvidence';

if (!process.env.HF_TOKEN) {
  console.log('HF_TOKEN not set — skipping live LLM eval.');
  console.log('Run with: HF_TOKEN=hf_... npm run test:llm-eval');
  process.exit(0);
}

const client = new OpenAI({
  baseURL: COACHING_BASE_URL,
  apiKey: process.env.HF_TOKEN,
});

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
  /**
   * When set, the response must engage with the musical evidence: at least this
   * many phrase_feedback entries, each pointing at a real phrase. This is the
   * check that fails a generic answer.
   */
  expectPhraseFeedback?: number;
}

const toneIssue = issue({
  id: 'metric:toneQuality', title: 'Tone quality',
  reason: 'Ponticello — glassy, weak fundamental — in the upper half of the bow around 20s-35s and 50s-58s, where the bow sits too close to the bridge.',
  evidenceSummary: 'Recent score 58; severity needs_attention.',
});
const dynIssue = issue({
  id: 'metric:dynamicControl', title: 'Dynamic shaping', metricKey: 'dynamicControl',
  reason: 'Phrases are not shaped — one sits flat throughout, one peaks immediately, one keeps growing to its final note.',
  evidenceSummary: 'Recent score 54; three phrases flagged.',
});

const FIXTURES: Fixture[] = [
  {
    // The case this whole layer exists for: a student asking how to play more
    // musically. Every phrase here is measurably shaped wrong in a different
    // way, so a response that says "focus on dynamics" is failing with the
    // answer sitting right in front of it.
    name: 'musicality: phrases shaped wrong in three different ways',
    issues: [dynIssue],
    input: {
      instrument: 'violin',
      piece: { title: 'Minuet in G', composer: 'J.S. Bach' },
      skillLevel: 'beginner',
      playerCategory: 'foundation',
      metrics: [{
        key: 'dynamicControl', score: 54, severity: 'needs_attention',
        observationSummary: dynIssue.reason,
        moments: [{ t: 44.2, note: 'phrase sounds flat in volume' }],
      }],
      patternFindings: [],
      issues: [{ id: dynIssue.id, summary: `${dynIssue.title}: ${dynIssue.reason}`, quality: 'high' }],
      musicalEvidence: {
        key: 'G major',
        key_confidence: 0.86,
        phrases_total: 9,
        phrases: [
          {
            id: 2, start_t: 12.4, end_t: 18.1, note_count: 12, slur_count: 3,
            energy_shape: 'flat', peak_location: 0.5, shape: 'plateau',
            peak_t: 15.2, melodic_contour: false,
            intonation_stability: 'high', vibrato_consistency: 0,
            selected_for: 'no dynamic shape',
          },
          {
            id: 5, start_t: 44.2, end_t: 50.6, note_count: 14, slur_count: 4,
            energy_shape: 'early_peak', peak_location: 0.08, shape: 'unclassified',
            peak_t: 44.7, melodic_contour: false,
            intonation_stability: 'moderate', vibrato_consistency: 0,
            selected_for: 'peaks almost immediately',
          },
          {
            id: 7, start_t: 63.0, end_t: 70.2, note_count: 16, slur_count: 5,
            energy_shape: 'late_peak', peak_location: 0.94, shape: 'unclassified',
            peak_t: 69.8, melodic_contour: false,
            intonation_stability: 'high', vibrato_consistency: 0,
            selected_for: 'still growing at the phrase end',
          },
        ],
        tempo: {
          bpm_estimate: 108, intended_bpm: 120, tendency: 'dragging',
          drift_score: 61, rubato: false,
          regions: [{ start_t: 45.0, end_t: 49.5, direction: 'dragged', deviation_pct: 11 }],
        },
        moments: [
          { t: 47.9, note: 'D5', duration_s: 1.8, level: 0.22, phrase_position: 0.58, cents_off: -8, reason: 'long note played quietly — a chance to sustain and grow' },
        ],
        figures: [],
      },
    },
    expectAnyKeyword: ['0:44', '44', 'phrase', 'peak', 'grow'],
    expectPhraseFeedback: 2,
  },
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
    response = await client.chat.completions.create({
      model: COACHING_MODEL,
      max_tokens: 1500,
      response_format: RESPONSE_FORMAT,
      // Reasoning off — it shares the completion budget and truncates the JSON.
      ...COACHING_EXTRA_PARAMS,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserContent(fixture.input) },
      ],
    } as any);
  } catch (err) {
    check('API call succeeded', false, err instanceof Error ? err.message : String(err));
    return;
  }

  const text = (response as any).choices?.[0]?.message?.content;
  if (!text) {
    check('response has content', false);
    return;
  }
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    check('response is valid JSON', false, String(text).slice(0, 200));
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

  // ── Musicality: the checks that fail generic advice ────────────────────
  const allText = [
    data.summary,
    ...(data.insights ?? []).flatMap((i: any) => [i.observation, i.feedback, i.exercise]),
    ...(data.root_causes ?? []).flatMap((c: any) => [c.label, c.explanation]),
    ...(data.phrase_feedback ?? []).flatMap((p: any) => [p.observation, p.tip]),
    ...(data.blocks ?? []).flatMap((b: any) => [b.title, b.why_this_drill]),
  ].filter(Boolean).join(' ');

  // The whole point of the musical evidence payload. A response with no
  // timestamp is, definitionally, not pointing at anything the student can hear.
  const timestamps = allText.match(/\b\d{1,2}:\d{2}\b|\b\d+(?:\.\d+)?\s?s(?:ec|econds)?\b/g) ?? [];
  check(
    'response cites at least one moment in time',
    timestamps.length > 0,
    allText.slice(0, 200),
  );

  const banned = BANNED_GENERIC_PHRASES.filter((phrase) =>
    allText.toLowerCase().includes(phrase.toLowerCase()),
  );
  check(
    'response avoids generic filler',
    banned.length === 0,
    banned.join(' | '),
  );

  if (fixture.expectPhraseFeedback != null) {
    const pf = data.phrase_feedback ?? [];
    check(
      `gives phrase feedback on at least ${fixture.expectPhraseFeedback} phrases`,
      pf.length >= fixture.expectPhraseFeedback,
      `got ${pf.length}`,
    );

    // Every entry must point at a phrase that exists, or the results UI seeks
    // the video to a moment that has nothing to do with the advice.
    const known = new Map(
      (fixture.input.musicalEvidence?.phrases ?? []).map((p: any) => [p.id, p]),
    );
    const bad = pf.filter((f: any) => {
      const phrase = known.get(f.phraseId);
      if (!phrase) return true;
      return typeof f.start_t !== 'number'
        || f.start_t < phrase.start_t - 1
        || f.start_t > phrase.end_t + 1;
    });
    check(
      'every phrase note points at a real phrase, at its real time',
      bad.length === 0,
      JSON.stringify(bad).slice(0, 200),
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
