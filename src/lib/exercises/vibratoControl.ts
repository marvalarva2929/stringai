import type { PracticeBlock } from '../practiceBlocks';
import { evidenceRef, type ExerciseContext } from './types';
import { OPEN_MIDI, fingerFor, positionForMidi, stringForMidi, fingerLabel, type ViolinString } from './fingerboard';
import { midiToNoteName } from '../pitchNaming';

// ─────────────────────────────────────────────────────────────
// Family 11 — Vibrato control
//
// The old vibrato drill asked for "a comfortable sustained note, preferably 2nd
// or 3rd finger" — which is to say, it didn't know what the player had played
// and couldn't tell them what to work on. This one names the note, the finger,
// and the specific property that was off, because the vibrato analysis measures
// rate and depth separately and they fail for different reasons.
// ─────────────────────────────────────────────────────────────

type VibratoFault = 'too_fast' | 'too_slow' | 'too_narrow' | 'intermittent';

const FAULT_COPY: Record<VibratoFault, { title: string; why: string; how: string }> = {
  too_fast: {
    title: 'Slow the oscillation',
    why: 'the vibrato was running faster than the note could carry, which reads as nerves rather than warmth',
    how: 'Count four oscillations per beat at first, then three. A slower vibrato needs a wider swing to stay audible — let the hand travel further, not quicker.',
  },
  too_slow: {
    title: 'Lift the oscillation',
    why: 'the vibrato was slower than the line wanted, so it wobbled instead of shimmering',
    how: 'Count three oscillations per beat, then four. Keep the swing the same width as it speeds up — narrowing it is the usual shortcut and it makes the vibrato disappear.',
  },
  too_narrow: {
    title: 'Widen the swing',
    why: 'the motion was there but too shallow to hear as vibrato',
    how: 'Exaggerate: roll the finger tip further back than feels right, so the pitch dips clearly below the note and returns. Width first, then bring the speed back.',
  },
  intermittent: {
    title: 'Keep it running',
    why: 'the vibrato started and stopped inside the note rather than running underneath it',
    how: 'Start the note straight, add the vibrato on the second beat, and keep it going through the bow change. The oscillation is a separate motion from the bow — it should not pause when the bow turns.',
  },
};

/** Which property was actually off, from the vibrato evidence's own numbers. */
function faultFor(ctx: ExerciseContext): VibratoFault {
  const summary = ctx.evidence.evidenceSummary.toLowerCase();
  const rateMatch = /([\d.]+)\s*hz/.exec(summary);
  const depthMatch = /([\d.]+)\s*cents depth/.exec(summary);
  const rate = rateMatch ? Number(rateMatch[1]) : null;
  const depth = depthMatch ? Number(depthMatch[1]) : null;

  if (depth != null && depth < 20) return 'too_narrow';
  if (rate != null && rate > 7.5) return 'too_fast';
  if (rate != null && rate < 4) return 'too_slow';
  return 'intermittent';
}

export function generateVibratoControl(ctx: ExerciseContext): PracticeBlock | null {
  const { target } = ctx.evidence;
  const fault = faultFor(ctx);
  const copy = FAULT_COPY[fault];

  // A note the player actually held, when we have one — vibrato practised on a
  // note from the piece transfers; vibrato practised on a random note doesn't.
  const midi = target.midiNote ?? (target.noteName ? undefined : OPEN_MIDI.D + 4);
  const anchorMidi = midi ?? OPEN_MIDI.D + 4;
  const str = (target.string as ViolinString | undefined) ?? stringForMidi(anchorMidi);
  const position = positionForMidi(anchorMidi, str);
  const finger = fingerFor(anchorMidi, str, position);
  // Vibrato on an open string is impossible and on the 1st finger it's awkward
  // — move to a finger that can actually oscillate.
  const usableMidi = finger == null || finger < 2 ? anchorMidi + 3 : anchorMidi;
  const usableFinger = fingerFor(usableMidi, str, positionForMidi(usableMidi, str)) ?? 3;
  const noteName = midiToNoteName(usableMidi);

  const seconds = ctx.intensity === 'advanced' ? 8 : 6;

  return {
    id: `vibrato_control:${ctx.evidence.id}`,
    type: 'vibrato',
    title: copy.title,
    subtitle: `${noteName}, ${fingerLabel(usableFinger)}`,
    reason: ctx.evidence.reason,
    bridge: `On the take, ${copy.why}. This works it on ${noteName} — a note long enough to hear the oscillation as a shape rather than a shake.`,
    estimatedMinutes: 6,
    coachIntensity: ctx.intensity,
    instructions: [
      `Set ${fingerLabel(usableFinger)} on ${noteName} (${str} string) and check the pitch straight, with no vibrato at all. Vibrato around a note that's already flat just makes a flat note wobble.`,
      copy.how,
      `On the take, hold ${noteName} for two bows of about ${seconds}s each. The recording stops on its own — keep the oscillation going right through.`,
    ],
    target: {
      metricKey: 'vibrato',
      midiNote: usableMidi,
      noteName,
      string: str,
      finger: usableFinger,
      startSeconds: target.startSeconds,
      endSeconds: target.endSeconds,
    },
    liveMode: {
      label: 'Mic measures the oscillation rate and depth',
      signals: ['pitch', 'vibrato', 'tone'],
      requiresMic: true,
      requiresCamera: false,
      status: 'ready',
    },
    successCriteria: {
      summary: `Hold ${noteName} with a steady 4–7 Hz vibrato for two bows of ${seconds}s.`,
      repetitions: 2,
      durationSeconds: seconds,
    },
    evaluator: {
      evaluatorId: 'vibrato',
      minDurationSeconds: seconds,
      requiredSuccesses: 2,
      // Widening is the goal when the swing was the problem, so ask for it.
      minDepthCents: fault === 'too_narrow' ? 25 : undefined,
    },
    fallbackCriteria: 'If the oscillation cannot be measured, practise the motion silently — bow off the string — in rhythm with a metronome, then record one sustained note.',
    coachPromptContext: `Coach vibrato ${fault.replace(/_/g, ' ')} on ${noteName}. Evidence: ${ctx.evidence.evidenceSummary}`,
    evidenceRefs: [evidenceRef(ctx.evidence)],
  };
}
