// L10 — LLM coaching Edge Function.
//
// Input: CoachingInput (metrics + pattern findings + phrase features from the
// on-device L1–L9 pipeline). Output: structured coaching JSON. The response
// schema is enforced with structured outputs, so the client never has to
// repair free-form JSON.
//
// Deploy:  supabase functions deploy analyze-feedback
// Secret:  supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
//
// JWT verification is on by default — only authenticated app users can call
// this, and the free-tier quota is enforced by increment_free_analyses.

import Anthropic from 'npm:@anthropic-ai/sdk';

interface CoachingMetric {
  key: string;
  score: number;
  severity: string;
  observationSummary: string;
}

interface CoachingFinding {
  testId: string;
  summary: string;
  evidence: unknown;
  severity: string;
}

interface CoachingInput {
  instrument: string;
  piece?: { title: string; composer?: string };
  skillLevel: 'beginner' | 'intermediate' | 'advanced';
  playerCategory: 'foundation' | 'refinement';
  metrics: CoachingMetric[];
  patternFindings: CoachingFinding[];
  phraseFeatures?: unknown[];
}

const OUTPUT_SCHEMA = {
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
    practice_plan: {
      type: 'array',
      description: 'An ordered 2-4 step practice plan for the next session.',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          duration: { type: 'string', description: 'e.g. "5 min"' },
          instructions: { type: 'string' },
        },
        required: ['title', 'duration', 'instructions'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'insights', 'phrase_feedback', 'practice_plan'],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT = `You are an expert violin teacher reviewing a student's practice session that was analyzed by software.

You receive metric scores, statistical pattern findings, and per-phrase features. Your job:
- Prioritize the 1-3 MOST impactful issues. Do not comment on every flagged metric.
- Explain the WHY behind each issue — link the technique to its musical consequence (e.g. "your bow drifts toward the fingerboard when you reach the tip, which is why the tone thins out at the end of long notes").
- Reference the piece and the student's skill level where helpful. For a 'foundation' player, focus on core habits; for 'refinement', focus on polish and expression.
- Give specific, actionable exercises with durations — never generic advice like "practice slowly".
- Never recompute statistics or quote raw numbers back at the student; translate them into musical language.
- Phrase feedback: only comment on phrases with clear evidence in the provided features; leave the list empty otherwise.`;

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405 });
  }

  let input: CoachingInput;
  try {
    input = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid JSON body' }), { status: 400 });
  }
  if (!Array.isArray(input.metrics) || input.metrics.length === 0) {
    return new Response(JSON.stringify({ error: 'metrics required' }), { status: 400 });
  }

  const client = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY') });

  const userContent = JSON.stringify({
    instrument: input.instrument,
    piece: input.piece ?? null,
    skillLevel: input.skillLevel,
    playerCategory: input.playerCategory,
    metrics: input.metrics,
    patternFindings: input.patternFindings ?? [],
    // Cap phrase features so a long session can't blow up the prompt
    phraseFeatures: (input.phraseFeatures ?? []).slice(0, 10),
  });

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      output_config: { format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
      messages: [{ role: 'user', content: userContent }],
    });

    if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') {
      return new Response(JSON.stringify({ error: `generation stopped: ${response.stop_reason}` }), { status: 502 });
    }

    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      return new Response(JSON.stringify({ error: 'empty model response' }), { status: 502 });
    }

    // Structured outputs guarantee schema-valid JSON in the text block
    return new Response(textBlock.text, {
      headers: { 'content-type': 'application/json' },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    return new Response(JSON.stringify({ error: message }), { status: 502 });
  }
});
