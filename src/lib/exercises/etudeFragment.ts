import type { PracticeBlock } from '../practiceBlocks';
import { buildSequenceBlock, stepsFromMidi, tempoFor, type ExerciseContext } from './types';
import { OPEN_MIDI, stringForMidi, type ViolinString } from './fingerboard';
import { resolveKey, snapToKey, type ParsedKey } from './theory';

// ─────────────────────────────────────────────────────────────
// Family 12 — Étude fragments as targeted medicine
//
// The value of an étude over a drill is that it is still music: it has a line,
// so the technical work has somewhere to go. The value of a *fragment* over a
// whole étude is that four bars of the exact problem beats three pages of
// mostly-fine playing.
//
// IMPORTANT — what these are and aren't.
// These are characteristic patterns in the manner of the studies named, built
// in the player's own key and register. They are NOT verbatim transcriptions of
// Kreutzer, Kayser, Wohlfahrt or Dont, and the copy never claims they are. The
// pedagogical shape of each study is what does the work — Kreutzer 2's unbroken
// running eighths, Wohlfahrt's stepwise first-position patterns, Kayser's
// rocking string crossings — and that shape transposes. Pretending to quote a
// text we haven't set would be a claim the app can't back, and a player who
// looked it up would find us wrong.
// ─────────────────────────────────────────────────────────────

export type EtudeProblem = 'detache_evenness' | 'string_crossing' | 'first_position_frame' | 'shifting';

interface EtudeSpec {
  problem: EtudeProblem;
  /** The study whose pedagogical shape this follows. */
  tradition: string;
  title: string;
  /** What the pattern is for, in the tradition's own terms. */
  purpose: string;
  /** Scale-degree offsets, relative to the starting note. */
  contour: number[];
}

const SPECS: Record<EtudeProblem, EtudeSpec> = {
  detache_evenness: {
    problem: 'detache_evenness',
    tradition: 'Kreutzer No. 2',
    title: 'Running eighths',
    purpose: 'an unbroken line of equal notes, where any unevenness in the bow has nowhere to hide',
    // Steady stepwise motion with a turn — the shape that exposes an uneven bow.
    contour: [0, 2, 4, 5, 7, 5, 4, 2, 0, 2, 4, 5, 7, 9, 11, 12],
  },
  string_crossing: {
    problem: 'string_crossing',
    tradition: 'Kayser Op. 20',
    title: 'Rocking crossings',
    purpose: 'a line that keeps returning across the strings, so the arm has to change level in rhythm',
    contour: [0, 7, 2, 9, 4, 11, 5, 12, 4, 11, 2, 9, 0, 7, 0],
  },
  first_position_frame: {
    problem: 'first_position_frame',
    tradition: 'Wohlfahrt Op. 45',
    title: 'Hand-frame line',
    purpose: 'stepwise motion inside one position, which is where a drifting hand frame shows up first',
    contour: [0, 2, 4, 2, 5, 4, 2, 0, 4, 5, 7, 5, 4, 2, 0],
  },
  shifting: {
    problem: 'shifting',
    tradition: 'Dont Op. 37',
    title: 'Position-change line',
    purpose: 'a melodic line that has to travel up the string and come back in tune',
    contour: [0, 4, 7, 12, 7, 12, 16, 12, 7, 4, 0],
  },
};

/** Which study shape treats what the session actually showed. */
export function etudeProblemFor(ctx: ExerciseContext): EtudeProblem {
  const kind = ctx.evidence.kind;
  if (kind === 'figure_crossing') return 'string_crossing';
  if (kind === 'figure_shift') return 'shifting';
  if (kind === 'figure_speed' || ctx.evidence.metricKey === 'bowSmoothness') return 'detache_evenness';
  return 'first_position_frame';
}

function startMidi(ctx: ExerciseContext, key: ParsedKey): number {
  const anchor = ctx.evidence.target.midiSequence?.[0] ?? ctx.evidence.target.midiNote;
  // Keep the fragment inside a register the drill can actually be played in.
  const raw = anchor ?? OPEN_MIDI.D;
  return snapToKey(Math.max(OPEN_MIDI.G, Math.min(raw, 71)), key);
}

export function generateEtudeFragment(ctx: ExerciseContext): PracticeBlock | null {
  const problem = etudeProblemFor(ctx);
  const spec = SPECS[problem];
  const key = resolveKey(ctx.evidence.target.keyName);
  const root = startMidi(ctx, key);

  const midis = spec.contour.map((offset) => snapToKey(root + offset, key));
  if (midis.length < 6) return null;

  const preferString = (ctx.evidence.target.string ?? ctx.evidence.target.strings?.[0]) as ViolinString | undefined;
  const steps = stepsFromMidi(midis, { preferString, allowShifting: ctx.canShift });

  return buildSequenceBlock({
    ctx,
    slug: 'etude_fragment',
    type: 'etude_fragment',
    title: spec.title,
    subtitle: `${key.name} · after ${spec.tradition}`,
    reason: ctx.evidence.reason,
    bridge: `This follows the shape of ${spec.tradition} — ${spec.purpose} — written out in ${key.name}, the key you were actually playing in. It's still a line rather than a drill, so the technical work has somewhere musical to go.`,
    steps,
    bpm: tempoFor(ctx.intensity),
    estimatedMinutes: 7,
    instructions: [
      `${steps.length} notes in ${key.name}, one per click.`,
      'Even tone and even length — let it phrase.',
    ],
    successSummary: `Play the fragment through in ${key.name}, keeping all but a note or two in tune.`,
    fallbackCriteria: 'If note detection is uncertain, play the fragment at half tempo and record just the first half.',
    coachPromptContext: `Coach a ${spec.tradition}-style fragment in ${key.name} addressing ${problem.replace(/_/g, ' ')}. Evidence: ${ctx.evidence.evidenceSummary}`,
    target: {
      metricKey: ctx.evidence.metricKey,
      scaleName: key.name,
      midiNote: midis[0],
      string: preferString ?? stringForMidi(midis[0]),
      startSeconds: ctx.evidence.target.startSeconds,
      endSeconds: ctx.evidence.target.endSeconds,
    },
  });
}
