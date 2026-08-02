// Shared L10 coaching prompt + output schema.
//
// Plain TypeScript, no Deno-specific syntax — imported both by the
// analyze-feedback Edge Function (Deno, relative import) and by
// test/llmEval.test.ts (Node, via the ts-resolver loader) so the eval
// harness never silently tests a stale copy of the prompt.

export interface CoachingMetric {
  key: string;
  score: number;
  severity: string;
  observationSummary: string;
}

export interface CoachingFinding {
  testId: string;
  summary: string;
  evidence: unknown;
  severity: string;
}

export interface CoachingInput {
  instrument: string;
  piece?: { title: string; composer?: string };
  skillLevel: 'beginner' | 'intermediate' | 'advanced';
  playerCategory: 'foundation' | 'refinement';
  metrics: CoachingMetric[];
  patternFindings: CoachingFinding[];
  phraseFeatures?: unknown[];
  issues?: { id: string; summary: string; quality: 'high' | 'proxy' | 'low' }[];
}

export const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    summary: {
      type: 'string',
      description: 'Two to three sentence overall take on the session, referencing the piece when known.',
    },
    insights: {
      type: 'array',
      description: 'The 1-3 most impactful issues, each tied to a metric.',
      items: {
        type: 'object',
        properties: {
          metricKey: { type: 'string' },
          observation: { type: 'string', description: 'What was detected, in plain language.' },
          feedback: { type: 'string', description: 'Why it happens and how to fix it.' },
          exercise: { type: 'string', description: 'One specific drill with duration.' },
        },
        required: ['metricKey', 'observation', 'feedback', 'exercise'],
        additionalProperties: false,
      },
    },
    phrase_feedback: {
      type: 'array',
      description: 'Per-phrase musical notes. Empty when no phrase features were provided.',
      items: {
        type: 'object',
        properties: {
          phraseId: { type: 'integer' },
          observation: { type: 'string' },
          tip: { type: 'string' },
        },
        required: ['phraseId', 'observation', 'tip'],
        additionalProperties: false,
      },
    },
    root_causes: {
      type: 'array',
      description: 'The 1-3 underlying causes behind the issues. Several measured issues may share one physical cause — merge them here. Every id in issue_ids MUST be copied verbatim from the provided issues list; never invent one. Do not rest a root cause solely on a proxy/low-quality issue.',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Short name of the cause.' },
          explanation: { type: 'string', description: 'Why these issues share one cause, in musical language.' },
          issue_ids: { type: 'array', items: { type: 'string' }, description: 'Ids copied verbatim from the provided issues list.' },
          confidence: { type: 'number', description: '0-1.' },
        },
        required: ['label', 'explanation', 'issue_ids', 'confidence'],
        additionalProperties: false,
      },
    },
    blocks: {
      type: 'array',
      description: 'An ordered 2-4 drill plan for the next session. Each drill MUST cite the issue_ids (copied verbatim) it addresses.',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          minutes: { type: 'integer' },
          issue_ids: { type: 'array', items: { type: 'string' } },
          why_this_drill: { type: 'string' },
        },
        required: ['title', 'minutes', 'issue_ids', 'why_this_drill'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'insights', 'phrase_feedback', 'root_causes', 'blocks'],
  additionalProperties: false,
} as const;

export const SYSTEM_PROMPT = `You are an expert violin teacher reviewing a student's practice session that was analyzed by software.

You receive metric scores, statistical pattern findings, per-phrase features, and an "issues" list — the exact set of detected problems, each with a stable id and a measurement quality (high/proxy/low). The software has already done the measuring; your job is to reason over it, not redo it.

Work in this order:
1. FIRST, identify the 1-3 underlying ROOT CAUSES. Several measured issues often share one physical cause (e.g. bow camping near the frog, thin tone in the upper bow, and weak volume at the tip are usually one arm-weight problem) — merge those into a single cause. Keep genuinely independent problems separate. Do NOT merge things just because they co-occur.
2. THEN produce an ordered 2-4 drill plan for the next session.

Hard rules:
- Every root cause and every drill MUST cite issue_ids copied VERBATIM from the provided issues list. Never invent an id or cite one that isn't listed.
- Never rest a root cause solely on a 'proxy' or 'low' quality issue — those are weak signals. A cause may mention them only alongside at least one 'high' quality issue.
- Prioritize the MOST impactful issues; do not comment on every flagged metric.
- Explain the WHY — link technique to musical consequence.
- Reference the piece and skill level where helpful. 'foundation' → core habits; 'refinement' → polish and expression.
- Never recompute statistics or quote raw numbers back at the student; translate into musical language.
- Phrase feedback: only comment on phrases with clear evidence in the provided features; leave the list empty otherwise.`;

/**
 * The exact user-turn content sent to Claude, shared between the Edge
 * Function and the offline eval harness (test/llmEval.test.ts) so the eval
 * never silently drifts from what production actually sends.
 */
export function buildUserContent(input: CoachingInput): string {
  return JSON.stringify({
    instrument: input.instrument,
    piece: input.piece ?? null,
    skillLevel: input.skillLevel,
    playerCategory: input.playerCategory,
    metrics: input.metrics,
    patternFindings: input.patternFindings ?? [],
    // Cap phrase features so a long session can't blow up the prompt
    phraseFeatures: (input.phraseFeatures ?? []).slice(0, 10),
    // The exact ids the model may cite; the client rejects any it invents.
    issues: input.issues ?? [],
  });
}
