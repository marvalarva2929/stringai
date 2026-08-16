/**
 * The student's record, as both coach surfaces see it.
 *
 * Before this existed the two features had different views of the same student:
 * `analyze-feedback` received full metrics, pattern findings and issue ids,
 * while `session-chat` received five fields per session (date, score, top
 * issue, piece, duration) and nothing at all about what the coach had
 * recommended. Chat could not answer "why am I doing this drill?" because it had
 * never been told there was a drill.
 *
 * This module is the single description of what we know. Both Edge Functions
 * build their prompt from it, so the two can run on different models — coaching
 * on DeepSeek, chat on Claude Haiku — without diverging on the facts. Sharing
 * the *context* is what makes sharing the *model* unnecessary.
 *
 * Deliberately pure and dependency-free: no Deno APIs, no SDK imports. It is
 * imported by two isolated Deno modules and by the Node eval harness.
 */

/** One drill from the coach's plan, as the student sees it. */
export interface CoachBlockSummary {
  title: string;
  minutes: number;
  whyThisDrill: string;
}

/** One underlying cause the coach identified behind several measured issues. */
export interface CoachRootCauseSummary {
  label: string;
  explanation: string;
}

/**
 * What the coach said about a session. Absent when coaching never ran — free
 * users, a failed generation, or a session recorded before coaching existed.
 */
export interface CoachingSummary {
  summary: string;
  rootCauses: CoachRootCauseSummary[];
  blocks: CoachBlockSummary[];
}

/** A single practice session, with the coach's take attached when there is one. */
export interface SessionContext {
  sessionId: string;
  recordedAt: string;
  overallScore: number;
  overallDelta?: number;
  piece?: string;
  durationSeconds: number;
  /** Per-category scores, e.g. { intonation: 72, tone: 54 }. */
  categoryScores?: Record<string, number>;
  topIssue?: string;
  coaching?: CoachingSummary;
  /**
   * The timestamped musical picture — selected phrases with their shapes and
   * peak times, tempo movement, notable notes. This is what lets chat say
   * "the phrase at 0:44 peaked immediately" instead of "work on dynamics".
   */
  musicalEvidence?: unknown;
}

/** Everything either surface is allowed to reason from. */
export interface CoachContext {
  instrument: string;
  skillLevel?: string;
  playerCategory?: string;
  /** Most recent first. */
  sessions: SessionContext[];
}

/** Sessions older than this add little and cost tokens. */
export const MAX_CONTEXT_SESSIONS = 20;

/**
 * Only the most recent session carries its full coaching detail. Older sessions
 * keep their scores for trend questions but drop their drill plans — a student
 * asking "what should I do today" cares about the current plan, and twenty past
 * plans would crowd out the conversation itself.
 */
export const SESSIONS_WITH_FULL_COACHING = 3;

/**
 * Renders the context as the compact block both prompts embed.
 *
 * JSON rather than prose: it is what the coaching prompt already sends, both
 * models parse it reliably, and it keeps the token cost proportional to the
 * data rather than to the phrasing.
 */
export function renderCoachContext(ctx: CoachContext, focusSessionId?: string): string {
  const sessions = ctx.sessions.slice(0, MAX_CONTEXT_SESSIONS).map((s, i) => {
    // The session whose results the student is looking at right now. It always
    // carries its full detail, however old it is — otherwise chat opened from
    // an older session's results would be answering about a different take.
    const inFocus = focusSessionId !== undefined && s.sessionId === focusSessionId;
    const detailed = inFocus || i < SESSIONS_WITH_FULL_COACHING;
    return {
      in_focus: inFocus || undefined,
      recordedAt: s.recordedAt,
      overallScore: s.overallScore,
      overallDelta: s.overallDelta,
      piece: s.piece,
      durationSeconds: s.durationSeconds,
      categoryScores: s.categoryScores,
      topIssue: s.topIssue,
      // Largest field by far, so only where it will actually be used.
      musicalEvidence: detailed ? s.musicalEvidence : undefined,
      coaching: detailed ? s.coaching : undefined,
    };
  });

  return JSON.stringify({
    instrument: ctx.instrument,
    skillLevel: ctx.skillLevel,
    playerCategory: ctx.playerCategory,
    sessions,
  });
}

/**
 * The paragraph explaining the context block, shared so both prompts describe it
 * the same way. A model told the drill plan but not that it may discuss it tends
 * to treat it as background and never mention it.
 */
export const CONTEXT_PROMPT_SECTION = `You are given the student's recent practice sessions as JSON. Each has scores, the piece, and — for the most recent few — the coaching that was generated after it: a summary, the root causes identified, and the drill plan the student was given.

Treat that coaching as something you said. The student can see those drills in the app, so speak about them directly: which drill addresses what they are asking about, why it was chosen, what to do if it feels too hard. Never contradict a root cause without saying why you have changed your mind.

The most recent sessions also carry \`musicalEvidence\` — the timestamped picture of what they actually played:
- \`phrases\`: each with start_t/end_t, how it was shaped (\`shape\`, \`energy_shape\`), where its loudest moment fell (\`peak_location\` 0-1, \`peak_t\` in seconds), and \`selected_for\` saying why it is worth discussing. \`melodic_contour: true\` means level and pitch moved together — deliberate shaping, never a fault.
- \`tempo\`: measured \`bpm_estimate\` against \`intended_bpm\` (their metronome), and \`regions\` where they rushed or dragged, with times and percentages. \`rubato: true\` means elastic timing — expression to discuss, not an error.
- \`moments\`: individual notes worth naming, with time, note name, length and level.
- \`figures\`: runs, arpeggios and shifts that went badly.
- \`key\`: when confidently estimated.

THE SPECIFICITY CONTRACT. This is what makes you worth talking to:
- When you discuss musicality, cite the moment. "The phrase from 0:44 peaked at 0:45, right at the start — this line wants to grow toward its top note near 0:48" is the standard. Never "focus on dynamics", "work on phrasing", "practice slowly", "be more musical", or "pay attention to" anything. Those say nothing they cannot already see.
- Where you know the piece from its title and composer, use it: name the sequence, the cadence, where the arc belongs. Never invent bar numbers — you only have timestamps.
- Prefer "softer here, growing to here" over "vary your dynamics". Prefer "you dragged 12% through 0:20-0:25" over "watch your timing".

WHICH SESSION THEY MEAN. When one session is marked \`in_focus: true\`, the student has that session's results open in front of them — that is the take and the piece they are asking about. Answer about it directly. Do NOT ask which piece they mean; you already know, and asking wastes the one thing they came for. Only when no session is in focus, and the question genuinely depends on which take, should you ask.

WHEN A SESSION HAS NO \`musicalEvidence\`. Sessions recorded before this analysis existed carry only scores. This is common and you must still be genuinely useful — NEVER refuse to help, never make a recording a precondition, and never reply with only a request for more information.

In that case:
- Teach the piece. You know the repertoire: say where its phrases usually arch, which line is the emotional centre, where the harmony asks for weight and where it wants release, how the ending should settle. Be concrete and musical. Frame it as how the piece goes, not as what they did.
- Use the scores you do have. A weak dynamics score with a strong intonation score is a real, sayable observation about their playing.
- Give them something to do today: a specific shaping instruction they can apply on their next play-through.
- You may close by noting that their next recording will let you point at exact moments. One sentence, at the end, as a bonus — never as the reason you cannot answer now.

A reply that only asks the student to record again, or that says you lack the detail you need, is a failure. Answer the question with what you have.

Ground every claim in this data. Where the data is thin, lean on your knowledge of the piece rather than inventing measurements — but always answer.`;
