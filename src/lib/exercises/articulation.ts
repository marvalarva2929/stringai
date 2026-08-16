import type { PracticeBlock } from '../practiceBlocks';
import { evidenceRef, type ExerciseContext } from './types';
import { STROKE_LABEL, type StrokeName } from '../attackEvaluator';
import { OPEN_MIDI, stringForMidi, type ViolinString } from './fingerboard';
import { midiToNoteName } from '../pitchNaming';

// ─────────────────────────────────────────────────────────────
// Family 7 — Articulation isolation
//
// The same handful of notes played with one stroke, deliberately, so the stroke
// itself is the thing being practised. Players default to an all-purpose
// separate bow and then wonder why fast passages sound heavy; the fix is having
// more than one stroke available, which means practising them apart.
//
// Graded by the attack evaluator from the amplitude envelope. That reaches
// détaché, martelé and spiccato honestly and stops there — collé and sautillé
// are not separable from these signals, so they are not offered.
// ─────────────────────────────────────────────────────────────

const STROKE_INSTRUCTION: Record<StrokeName, string> = {
  detache: 'Full, smooth strokes in the middle of the bow. The sound starts without a bite and keeps going right up to the change — no gap between notes.',
  martele: 'Pinch the string with the bow before each note, release into the stroke, then stop the bow on the string. The silence between notes is part of the stroke, not a mistake.',
  spiccato: 'Middle of the bow, arm relaxed, let the bow drop and bounce. Short notes with real air between them — you should be able to hear the bow leaving the string.',
};

const STROKE_WHY: Record<StrokeName, string> = {
  detache: 'the workhorse — this is what a passage sounds like when nothing else is asked for',
  martele: 'the stroke that gives a note a hard edge and a clear end',
  spiccato: 'the stroke that makes fast separate notes light instead of heavy',
};

/** Which stroke to drill, from what the session showed. */
function strokeFor(ctx: ExerciseContext): StrokeName {
  const notesPerSecond = ctx.evidence.target.notesPerSecond ?? 0;
  // A fast separate-note passage that came out heavy is a spiccato problem;
  // a slow one that came out mushy is a martelé problem. Détaché is the
  // baseline for everything else.
  if (notesPerSecond >= 5) return 'spiccato';
  if (ctx.evidence.target.faultType === 'scratch' || ctx.evidence.target.faultType === 'rasp') return 'detache';
  if (notesPerSecond >= 2.5) return 'martele';
  return 'detache';
}

export function generateArticulation(ctx: ExerciseContext): PracticeBlock | null {
  const { target } = ctx.evidence;
  const stroke = strokeFor(ctx);
  const label = STROKE_LABEL[stroke];

  // Open string, so nothing about the left hand can be blamed or credited for
  // the sound. The stroke is the only variable.
  const anchor = target.midiSequence?.[0] ?? target.midiNote ?? OPEN_MIDI.D;
  const str = (target.string as ViolinString | undefined) ?? stringForMidi(anchor);
  const openMidi = OPEN_MIDI[str] ?? OPEN_MIDI.D;
  const reps = ctx.intensity === 'advanced' ? 12 : 8;

  return {
    id: `articulation:${ctx.evidence.id}`,
    type: 'articulation',
    title: `${label} on open ${str}`,
    subtitle: `${reps} strokes, one character`,
    reason: ctx.evidence.reason,
    bridge: `Open ${str} only, so the left hand can't take the blame or the credit — the sound you get is the stroke and nothing else. ${label} is ${STROKE_WHY[stroke]}, and it's the one the flagged passage was asking for.`,
    estimatedMinutes: 5,
    coachIntensity: ctx.intensity,
    instructions: [
      `Today's stroke is ${label}. ${STROKE_INSTRUCTION[stroke]}`,
      `Try four on open ${str} before recording and listen to the *start* of each note — that's where the stroke lives.`,
      `On the take, play ${reps} strokes on open ${str}, all the same character. Consistency is what's being judged, not power.`,
    ],
    target: {
      // The evidence's own metric, not a hardcoded one. buildPracticeBlocks
      // caps drills at one per metric so corroborating findings converge on a
      // single exercise; declaring a different metric here would quietly let a
      // second bow drill through on the same evidence.
      metricKey: ctx.evidence.metricKey,
      string: str,
      midiNote: openMidi,
      noteName: midiToNoteName(openMidi),
      startSeconds: target.startSeconds,
      endSeconds: target.endSeconds,
    },
    liveMode: {
      label: 'Mic reads the attack and release of each stroke',
      signals: ['tone', 'rhythm'],
      requiresMic: true,
      requiresCamera: false,
      status: 'ready',
    },
    successCriteria: {
      summary: `Play ${reps} strokes on open ${str} that all read as ${label}.`,
      repetitions: reps,
    },
    evaluator: {
      evaluatorId: 'attack',
      stroke,
      requiredMatchFraction: ctx.intensity === 'advanced' ? 0.75 : 0.6,
      minNotes: 4,
    },
    fallbackCriteria: `If the strokes can't be read, record yourself playing ${reps} on open ${str} and listen back: every note should start the same way as the one before it.`,
    coachPromptContext: `Coach ${label} on open ${str}. Focus on the character of the note's start and end. Evidence: ${ctx.evidence.evidenceSummary}`,
    evidenceRefs: [evidenceRef(ctx.evidence)],
  };
}
