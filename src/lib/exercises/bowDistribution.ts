import type { PracticeBlock } from '../practiceBlocks';
import { evidenceRef, type ExerciseContext } from './types';
import { OPEN_MIDI, stringForMidi, type ViolinString } from './fingerboard';
import { midiToNoteName } from '../pitchNaming';

// ─────────────────────────────────────────────────────────────
// Family 6 — Bow distribution
//
// For the player camped in one third of the bow. The reason it matters is not
// tidiness: the parts of the bow you never visit are the parts you can't
// control, so a long phrase runs out of bow and a loud one has nowhere to go.
//
// The drill prescribes the zone they are *avoiding*, which is the opposite of
// what feels natural and the only way the habit changes.
//
// Judged by the camera when bow tracking is available, and by tone when it is
// not — a stroke that reaches the tip without arm weight goes thin, so tone is
// a real if indirect read on whether the whole bow is being used.
// ─────────────────────────────────────────────────────────────

type BowZone = 'lower' | 'middle' | 'upper';

const ZONE_LABEL: Record<BowZone, string> = {
  lower: 'the lower third, near the frog',
  middle: 'the middle',
  upper: 'the upper third, toward the tip',
};

const ZONE_ADVICE: Record<BowZone, string> = {
  lower: 'The frog carries the bow\'s own weight, so the job here is taking weight *off* — let the hand carry the stick rather than pressing it.',
  middle: 'The middle is the neutral zone. Even speed, even weight, nothing to compensate for.',
  upper: 'Near the tip the bow has almost no weight of its own, so the arm has to supply it — lean in from the index finger as you travel out.',
};

/** The zone the player camped in, parsed from the pattern finding's prose. */
function campedZone(ctx: ExerciseContext): BowZone | null {
  const text = `${ctx.evidence.reason} ${ctx.evidence.evidenceSummary}`.toLowerCase();
  if (text.includes('upper') || text.includes('tip')) return 'upper';
  if (text.includes('lower') || text.includes('frog')) return 'lower';
  if (text.includes('middle')) return 'middle';
  return null;
}

/** The zone to prescribe: whichever one they're avoiding. */
function targetZone(camped: BowZone): BowZone {
  if (camped === 'upper') return 'lower';
  if (camped === 'lower') return 'upper';
  return 'upper';
}

export function generateBowDistribution(ctx: ExerciseContext): PracticeBlock | null {
  const camped = campedZone(ctx);
  // Without knowing which zone they camped in, this drill has nothing to
  // prescribe — better to let another generator take the moment.
  if (!camped) return null;

  const zone = targetZone(camped);
  const anchor = ctx.evidence.target.midiNote ?? OPEN_MIDI.D;
  const str = (ctx.evidence.target.string as ViolinString | undefined) ?? stringForMidi(anchor);
  const openMidi = OPEN_MIDI[str] ?? OPEN_MIDI.D;
  const reps = ctx.intensity === 'advanced' ? 8 : 6;
  const cameraAvailable = ctx.evidence.requiresCamera && ctx.evidence.measurementAvailable;

  return {
    id: `bow_distribution:${ctx.evidence.id}`,
    type: 'bow_distribution',
    title: `Bow zone: ${zone === 'upper' ? 'toward the tip' : zone === 'lower' ? 'at the frog' : 'the middle'}`,
    subtitle: `${reps} slow strokes, open ${str}`,
    reason: ctx.evidence.reason,
    bridge: `You spent the session in ${ZONE_LABEL[camped]}, so this drill sends you to ${ZONE_LABEL[zone]} — the part of the bow you're avoiding is the part you can't control yet, and long phrases are where that shows up.`,
    estimatedMinutes: 5,
    coachIntensity: ctx.intensity,
    instructions: [
      `${reps} slow strokes on open ${str}, using only ${ZONE_LABEL[zone]}.`,
      ZONE_ADVICE[zone],
    ],
    target: {
      metricKey: 'bowDistribution',
      string: str,
      midiNote: openMidi,
      noteName: midiToNoteName(openMidi),
      startSeconds: ctx.evidence.target.startSeconds,
      endSeconds: ctx.evidence.target.endSeconds,
    },
    liveMode: cameraAvailable
      ? {
          label: 'Camera watches where the bow travels',
          signals: ['bow', 'camera'],
          requiresMic: false,
          requiresCamera: true,
          status: 'ready',
        }
      : {
          // Honest downgrade: without bow tracking this reads tone, which
          // catches a thin tip stroke but can't see the bow's position.
          label: 'Mic checks the tone stays full through the stroke',
          signals: ['tone'],
          requiresMic: true,
          requiresCamera: false,
          status: 'limited',
          unavailableReason: 'Bow tracking was unavailable, so this take is judged on tone rather than bow position.',
        },
    successCriteria: {
      summary: cameraAvailable
        ? `Keep ${reps} strokes inside ${ZONE_LABEL[zone]}.`
        : `Play ${reps} strokes in ${ZONE_LABEL[zone]} without the tone going thin or scratchy.`,
      repetitions: reps,
    },
    evaluator: cameraAvailable
      ? {
          evaluatorId: 'bowGeometry',
          target: zone === 'upper'
            ? { signal: 'bowContactPoint', minValue: 0.6, maxValue: 1, requiredGoodFraction: 0.65 }
            : zone === 'lower'
              ? { signal: 'bowContactPoint', minValue: 0, maxValue: 0.4, requiredGoodFraction: 0.65 }
              : { signal: 'bowContactPoint', minValue: 0.33, maxValue: 0.67, requiredGoodFraction: 0.65 },
        }
      : { evaluatorId: 'toneFault', requiredCleanFraction: 0.7 },
    fallbackCriteria: `Record yourself from the side playing open ${str} and watch where the bow actually travels — most players are a hand's width short of where they think they are.`,
    coachPromptContext: `Coach bow distribution: the player camped in ${ZONE_LABEL[camped]} and is being sent to ${ZONE_LABEL[zone]}. Evidence: ${ctx.evidence.evidenceSummary}`,
    evidenceRefs: [evidenceRef(ctx.evidence)],
  };
}
