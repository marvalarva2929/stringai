import type { CoachIntensity, PracticeBlock, SequenceStep } from '../practiceBlocks';
import type { SkillLevel } from '../../types/user';
import { OPEN_MIDI, stepAnnotation, type ViolinString } from './fingerboard';
import { arpeggioCycle, resolveKey, scaleNotes, snapToKey, type ParsedKey } from './theory';
import { arpeggioNotes } from './theory';
import { midiToNoteName, noteNameToMidi } from '../pitchNaming';
import { centsFor, tempoFor } from './types';
import { passMarkFor } from '../sequenceScore';

// ─────────────────────────────────────────────────────────────
// Technique staples — the work that isn't a repair.
//
// Every other generator answers "what went wrong?". These answer "what does a
// violinist do every day?", and a plan without them is all medicine and no
// diet. Left to itself the ranker fills every slot with passage repair, because
// a measured fault always outranks a scale that nothing flagged — so the plan
// reserves a slot rather than letting them compete.
//
// They cite no evidence, deliberately. A warm-up is not a claim about the
// player's playing, and dressing one up as a finding would be dishonest.
// ─────────────────────────────────────────────────────────────

export type StapleKind = 'scale' | 'arpeggio' | 'long_tones' | 'finger_frame' | 'shift_prep';

/** The week's rotation. Order is a practice-session order, not arbitrary. */
const ROTATION: StapleKind[] = ['scale', 'long_tones', 'arpeggio', 'finger_frame', 'scale', 'shift_prep', 'long_tones'];

/**
 * Which staple today. Keyed on the date so it is stable for a whole day (the
 * daily plan is frozen per day anyway) and varies across the week — the same
 * scale every morning is how people stop doing their scales.
 */
export function stapleForDate(date = new Date()): StapleKind {
  const dayNumber = Math.floor(date.getTime() / 86_400_000);
  return ROTATION[((dayNumber % ROTATION.length) + ROTATION.length) % ROTATION.length];
}

function annotate(midis: number[], preferString?: ViolinString): SequenceStep[] {
  return midis.map((midi) => ({
    note: midiToNoteName(midi),
    annotation: stepAnnotation(midi, preferString ?? inferString(midi)),
  }));
}

function inferString(midi: number): ViolinString {
  if (midi >= OPEN_MIDI.E) return 'E';
  if (midi >= OPEN_MIDI.A) return 'A';
  if (midi >= OPEN_MIDI.D) return 'D';
  return 'G';
}

/** Lowest tonic at or above the G string, so a scale sits in a playable register. */
function tonicMidi(key: ParsedKey): number {
  let midi = OPEN_MIDI.G + ((key.tonic - (OPEN_MIDI.G % 12) + 12) % 12);
  if (midi < OPEN_MIDI.G) midi += 12;
  return midi;
}

interface StapleArgs {
  intensity: CoachIntensity;
  skillLevel?: SkillLevel;
  /** Key of the music the player has been working on, when known. */
  keyName?: string | null;
  /** Whether the player has been taught to shift. */
  canShift?: boolean;
  kind?: StapleKind;
  date?: Date;
}

function sequenceStaple(args: {
  intensity: CoachIntensity;
  id: string;
  type: PracticeBlock['type'];
  title: string;
  subtitle: string;
  reason: string;
  bridge: string;
  steps: SequenceStep[];
  instructions: string[];
  successSummary: string;
  fallbackCriteria: string;
  coachPromptContext: string;
  scaleName?: string;
  estimatedMinutes: number;
}): PracticeBlock {
  const cents = centsFor(args.intensity);
  return {
    id: args.id,
    type: args.type,
    title: args.title,
    subtitle: args.subtitle,
    reason: args.reason,
    bridge: args.bridge,
    estimatedMinutes: args.estimatedMinutes,
    coachIntensity: args.intensity,
    instructions: args.instructions,
    target: {
      metricKey: 'pitchAccuracy',
      scaleName: args.scaleName,
      // The drill's first note, so the reference-pitch chip has something to
      // play and the runner can name a starting point.
      midiNote: args.steps[0] ? noteNameToMidi(args.steps[0].note) ?? undefined : undefined,
      noteName: args.steps[0]?.note,
    },
    liveMode: {
      label: 'Metronome paces it; the mic grades every note',
      signals: ['pitch', 'tone'],
      requiresMic: true,
      requiresCamera: false,
      status: 'ready',
    },
    successCriteria: {
      summary: `${args.successSummary} Score ${passMarkFor(args.intensity)}+ out of 100 to pass.`,
      repetitions: 1,
      centsThreshold: cents,
    },
    evaluator: {
      evaluatorId: 'sequence',
      steps: args.steps,
      bpm: tempoFor(args.intensity),
      centsThreshold: cents,
      passMark: passMarkFor(args.intensity),
    },
    fallbackCriteria: args.fallbackCriteria,
    coachPromptContext: args.coachPromptContext,
    // No evidence: this is the daily work, not a response to a fault.
    evidenceRefs: [],
  };
}

/**
 * The day's technique staple. Always returns a block — this slot is reserved,
 * so it must never come back empty.
 */
export function buildTechniqueStaple(args: StapleArgs): PracticeBlock {
  const key = resolveKey(args.keyName);
  const requested = args.kind ?? stapleForDate(args.date);
  // The shift warm-up has no first-position form. Rather than skip a day of
  // general work, fall back to the frame check — the drill that has to be solid
  // before shifting is worth teaching anyway.
  const kind = requested === 'shift_prep' && args.canShift === false ? 'finger_frame' : requested;
  const wantsTwoOctaves = args.skillLevel === 'advanced' || args.intensity === 'advanced';
  const octaves = wantsTwoOctaves && args.canShift !== false ? 2 : 1;
  const inKey = args.keyName ? ` — the key you've been playing in` : '';

  switch (kind) {
    case 'arpeggio': {
      const spec = arpeggioCycle(key)[0];
      const midis = arpeggioNotes(spec, tonicMidi(key), octaves);
      return sequenceStaple({
        intensity: args.intensity,
        id: `staple:arpeggio:${key.name}`,
        type: 'arpeggio_cycle',
        title: `${spec.label} arpeggio`,
        subtitle: `Warm-up · ${key.name}`,
        reason: `Today's warm-up${inKey}. Not a fix for anything — just the daily work.`,
        bridge: `Arpeggios are how the ear learns to hear notes as part of a chord rather than as isolated pitches. ${spec.label} is home in ${key.name}.`,
        steps: annotate(midis),
        instructions: [
          `Play the ${spec.label} arpeggio once slowly on your own, listening for each chord tone ringing.`,
          'On the take, one note per click, with a clear stop before the next.',
          'Chord tones in tune make the open strings resonate — listen for that rather than watching your fingers.',
        ],
        successSummary: `Play the ${spec.label} arpeggio in tune from bottom to top and back.`,
        fallbackCriteria: `If detection is uncertain, play it against a drone on ${key.tonic}.`,
        coachPromptContext: `Coach a warm-up arpeggio in ${key.name}. This is routine work, not a correction.`,
        scaleName: key.name,
        estimatedMinutes: 5,
      });
    }

    case 'finger_frame': {
      // First position on the D string: open D, then 1-2-3-4 up to A4, which is
      // a unison with the open A string. That unison is the whole exercise —
      // it is the one place a collapsed hand frame becomes *audible* rather
      // than merely felt, because a slightly flat 4th finger beats against an
      // open string that is always in tune.
      //
      // Deliberately NOT snapped to the session key: the frame being checked is
      // the standard first-position major shape (whole–whole–half–whole), and
      // the 4th finger has to land on A for the open-string check to work at
      // all. Transposing it would quietly destroy the point of the drill.
      const D = OPEN_MIDI.D;
      const steps: SequenceStep[] = [
        { note: midiToNoteName(D), annotation: 'open D — let it ring' },
        { note: midiToNoteName(D + 2), annotation: '1st finger (E)' },
        { note: midiToNoteName(D + 4), annotation: '2nd finger (F#) — high, next to 3rd' },
        { note: midiToNoteName(D + 5), annotation: '3rd finger (G) — touching 2nd' },
        { note: midiToNoteName(D + 7), annotation: '4th finger (A) — reach without moving the hand' },
        { note: midiToNoteName(OPEN_MIDI.A), annotation: 'open A — THE CHECK: same note?' },
        { note: midiToNoteName(D + 7), annotation: '4th finger again — match what you just heard' },
        { note: midiToNoteName(D + 5), annotation: '3rd finger (G)' },
        { note: midiToNoteName(D + 4), annotation: '2nd finger (F#)' },
        { note: midiToNoteName(D + 2), annotation: '1st finger (E)' },
        { note: midiToNoteName(D), annotation: 'open D — back home' },
      ];
      return sequenceStaple({
        intensity: args.intensity,
        id: 'staple:finger_frame',
        type: 'finger_pattern',
        title: 'Four-finger frame check',
        subtitle: 'Warm-up · D string, first position',
        reason: "Today's warm-up. Nothing flagged this — it's the check that catches a collapsing left hand before it costs you a passage.",
        bridge:
          'Your "frame" is the shape your left hand holds with all four fingers over their notes. It collapses slowly and silently — usually the 4th finger, from reaching instead of stretching — and you find out in a piece rather than here. This drill ends on the one test that makes it audible.',
        steps,
        instructions: [
          'Set your hand in first position on the D string with all four fingers hovering over their notes at once: E, F#, G, A. Do not play yet — just find the shape and keep it. Nothing shifts for the whole exercise.',
          'You will play open D, then 1st–2nd–3rd–4th finger up to A, then the OPEN A string. Those last two are the same note. If your 4th-finger A matches the open A exactly, your frame is intact; if it sounds flat or beats against it, the hand has collapsed inward.',
          'On the take, one note per click. Keep every finger you have already put down ON the string as you add the next — that is what holds the frame. Reach the 4th finger from the knuckle without letting the hand or thumb slide toward it.',
        ],
        successSummary: 'Play the frame up and back with the 4th-finger A matching the open A.',
        fallbackCriteria:
          'If detection is uncertain, do the check by ear alone: play your 4th-finger A and the open A together as a double stop. When the beating stops, the frame is right.',
        coachPromptContext:
          'Coach a first-position four-finger frame check on the D string. The 4th finger against the open A is the diagnostic. Routine warm-up work, not a correction.',
        estimatedMinutes: 4,
      });
    }

    case 'shift_prep': {
      const midis = [OPEN_MIDI.A, snapToKey(OPEN_MIDI.A + 2, key), snapToKey(OPEN_MIDI.A + 7, key),
        snapToKey(OPEN_MIDI.A + 2, key), OPEN_MIDI.A];
      return sequenceStaple({
        intensity: args.intensity,
        id: 'staple:shift_prep',
        type: 'shifting_ladder',
        title: 'Shift warm-up',
        subtitle: 'Warm-up · A string',
        reason: "Today's warm-up. Routine shifting practice, not a response to a miss.",
        bridge: 'Up to third position and back, with the open A as your reference. Practised cold, shifts stay reliable when the music needs them.',
        steps: annotate(midis, 'A'),
        instructions: [
          'Play the open A, then find third position with your 1st finger and check it against the open string.',
          'On the take, one note per click. Release the thumb and let the hand travel between clicks — arrive early and wait.',
          "Don't slide into tune after the note sounds. Landing there is the skill.",
        ],
        successSummary: 'Shift up and back on the A string, landing in tune.',
        fallbackCriteria: 'If detection is uncertain, practise the shift silently with the bow off the string.',
        coachPromptContext: 'Coach a daily shifting warm-up on the A string. Routine work, not a correction.',
        estimatedMinutes: 5,
      });
    }

    case 'long_tones': {
      // Tone, not pitch — judged by the tone-fault evaluator, no click.
      return {
        id: 'staple:long_tones',
        type: 'tone',
        title: 'Long tones',
        subtitle: 'Warm-up · open strings',
        reason: "Today's warm-up. Nothing flagged this — it's how a session starts.",
        bridge: 'Slow whole bows on open strings, before the left hand has anything to answer for. Everything about your sound is easier to hear when there are no fingers involved.',
        estimatedMinutes: 4,
        coachIntensity: args.intensity,
        instructions: [
          'Open D, as slow a full bow as you can hold — aim for eight counts each way.',
          'Keep the contact point steady between bridge and fingerboard, and the speed even from frog to tip.',
          'Play four bows on each of D and A. Listen to the middle of the stroke, where tone usually thins.',
        ],
        target: { metricKey: 'toneQuality', string: 'D', midiNote: OPEN_MIDI.D },
        liveMode: {
          label: 'Mic checks tone cleanliness',
          signals: ['tone', 'pitch'],
          requiresMic: true,
          requiresCamera: false,
          status: 'ready',
        },
        successCriteria: { summary: 'Produce 5 clean, even long bows with no scratch or thinning.', repetitions: 5 },
        evaluator: { evaluatorId: 'toneFault', requiredCleanFraction: 0.7 },
        fallbackCriteria: 'Record three open-string bows and compare the cleanest with the others.',
        coachPromptContext: 'Coach a daily long-tone warm-up on open strings. Routine work, not a correction.',
        evidenceRefs: [],
      };
    }

    case 'scale':
    default: {
      const midis = scaleNotes(key, tonicMidi(key), octaves);
      return sequenceStaple({
        intensity: args.intensity,
        id: `staple:scale:${key.name}`,
        type: 'scale_lock',
        title: `${key.name} scale`,
        subtitle: `Warm-up · ${octaves} octave${octaves === 1 ? '' : 's'}`,
        reason: `Today's warm-up${inKey}. Nothing flagged this — it's the daily work.`,
        bridge: `A scale is where intonation is cheapest to fix, because there is nothing else going on. Playing it in ${key.name} means the notes are the ones your music actually uses.`,
        steps: annotate(midis),
        instructions: [
          `Play the ${key.name} scale once slowly on your own first, listening rather than reading.`,
          'On the take, one note per click, with a clear stop before the next.',
          'Check the notes that share a pitch with an open string — they should make it ring.',
        ],
        successSummary: `Play the ${key.name} scale up and back, keeping all but a note or two in tune.`,
        fallbackCriteria: `If detection is uncertain, play the scale slowly against a drone on ${key.tonic}.`,
        coachPromptContext: `Coach a daily ${key.name} scale warm-up. Routine work, not a correction.`,
        scaleName: key.name,
        estimatedMinutes: 5,
      });
    }
  }
}
