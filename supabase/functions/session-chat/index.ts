// L10 — chat-with-your-coach Edge Function.
//
// Input: the running conversation (messages) plus the shared CoachContext.
// Output: { reply: string }. Unlike analyze-feedback this is free-form
// conversational text, not structured output — a chat doesn't have a fixed
// schema per turn.
//
// Deploy:  supabase functions deploy session-chat
// Secret:  supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
//
// Runs on Claude Haiku while post-session coaching runs on DeepSeek. That split
// is about latency, not capability: this call blocks the composer while the
// student waits, so a few seconds matters; coaching fills in behind a spinner
// where ~20s is invisible and its longer output makes token price dominate.
// Both read the SAME context (see _shared/coachContext.ts) — different models,
// one view of the student.
//
// JWT verification is on by default, so only authenticated app users reach this
// handler. Gated behind Pro same as analyze-feedback — every turn is an
// inference call, so an unmetered free tier here is an open tab on our key.

import Anthropic from 'npm:@anthropic-ai/sdk';
import {
  CONTEXT_PROMPT_SECTION,
  renderCoachContext,
  type CoachContext,
} from '../_shared/coachContext.ts';
import { resolveProCaller } from '../_shared/caller.ts';
import { loadCoachContext, saveChatTurns } from '../_shared/loadCoachContext.ts';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface ChatInput {
  messages: ChatMessage[];
  /**
   * Optional. The context is loaded server-side; this is merged in only for
   * sessions that never reached the database (saveSession is fire-and-forget).
   */
  context?: CoachContext;
  /** Set when chat was opened from a specific session's results. */
  sessionId?: string;
}

const SYSTEM_PROMPT = `You are a friendly, expert violin teacher chatting with a student inside their practice app.

${CONTEXT_PROMPT_SECTION}

- Be conversational. Two or three sentences for a simple question; go longer — walk through the phrases one at a time — when they ask about musicality, interpretation, or what to do about a specific passage. A question about shaping deserves a real answer, not a summary.
- Reference specific sessions or trends from the history when relevant; don't invent data that isn't there.
- Give specific, actionable practice suggestions with durations when coaching technique — never vague advice like "practice slowly".
- If the history is empty or too sparse to say anything specific, say so honestly and ask a clarifying question instead of guessing.
- Formatting: the app renders **bold**, *italic*, \`code\`, and short bullet or numbered lists. Use them sparingly for emphasis and steps. Do NOT use headings, tables, links, images, blockquotes or code fences — they render as literal characters.`;

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405 });
  }

  const caller = await resolveProCaller(req);
  if (!caller) {
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

  // The student record — scores, trends, and the drill plans the coach
  // produced — goes in as a preamble on the first user turn so it is available
  // for the whole conversation without being repeated on every message.
  const context = await loadCoachContext(caller.admin, caller.userId, input.context);
  const contextBlock = `Student record (most recent session first, JSON): ${renderCoachContext(
    context,
    input.sessionId,
  )}`;

  const messages = input.messages
    .filter((m) => typeof m.content === 'string' && m.content.trim().length > 0)
    .slice(-20)
    .map((m) => ({ role: m.role, content: m.content }));

  // Grabbed before the context preamble is spliced onto the first turn below.
  const rawLastUserMessage = [...messages].reverse().find((m) => m.role === 'user')?.content;

  if (messages.length > 0 && messages[0].role === 'user') {
    messages[0] = { role: 'user', content: `${contextBlock}\n\n${messages[0].content}` };
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

    // Record the exchange. Written server-side so a client cannot forge
    // assistant turns, which the post-session coach later reads as evidence.
    // Fire-and-forget: losing a message costs a little context and is never
    // worth failing the student's reply over.
    const lastUserTurn = [...messages].reverse().find((m) => m.role === 'user');
    saveChatTurns(caller.admin, caller.userId, input.sessionId ?? null, [
      // The stored copy is the student's actual words, not the first turn with
      // the context block prepended to it.
      ...(lastUserTurn
        ? [{ role: 'user' as const, content: rawLastUserMessage ?? lastUserTurn.content }]
        : []),
      { role: 'assistant' as const, content: textBlock.text },
    ]).catch(() => {});

    return new Response(JSON.stringify({ reply: textBlock.text }), {
      headers: { 'content-type': 'application/json' },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    return new Response(JSON.stringify({ error: message }), { status: 502 });
  }
});
