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
// JWT verification is on by default, so only authenticated app users reach this
// handler. Claude coaching is a Pro feature, so before spending any tokens we
// check the caller's entitlement and return 402 to free users. Without this,
// any signed-in account could call Claude without limit on our API key.

import Anthropic from 'npm:@anthropic-ai/sdk';
import { createClient } from 'npm:@supabase/supabase-js@2';

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
  issues?: { id: string; summary: string; quality: 'high' | 'proxy' | 'low' }[];
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

const SYSTEM_PROMPT = `You are an expert violin teacher reviewing a student's practice session that was analyzed by software.

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
 * Resolves the caller's entitlement from their JWT. Uses the service-role key
 * so the lookup isn't subject to the profiles RLS policy, and reads the token
 * from the request rather than trusting anything in the body.
 *
 * Returns 'free' whenever the caller can't be established — failing closed
 * means a misconfigured env var costs us a 402, not an unmetered Claude bill.
 */
async function callerIsPro(req: Request): Promise<boolean> {
  const jwt = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  if (!jwt) return false;

  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) return false;

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
  if (userErr || !userData.user) return false;

  const { data: profile, error: profileErr } = await admin
    .from('profiles')
    .select('entitlement, entitlement_expires_at')
    .eq('id', userData.user.id)
    .single();
  if (profileErr || !profile) return false;

  if (profile.entitlement !== 'pro') return false;

  // An expired row is free until the RevenueCat webhook catches up.
  if (profile.entitlement_expires_at && new Date(profile.entitlement_expires_at) <= new Date()) {
    return false;
  }
  return true;
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405 });
  }

  // Entitlement first: never build the prompt, never call Claude, for a free
  // user. The client treats 402 as "keep the local template feedback" and shows
  // no error, since free users hit this on every session by design.
  if (!(await callerIsPro(req))) {
    return new Response(JSON.stringify({ error: 'entitlement_required' }), {
      status: 402,
      headers: { 'content-type': 'application/json' },
    });
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
    // The exact ids the model may cite; the client rejects any it invents.
    issues: input.issues ?? [],
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
