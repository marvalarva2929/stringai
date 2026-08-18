// ─────────────────────────────────────────────────────────────
// The repair ladder: what a missed note is drilled as.
//
// Pure, so the rung structure can be tested without a microphone.
// ─────────────────────────────────────────────────────────────

/** Landings needed to clear the note on its own. */
export const REQUIRED_ALONE = 3;
/**
 * Landings needed to clear it approached from the note before.
 *
 * Fewer than REQUIRED_ALONE because each one costs two notes and a reset, and
 * because arriving in tune even twice is the harder skill of the two.
 */
export const REQUIRED_INTERVAL = 2;

export interface Stage {
  /** The note being judged. */
  note: string;
  /** The note it is approached from, or null for the isolated rung. */
  from: string | null;
  required: number;
}

/**
 * The ladder, flattened.
 *
 * Rung 1 is the note alone: find the pitch at all. Rung 2 is the note arrived at
 * from the one before it, which is the rung that matters — intonation is
 * relative, and a player can find a pitch cleanly from silence and still miss it
 * every time in the passage, because in the passage they arrive from somewhere.
 * The isolated rung comes first anyway: it is no use practising the approach to
 * a note whose pitch you cannot find.
 */
export function buildStages(notes: string[], froms: string[]): Stage[] {
  const stages: Stage[] = [];
  notes.forEach((note, i) => {
    stages.push({ note, from: null, required: REQUIRED_ALONE });
    const from = froms[i];
    if (from && from !== note) stages.push({ note, from, required: REQUIRED_INTERVAL });
  });
  return stages;
}

