// Shared L10 coaching prompt + output schema.
//
// Plain TypeScript, no Deno-specific syntax — imported both by the
// analyze-feedback Edge Function (Deno, relative import) and by
// test/llmEval.test.ts (Node, via the ts-resolver loader) so the eval
// harness never silently tests a stale copy of the prompt.

export interface CoachingMetric {
  key: string;
  score: number;
  severity: string;
  observationSummary: string;
  /** Up to two flagged moments, so a claim can point somewhere. */
  moments?: { t: number; note?: string }[];
}

/**
 * The timestamped musical picture — see src/lib/musicalEvidence.ts, which
 * builds it. Typed loosely here because this module is shared with the Deno
 * Edge Function and must not import from src/.
 */
export interface MusicalEvidenceLike {
  key?: string;
  key_confidence?: number;
  phrases_total?: number;
  phrases?: unknown[];
  tempo?: unknown;
  moments?: unknown[];
  figures?: unknown[];
}

export interface CoachingFinding {
  testId: string;
  summary: string;
  evidence: unknown;
  severity: string;
}

export interface CoachingInput {
  instrument: string;
  piece?: { title: string; composer?: string; movement?: string };
  skillLevel: 'beginner' | 'intermediate' | 'advanced';
  playerCategory: 'foundation' | 'refinement';
  metrics: CoachingMetric[];
  patternFindings: CoachingFinding[];
  phraseFeatures?: unknown[];
  issues?: { id: string; summary: string; quality: 'high' | 'proxy' | 'low' }[];
  /**
   * Recent chat turns, oldest first. Loaded server-side from coach_messages.
   * What a student says between sessions is evidence the metrics cannot see —
   * pain, confusion, or a drill they have quietly stopped doing.
   */
  recentChat?: { role: 'user' | 'assistant'; content: string }[];
  /**
   * Where the music actually went: phrase shapes and their peaks, tempo
   * movement against the intended tempo, and individual notes worth naming.
   * Everything carries a timestamp so advice can point at a moment the student
   * can tap and hear.
   */
  musicalEvidence?: MusicalEvidenceLike;
}

export const OUTPUT_SCHEMA = {
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
      description:
        'Musical shaping notes, one per phrase, for at least two of the phrases in musicalEvidence.phrases. What the line wanted versus what happened. Empty ONLY when no phrases were provided.',
      items: {
        type: 'object',
        properties: {
          phraseId: { type: 'integer', description: 'The id from musicalEvidence.phrases.' },
          start_t: {
            type: 'number',
            description:
              "That phrase's start_t in seconds. Carried so the app can seek the video to this moment even if ids drift.",
          },
          observation: { type: 'string', description: 'What happened, naming the moment.' },
          tip: { type: 'string', description: 'What to do instead, specific to this phrase.' },
        },
        required: ['phraseId', 'start_t', 'observation', 'tip'],
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

/**
 * Post-session coaching runs on DeepSeek via Hugging Face's router, which speaks
 * the OpenAI chat-completions API. Kept here rather than in the Edge Function so
 * the offline eval (test/llmEval.test.ts) and production cannot drift onto
 * different models — the whole point of sharing this file.
 *
 * Chat deliberately runs on a *different* model (Claude Haiku, see
 * session-chat). The two share their context and their view of the student, not
 * their inference: coaching is a background fill-in where ~20s is invisible and
 * output is long, so token price dominates; chat blocks the composer on every
 * turn, so latency dominates. Nothing here is chat-specific for that reason.
 */
export const COACHING_BASE_URL = 'https://router.huggingface.co/v1';

/**
 * Provider is pinned rather than left to the router's automatic selection: HF's
 * own guidance for structured outputs is to fix the provider, because schema
 * support varies and a silent failover would turn guaranteed JSON into
 * best-effort JSON.
 *
 * It has to be fireworks-ai or deepinfra. Novita serves this model but rejects
 * `json_schema` outright ("Supported formats: json_object"), and featherless-ai
 * was returning "model is busy". Measured: fireworks ~19-22s, deepinfra
 * ~16-29s, both schema-valid with no invented issue ids.
 */
export const COACHING_MODEL = 'deepseek-ai/DeepSeek-V4-Flash:deepinfra';

/**
 * DeepSeek emits reasoning tokens, and they share the completion budget with the
 * answer. Left on, a long think truncates the JSON mid-structure — one run in
 * three came back at exactly max_tokens with unparseable output, which `strict`
 * cannot prevent because the generation simply stopped.
 *
 * Off, the same request produces ~760 tokens instead of 1400-1500, which is
 * roughly 2x headroom under the cap. It also trims a few seconds. The schema
 * already forces the structure, so the reasoning was buying little here.
 */
export const COACHING_EXTRA_PARAMS = { reasoning_effort: 'none' } as const;

/**
 * OpenAI-style structured outputs. `strict: true` requires every object to list
 * all of its properties in `required` and set `additionalProperties: false` —
 * OUTPUT_SCHEMA above already satisfies both at every level, so it needs no
 * strict-mode variant.
 */
export const RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'session_coaching',
    schema: OUTPUT_SCHEMA,
    strict: true,
  },
} as const;

/**
 * Phrases the model reaches for when it has nothing specific to say. Listed in
 * the prompt as forbidden, and asserted against in test/llmEval.test.ts — a
 * response containing one fails the eval rather than shipping.
 *
 * They are not bad advice in themselves; they are what advice collapses into
 * when the model has no timestamps to point at. The fix is upstream (see
 * lib/musicalEvidence.ts), but naming them here closes the escape hatch.
 */
export const BANNED_GENERIC_PHRASES = [
  'focus on dynamics',
  'work on phrasing',
  'work on your phrasing',
  'practice slowly',
  'practise slowly',
  'pay attention to',
  'be more musical',
  'add more expression',
  'focus on intonation',
  'use more vibrato',
  'listen carefully',
] as const;

export const SYSTEM_PROMPT = `You are an expert violin teacher reviewing a student's practice session that software has already analysed.

You receive metric scores, statistical findings, an "issues" list (each with a stable id and a measurement quality of high/proxy/low), and — most importantly — \`musicalEvidence\`: a timestamped picture of what the student actually played.

\`musicalEvidence\` contains:
- \`phrases\` — each with start_t/end_t, how it was shaped (\`shape\`, \`energy_shape\`), where its loudest moment fell (\`peak_location\` 0-1, \`peak_t\` in seconds), intonation stability, and \`selected_for\` explaining why it was worth showing you. \`melodic_contour: true\` means level and pitch moved together — that is deliberate shaping, never a fault.
- \`tempo\` — measured \`bpm_estimate\` against \`intended_bpm\` (the metronome they set), plus \`regions\` where they rushed or dragged, with timestamps and percentages. \`rubato: true\` means the timing was elastic; treat that as expression to discuss, not an error.
- \`moments\` — individual notes worth naming, with their time, note name, length and level.
- \`figures\` — runs, arpeggios and shifts that went badly, with their notes.
- \`key\` — when confidently estimated.

The software did the measuring. Your job is to interpret it musically.

Work in this order:
1. MUSICAL SHAPE FIRST. Using \`phrases\` and \`tempo\`, say what the music wanted and what actually happened. Name the moment. "The phrase from 0:44 peaked at 0:45, right at the start — this line wants to grow toward its top note near 0:48" is the standard. Where you know the piece from its title and composer, use that: name the sequence, the cadence, where the arc belongs. Never invent bar numbers — you only have timestamps.
2. THEN the underlying ROOT CAUSES, 1-3 of them. Several measured issues often share one physical cause (bow camping at the frog, thin tone in the upper bow, and a weak tip are usually one arm-weight problem) — merge those. Keep genuinely independent problems separate. Do not merge things just because they co-occur.
3. THEN an ordered 2-4 drill plan for the next session.

THE SPECIFICITY CONTRACT — this is what separates useful coaching from filler:
- Every musical claim MUST cite a timestamp (m:ss or seconds) or a phrase id from the evidence. If you cannot point at a moment, do not make the claim.
- NEVER write any of these: ${BANNED_GENERIC_PHRASES.map((p) => `"${p}"`).join(', ')}. They say nothing the student cannot already see on the score screen.
- Prefer "softer here, growing to here" over "vary your dynamics". Prefer "you dragged 12% through 0:20-0:25" over "watch your timing".
- Do not comment on every flagged metric. Two or three specific observations beat six vague ones.
- Quote no raw numbers back except times and tempo — translate everything else into musical language.

Hard rules:
- Every root cause and every drill MUST cite issue_ids copied VERBATIM from the provided issues list. Never invent an id or cite one that isn't listed.
- Never rest a root cause solely on a 'proxy' or 'low' quality issue. A cause may mention them only alongside at least one 'high' quality issue.
- Explain the WHY — link technique to musical consequence.
- Reference the piece and skill level where helpful. 'foundation' → core habits; 'refinement' → polish and expression.
- \`phrase_feedback\`: give one entry for at least two of the phrases in \`musicalEvidence.phrases\`, using that phrase's \`id\` and its \`start_t\`. Leave the list empty ONLY when no phrases were provided at all.
- \`recentChat\` is what the student recently said to you. Treat it as evidence the measurements cannot capture — discomfort, confusion, or a drill they have stopped doing. Where it explains a measured issue, say so and adapt the plan. Never contradict it, and never quote it back verbatim.`;

/**
 * The exact user-turn content sent to Claude, shared between the Edge
 * Function and the offline eval harness (test/llmEval.test.ts) so the eval
 * never silently drifts from what production actually sends.
 */
export function buildUserContent(input: CoachingInput): string {
  return JSON.stringify({
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
    // The musical picture. Sent in full rather than sliced: it is already a
    // ranked selection (see MAX_EVIDENCE_PHRASES), unlike the raw phrase
    // features below, which were previously truncated to the first ten
    // chronologically — the opening of the take and nothing else.
    musicalEvidence: input.musicalEvidence ?? null,
    // Capped in loadRecentChat; included last so it reads as the most recent
    // thing that happened.
    recentChat: input.recentChat ?? [],
  });
}
