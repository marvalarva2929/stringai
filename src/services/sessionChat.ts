/**
 * Chat-with-your-coach — L10 Claude Haiku chat, gated behind Pro same as
 * fetchCoachingFeedback().
 *
 * Sends the SAME CoachContext that post-session coaching reasons over, which is
 * what lets the two run on different models without disagreeing: chat can see
 * the root causes and drill plan the coach produced and talk about them
 * directly. It previously received five fields per session and knew nothing
 * about the coaching, so "why am I doing this drill?" was unanswerable.
 */

import { supabase } from './supabase';
import { EntitlementRequiredError } from './llmFeedback';
import type { CoachContext } from '../lib/coachContext';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

const EDGE_TIMEOUT_MS = 15_000;

/**
 * Sends the running conversation plus the shared student context to the
 * session-chat Edge Function and returns the assistant's reply.
 *
 * Throws EntitlementRequiredError for free users (402) — callers should show
 * an upsell rather than a generic error. Throws a plain Error on any other
 * failure (network, timeout, malformed response).
 */
export async function fetchChatReply(
  messages: ChatMessage[],
  context: CoachContext,
  /** The session the chat was opened from, when it was opened from one. */
  sessionId?: string,
): Promise<string> {
  // The Edge Function loads the authoritative context and renders it; this is
  // only a fallback for sessions that never reached the server.
  const invoke = supabase.functions.invoke('session-chat', {
    body: { messages, context, sessionId },
  });
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('chat request timed out')), EDGE_TIMEOUT_MS),
  );
  const { data, error } = await Promise.race([invoke, timeout]);
  if (error) {
    const status = (error as { context?: { status?: number } }).context?.status;
    if (status === 402) throw new EntitlementRequiredError();
    throw error;
  }

  if (typeof data?.reply !== 'string') {
    throw new Error('malformed chat response');
  }

  return data.reply;
}

/**
 * The stored conversation, oldest first.
 *
 * Chat used to live entirely in React state, so closing the modal erased it and
 * every reopen started cold. Turns are written server-side by the Edge Function
 * (a client cannot forge assistant turns, which the post-session coach reads as
 * evidence) and read back here under the caller's own RLS policy.
 *
 * Returns [] on any failure — an empty history is a cold start, which is
 * survivable; an error dialog on opening chat is not.
 */
export async function fetchChatHistory(limit = 30): Promise<ChatMessage[]> {
  try {
    const { data, error } = await supabase
      .from('coach_messages')
      .select('role, content, created_at')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error || !data) return [];
    return data
      .reverse()
      .map((m) => ({ role: m.role as ChatMessage['role'], content: m.content }));
  } catch {
    return [];
  }
}
