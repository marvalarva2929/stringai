// L10 — LLM coaching Edge Function.
//
// Input: CoachingInput (metrics + pattern findings + phrase features from the
// on-device L1–L9 pipeline). Output: structured coaching JSON. The response
// schema is enforced with structured outputs, so the client never has to
// repair free-form JSON.
//
// Deploy:  supabase functions deploy analyze-feedback
// Secret:  supabase secrets set HF_TOKEN=hf_...
//
// JWT verification is on by default, so only authenticated app users reach this
// handler. AI coaching is a Pro feature, so before spending any tokens we check
// the caller's entitlement and return 402 to free users. Without this, any
// signed-in account could spend inference credits on our token.

import OpenAI from 'npm:openai';
import { resolveProCaller } from '../_shared/caller.ts';
import { loadRecentChat } from '../_shared/loadCoachContext.ts';
import {
  COACHING_BASE_URL,
  COACHING_MODEL,
  COACHING_EXTRA_PARAMS,
  RESPONSE_FORMAT,
  SYSTEM_PROMPT,
  buildUserContent,
  type CoachingInput,
} from '../_shared/coachingPrompt.ts';

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405 });
  }

  // Entitlement first: never build the prompt, never call Claude, for a free
  // user. The client treats 402 as "keep the local template feedback" and shows
  // no error, since free users hit this on every session by design.
  const caller = await resolveProCaller(req);
  if (!caller) {
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

  const client = new OpenAI({
    baseURL: COACHING_BASE_URL,
    apiKey: Deno.env.get('HF_TOKEN'),
  });
  // What the student has been asking about is evidence the measurements can't
  // capture — "my shoulder aches", "I can't hear the difference". Loaded here
  // rather than sent by the client so it cannot be forged.
  const recentChat = await loadRecentChat(caller.admin, caller.userId).catch(() => []);
  const userContent = buildUserContent({ ...input, recentChat });

  try {
    const response = await client.chat.completions.create({
      model: COACHING_MODEL,
      max_tokens: 1500,
      response_format: RESPONSE_FORMAT,
      // Reasoning off — it shares the completion budget and truncates the JSON.
      ...COACHING_EXTRA_PARAMS,
      messages: [
        // OpenAI-style: the system prompt is the first message rather than a
        // top-level field.
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
    });

    const choice = response.choices?.[0];
    // 'length' means the JSON was cut mid-structure — schema-invalid however
    // strict the mode, so fail rather than hand the client a broken object.
    if (choice?.finish_reason === 'length') {
      return new Response(JSON.stringify({ error: 'generation stopped: max_tokens' }), { status: 502 });
    }
    if (choice?.message?.refusal) {
      return new Response(JSON.stringify({ error: 'generation refused' }), { status: 502 });
    }

    const text = choice?.message?.content;
    if (!text) {
      return new Response(JSON.stringify({ error: 'empty model response' }), { status: 502 });
    }

    // Structured outputs guarantee schema-valid JSON in the message content
    return new Response(text, {
      headers: { 'content-type': 'application/json' },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    return new Response(JSON.stringify({ error: message }), { status: 502 });
  }
});
