/**
 * Chat-with-your-coach — L10 Claude chat, gated behind Pro same as
 * fetchCoachingFeedback(). Unlike the post-session coaching, this reads the
 * full session history so the model can speak to trends across sessions,
 * not just the most recent one.
 */

import { SessionSummary } from '../types/analysis';
import { supabase } from './supabase';
import { EntitlementRequiredError } from './llmFeedback';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

const EDGE_TIMEOUT_MS = 15_000;

function summarizeForPrompt(sessionHistory: SessionSummary[]) {
  // Most-recent-first, capped so a long history can't blow up the prompt.
  return sessionHistory.slice(0, 20).map((s) => ({
    recordedAt: s.recordedAt,
    overallScore: s.overallScore,
    topIssue: s.topIssue,
    piece: s.piece?.title,
    durationSeconds: s.durationSeconds,
  }));
}

/**
 * Sends the running conversation plus session history to the session-chat
 * Edge Function and returns the assistant's reply.
 *
 * Throws EntitlementRequiredError for free users (402) — callers should show
 * an upsell rather than a generic error. Throws a plain Error on any other
 * failure (network, timeout, malformed response).
 */
export async function fetchChatReply(
  messages: ChatMessage[],
  sessionHistory: SessionSummary[],
): Promise<string> {
  const invoke = supabase.functions.invoke('session-chat', {
    body: { messages, sessionHistory: summarizeForPrompt(sessionHistory) },
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
