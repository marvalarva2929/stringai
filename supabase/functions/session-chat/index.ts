// L10 — chat-with-your-coach Edge Function.
//
// Input: the running conversation (messages) plus a condensed session-history
// summary from the client. Output: { reply: string }. Unlike analyze-feedback
// this is free-form conversational text, not structured output — a chat
// doesn't have a fixed schema per turn.
//
// Deploy:  supabase functions deploy session-chat
// Secret:  supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
//
// JWT verification is on by default, so only authenticated app users reach this
// handler. Gated behind Pro same as analyze-feedback — every turn is a Claude
// call, so an unmetered free tier here is an open tab on our API key.

import Anthropic from 'npm:@anthropic-ai/sdk';
import { createClient } from 'npm:@supabase/supabase-js@2';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface SessionHistoryEntry {
  recordedAt: string;
  overallScore: number;
  topIssue?: string;
  piece?: string;
  durationSeconds: number;
}

interface ChatInput {
  messages: ChatMessage[];
  sessionHistory: SessionHistoryEntry[];
}

const SYSTEM_PROMPT = `You are a friendly, expert violin teacher chatting with a student inside their practice app.

You have access to a condensed list of the student's recent practice sessions (date, overall score, top issue, piece, duration). Use it to ground your answers in real trends — e.g. "your intonation score has climbed the last three sessions" — rather than generic advice.

- Be conversational and concise: 2-5 sentences per reply unless the student asks for a detailed breakdown.
- Reference specific sessions or trends from the history when relevant; don't invent data that isn't there.
- Give specific, actionable practice suggestions with durations when coaching technique — never vague advice like "practice slowly".
- If the history is empty or too sparse to say anything specific, say so honestly and ask a clarifying question instead of guessing.`;

/** Same pattern as analyze-feedback's callerIsPro — duplicated because each Edge Function is an isolated Deno module. */
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
  if (profile.entitlement_expires_at && new Date(profile.entitlement_expires_at) <= new Date()) {
    return false;
  }
  return true;
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405 });
  }

  if (!(await callerIsPro(req))) {
    return new Response(JSON.stringify({ error: 'entitlement_required' }), {
      status: 402,
      headers: { 'content-type': 'application/json' },
    });
  }

  let input: ChatInput;
  try {
    input = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid JSON body' }), { status: 400 });
  }
  if (!Array.isArray(input.messages) || input.messages.length === 0) {
    return new Response(JSON.stringify({ error: 'messages required' }), { status: 400 });
  }

  const client = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY') });

  // Session history goes in as a system-adjacent preamble on the first user
  // turn so it's available for the whole conversation without repeating it
  // on every message.
  const historyBlock = `Recent session history (most recent first, JSON): ${JSON.stringify(
    (input.sessionHistory ?? []).slice(0, 20),
  )}`;

  const messages = input.messages
    .filter((m) => typeof m.content === 'string' && m.content.trim().length > 0)
    .slice(-20)
    .map((m) => ({ role: m.role, content: m.content }));

  if (messages.length > 0 && messages[0].role === 'user') {
    messages[0] = { role: 'user', content: `${historyBlock}\n\n${messages[0].content}` };
  }

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      system: SYSTEM_PROMPT,
      messages,
    });

    if (response.stop_reason === 'refusal') {
      return new Response(JSON.stringify({ error: 'generation refused' }), { status: 502 });
    }

    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      return new Response(JSON.stringify({ error: 'empty model response' }), { status: 502 });
    }

    return new Response(JSON.stringify({ reply: textBlock.text }), {
      headers: { 'content-type': 'application/json' },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    return new Response(JSON.stringify({ error: message }), { status: 502 });
  }
});
