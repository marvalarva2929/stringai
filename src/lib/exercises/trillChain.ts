import type { PracticeBlock } from '../practiceBlocks';
import { evidenceRef, type ExerciseContext } from './types';
import { fingerLabel, positionForMidi, stringForMidi, fingerFor } from './fingerboard';
import { midiToNoteName } from '../pitchNaming';

// ─────────────────────────────────────────────────────────────
// Family 9 — Trill and ornament chain
//
// Measured trills before fast ones. A player who practises trills by trilling
// as fast as they can builds a fast, uneven trill and then can't slow it down;
// counting the alternations builds a trill that has a speed you can choose.
//
// Graded by the trill evaluator, which judges count and evenness rather than
// intonation — see trillEvaluator.ts for why measuring cents at trill speed
// would be measuring noise.
// ─────────────────────────────────────────────────────────────

/** Alternation counts by intensity — the measured ladder Ševčík and Dounis use. */
function alternationsFor(intensity: ExerciseContext['intensity']): number {
  if (intensity === 'guided') return 4;
  if (intensity === 'balanced') return 6;
  return 8;
}

export function generateTrillChain(ctx: ExerciseContext): PracticeBlock | null {
  const { target } = ctx.evidence;
  const pair = target.trillPair;
  if (!pair) return null;

  const [lowerMidi, upperMidi] = pair;
  const intervalSemitones = Math.max(1, Math.min(2, upperMidi - lowerMidi));
  const str = stringForMidi(lowerMidi, target.string as never);
  const position = positionForMidi(lowerMidi, str);
  const lowerFinger = fingerFor(lowerMidi, str, position);
  const upperFinger = fingerFor(upperMidi, str, position);

  const alternations = alternationsFor(ctx.intensity);
  const lowerName = midiToNoteName(lowerMidi);
  const upperName = midiToNoteName(upperMidi);
  const intervalName = intervalSemitones === 1 ? 'half step' : 'whole step';

  const fingerPhrase = lowerFinger != null && upperFinger != null
    ? `${fingerLabel(lowerFinger)} holds ${lowerName}, ${fingerLabel(upperFinger)} trills to ${upperName}`
    : `hold ${lowerName} and trill to ${upperName}`;

  return {
    id: `trill_chain:${ctx.evidence.id}`,
    type: 'trill_chain',
    title: `${lowerName}–${upperName} measured trill`,
    subtitle: `${alternations} alternations · ${intervalName}`,
    reason: ctx.evidence.reason,
    bridge: `Same two notes that smeared in the piece, but counted instead of rushed. ${alternations} alternations, every gap the same length — once the trill has a speed you can name, you can choose a different one.`,
    estimatedMinutes: 5,
    coachIntensity: ctx.intensity,
    instructions: [
      `${fingerPhrase}.`,
      `Trill exactly ${alternations} times, evenly. Count, don't rush.`,
    ],
    target: {
      metricKey: 'pitchAccuracy',
      midiNote: lowerMidi,
      noteName: lowerName,
      string: str,
      finger: upperFinger ?? undefined,
      startSeconds: target.startSeconds,
      endSeconds: target.endSeconds,
    },
    liveMode: {
      label: 'Mic counts the alternations and measures their evenness',
      signals: ['pitch', 'rhythm'],
      requiresMic: true,
      requiresCamera: false,
      status: 'ready',
    },
    successCriteria: {
      summary: `Play ${alternations} even alternations between ${lowerName} and ${upperName}.`,
      repetitions: alternations,
    },
    evaluator: {
      evaluatorId: 'trill',
      requiredAlternations: alternations,
      intervalSemitones,
      // A human trill breathes; anything tighter than this is a machine, and
      // failing a musical trill for not being one would be wrong.
      maxGapCv: ctx.intensity === 'advanced' ? 0.22 : 0.3,
    },
    fallbackCriteria: `If the trill can't be detected, play ${lowerName} and ${upperName} as ${alternations} separate metronome-paced notes, then gradually close the gap between them.`,
    coachPromptContext: `Coach a measured ${lowerName}–${upperName} trill (${alternations} alternations). Focus on finger release and evenness, not speed. Evidence: ${ctx.evidence.evidenceSummary}`,
    evidenceRefs: [evidenceRef(ctx.evidence)],
  };
}
