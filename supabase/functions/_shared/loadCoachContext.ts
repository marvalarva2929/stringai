/**
 * Builds the CoachContext from the database, server-side.
 *
 * Previously each function trusted whatever context the client sent, which meant
 * the two surfaces could disagree simply by sending different payloads — and a
 * client could omit or fabricate any of it. Reading it here makes one query the
 * definition of what we know, for coaching and chat alike.
 *
 * The client may still pass its own context: sessions are saved fire-and-forget
 * (see session_save_failed), so a run that failed to persist exists only on the
 * device. Client sessions the server has never heard of are merged in rather
 * than dropped; where both have a session, the server row wins.
 */

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import {
  MAX_CONTEXT_SESSIONS,
  type CoachContext,
  type CoachingSummary,
  type SessionContext,
} from './coachContext.ts';

/** Chat turns the post-session coach is shown. Enough for the current thread. */
export const MAX_RECENT_CHAT = 12;

export interface CoachChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** Category rollups are computed here so both surfaces bucket metrics alike. */
const CATEGORY_KEYS: Record<string, string[]> = {
  intonation: ['pitchAccuracy', 'intonationStability'],
  vibrato: ['vibrato'],
  tone: ['toneQuality'],
  dynamics: ['dynamicControl'],
  bow: ['bowSmoothness', 'bowPlacement', 'bowAngle', 'bowDistribution'],
  posture: ['posture', 'leftHandWrist', 'bowArmLevel'],
};

function rollUp(scores: { metric_key: string; score: number }[]): Record<string, number> | undefined {
  const out: Record<string, number> = {};
  for (const [category, keys] of Object.entries(CATEGORY_KEYS)) {
    const present = scores.filter((s) => keys.includes(s.metric_key));
    if (present.length === 0) continue;
    out[category] = Math.round(present.reduce((sum, s) => sum + s.score, 0) / present.length);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Reduces a stored llm_feedback + coach_plan row to what a conversation needs. */
function toCoachingSummary(
  feedback: Record<string, unknown> | null,
  plan: unknown,
): CoachingSummary | undefined {
  if (!feedback && !plan) return undefined;
  const rootCauses = Array.isArray(feedback?.rootCauses)
    ? (feedback!.rootCauses as { label: string; explanation: string }[]).map((c) => ({
        label: c.label,
        explanation: c.explanation,
      }))
    : [];
  const blocks = Array.isArray(plan)
    ? (plan as { title: string; minutes: number; whyThisDrill?: string }[]).map((b) => ({
        title: b.title,
        minutes: b.minutes,
        whyThisDrill: b.whyThisDrill ?? '',
      }))
    : [];
  const summary = typeof feedback?.overallTake === 'string' ? feedback.overallTake : '';
  if (!summary && rootCauses.length === 0 && blocks.length === 0) return undefined;
  return { summary, rootCauses, blocks };
}

export async function loadCoachContext(
  admin: SupabaseClient,
  userId: string,
  clientContext?: CoachContext,
): Promise<CoachContext> {
  const [{ data: profile }, { data: rows }] = await Promise.all([
    admin.from('profiles').select('instrument, skill_level, player_category').eq('id', userId).single(),
    admin
      .from('sessions')
      .select('id, recorded_at, overall_score, overall_delta, duration_seconds, piece_id, llm_feedback, coach_plan, musical_evidence')
      .eq('user_id', userId)
      .order('recorded_at', { ascending: false })
      .limit(MAX_CONTEXT_SESSIONS),
  ]);

  const sessionRows = rows ?? [];

  // One query for every session's metrics rather than one per session.
  const ids = sessionRows.map((r) => r.id);
  const { data: metricRows } = ids.length
    ? await admin.from('metric_scores').select('session_id, metric_key, score').in('session_id', ids)
    : { data: [] as { session_id: string; metric_key: string; score: number }[] };

  const bySession = new Map<string, { metric_key: string; score: number }[]>();
  for (const m of metricRows ?? []) {
    const list = bySession.get(m.session_id) ?? [];
    list.push({ metric_key: m.metric_key, score: m.score });
    bySession.set(m.session_id, list);
  }

  const sessions: SessionContext[] = sessionRows.map((r) => {
    const scores = bySession.get(r.id) ?? [];
    const categoryScores = rollUp(scores);
    const worst = scores.length
      ? scores.reduce((a, b) => (b.score < a.score ? b : a)).metric_key
      : undefined;
    return {
      sessionId: r.id,
      recordedAt: r.recorded_at,
      overallScore: r.overall_score,
      overallDelta: r.overall_delta ?? undefined,
      piece: r.piece_id ?? undefined,
      durationSeconds: r.duration_seconds,
      categoryScores,
      topIssue: worst,
      coaching: toCoachingSummary(r.llm_feedback ?? null, r.coach_plan),
      musicalEvidence: r.musical_evidence ?? undefined,
    };
  });

  // Merge in anything the client has that never reached the server.
  const known = new Set(sessions.map((s) => s.sessionId));
  for (const s of clientContext?.sessions ?? []) {
    if (!known.has(s.sessionId)) sessions.push(s);
  }
  sessions.sort((a, b) => new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime());

  return {
    instrument: profile?.instrument ?? clientContext?.instrument ?? 'violin',
    skillLevel: profile?.skill_level ?? clientContext?.skillLevel,
    playerCategory: profile?.player_category ?? clientContext?.playerCategory,
    sessions: sessions.slice(0, MAX_CONTEXT_SESSIONS),
  };
}

/** Most recent chat turns, oldest first so they read as a transcript. */
export async function loadRecentChat(
  admin: SupabaseClient,
  userId: string,
  limit = MAX_RECENT_CHAT,
): Promise<CoachChatTurn[]> {
  const { data } = await admin
    .from('coach_messages')
    .select('role, content, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);
  return (data ?? [])
    .reverse()
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
}

/**
 * Records a turn. Fire-and-forget at the call site: losing a message costs the
 * coach a little context, and is never worth failing the student's reply over.
 */
export async function saveChatTurns(
  admin: SupabaseClient,
  userId: string,
  sessionId: string | null,
  turns: CoachChatTurn[],
): Promise<void> {
  if (turns.length === 0) return;
  await admin.from('coach_messages').insert(
    turns.map((t) => ({ user_id: userId, session_id: sessionId, role: t.role, content: t.content })),
  );
}
