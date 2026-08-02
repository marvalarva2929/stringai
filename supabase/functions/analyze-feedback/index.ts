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
import { OUTPUT_SCHEMA, SYSTEM_PROMPT, buildUserContent, type CoachingInput } from '../_shared/coachingPrompt.ts';

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
  const userContent = buildUserContent(input);

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
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
