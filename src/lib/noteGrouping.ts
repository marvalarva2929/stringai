import type { NoteEvent } from './noteFusion';
import type { TimeSeries } from '../types/signals';

// ─────────────────────────────────────────────────────────────
// L5 — Note grouping (slur / détaché detection)
//
// Consecutive notes played in one bow stroke (no direction change between
// them) form a slur group. A direction flip between two notes closes the
// group. Confidence reflects bow-signal coverage: sessions where the bow was
// rarely visible degrade to single-note 'other' groups rather than guessing.
// ─────────────────────────────────────────────────────────────

export interface NoteGroup {
  id: number;
  type: 'slur' | 'detache' | 'other';
  /** Indices into the NoteEvent[] passed to groupNotes. */
  noteIds: number[];
  start_t: number;
  end_t: number;
  /** 0-1: fraction of direction samples for this group that were non-null. */
  confidence: number;
}

// Groups with less bow coverage than this are typed 'other'.
const MIN_GROUP_CONFIDENCE = 0.3;

type Dir = -1 | 0 | 1;

/**
 * Sample the committed bow direction at a note's midpoint and at the gap
 * midpoints between consecutive notes, then group notes by same-sign runs.
 *
 * Rules (plan.md L5):
 * - consecutive notes whose surrounding samples keep one moving sign → slur
 * - a sign flip between notes → close the group, start a new one
 * - every note lands in exactly one group (no gaps, no overlaps)
 * - stationary (0) samples are neutral: they neither extend nor break a run
 */
export function groupNotes(
  noteEvents: NoteEvent[],
  bowDirection: TimeSeries<Dir | null>,
): NoteGroup[] {
  if (noteEvents.length === 0) return [];

  // Direction evidence per note: midpoint sample.
  // Direction evidence per boundary i→i+1: sample at the gap midpoint.
  const noteDir: Array<Dir | null> = noteEvents.map((n) =>
    bowDirection.sample((n.startSeconds + n.endSeconds) / 2),
  );
  const boundaryDir: Array<Dir | null> = [];
  for (let i = 0; i < noteEvents.length - 1; i++) {
    const gapMid = (noteEvents[i].endSeconds + noteEvents[i + 1].startSeconds) / 2;
    boundaryDir.push(bowDirection.sample(gapMid));
  }

  // A boundary breaks the run when the moving sign changes across it.
  // Compare the last known moving sign before the boundary with the first
  // moving sign after it; stationary/null samples are neutral.
  const movingSignAt = (idx: number): Dir | null => {
    const d = noteDir[idx];
    return d === 1 || d === -1 ? d : null;
  };

  const groups: NoteGroup[] = [];
  let currentIds: number[] = [0];
  let currentSamples: Array<Dir | null> = [noteDir[0]];
  let runSign: Dir | null = movingSignAt(0);

  const flush = () => {
    const first = noteEvents[currentIds[0]];
    const last = noteEvents[currentIds[currentIds.length - 1]];
    const nonNull = currentSamples.filter((s) => s !== null).length;
    const confidence = currentSamples.length > 0 ? nonNull / currentSamples.length : 0;
    const type: NoteGroup['type'] =
      confidence < MIN_GROUP_CONFIDENCE ? 'other'
      : currentIds.length > 1 ? 'slur'
      : 'detache';
    groups.push({
      id: groups.length,
      type,
      noteIds: [...currentIds],
      start_t: first.startSeconds,
      end_t: last.endSeconds,
      confidence,
    });
  };

  for (let i = 1; i < noteEvents.length; i++) {
    const bDir = boundaryDir[i - 1];
    const nextSign = movingSignAt(i);

    // Establish the run's sign from the first moving evidence we see
    if (runSign === null) runSign = bDir === 1 || bDir === -1 ? bDir : nextSign;

    const boundarySign: Dir | null = bDir === 1 || bDir === -1 ? bDir : null;
    const flip =
      (boundarySign !== null && runSign !== null && boundarySign !== runSign) ||
      (nextSign !== null && runSign !== null && nextSign !== runSign);

    if (flip) {
      flush();
      currentIds = [i];
      currentSamples = [noteDir[i]];
      runSign = nextSign;
    } else {
      currentIds.push(i);
      currentSamples.push(boundaryDir[i - 1], noteDir[i]);
      if (runSign === null) runSign = nextSign;
    }
  }
  flush();

  return groups;
}
