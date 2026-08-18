import type { PracticeBlock } from '../practiceBlocks';
import { clampSequenceBpm } from '../sequenceSteps';
import { buildSequenceBlock, type ExerciseContext } from './types';
import { stepsFromMidi } from './types';
import { OPEN_MIDI, stringForMidi, type ViolinString } from './fingerboard';
import { resolveKey, scaleNotes } from './theory';

// ─────────────────────────────────────────────────────────────
// Family 10 — Rhythmic acceleration (Galamian)
//
// For the passage that is fine slowly and falls apart at tempo. The failure is
// coordination, not knowledge: the left hand and the bow arm drift out of
// agreement as the gaps between notes shrink.
//
// Galamian's answer is to keep the *pulse* fixed and put more notes inside it —
// one per beat, then two, then three, then four. The player never speeds up;
// the notes get closer together underneath a beat that never moves, which is
// exactly the skill the passage needs and nothing like "play it faster".
//
// The evaluator still grades one note per click, so the drill runs one rung at
// a time and the click tempo carries the subdivision. That keeps the grading
// honest: the app judges what it actually asked for.
// ─────────────────────────────────────────────────────────────

/** Base pulse the subdivisions sit inside. Deliberately slow. */
const BASE_PULSE_BPM = 52;

// The ceiling is the runner's, not a number of our own: the take's click is
// clamped by clampSequenceBpm, so any faster figure quoted in the instructions
// below would describe a drill the player never actually hears.

function rungFor(intensity: ExerciseContext['intensity']): number {
  if (intensity === 'guided') return 2;
  if (intensity === 'balanced') return 3;
  return 4;
}

export function generateRhythmicAcceleration(ctx: ExerciseContext): PracticeBlock | null {
  const { target } = ctx.evidence;

  // Prefer the player's own figure; fall back to a scale in the passage's key,
  // which is what the run was made of anyway.
  const key = resolveKey(target.keyName);
  const anchor = target.midiSequence?.[0] ?? target.midiNote ?? OPEN_MIDI.D;
  const source = target.midiSequence && target.midiSequence.length >= 4
    ? target.midiSequence
    : scaleNotes(key, anchor, 1);
  if (source.length < 4) return null;

  const notesPerBeat = rungFor(ctx.intensity);
  const clickBpm = clampSequenceBpm(BASE_PULSE_BPM * notesPerBeat);
  // The pulse the player will actually feel, after the clamp — quoting the
  // nominal BASE_PULSE_BPM here would not match the click they hear.
  const pulseBpm = Math.round(clickBpm / notesPerBeat);

  const preferString = (target.string ?? target.strings?.[0]) as ViolinString | undefined;
  const steps = stepsFromMidi(source, {
    preferString,
    allowShifting: ctx.canShift,
    annotate: (_midi, index) =>
      index % notesPerBeat === 0 ? `beat ${Math.floor(index / notesPerBeat) + 1}` : undefined,
  });

  const played = target.notesPerSecond
    ? ` You were pushing it at about ${target.notesPerSecond.toFixed(1)} notes a second.`
    : '';

  return buildSequenceBlock({
    ctx,
    slug: 'acceleration',
    type: 'acceleration',
    title: `${notesPerBeat} notes per beat`,
    subtitle: `Pulse stays at ${pulseBpm}`,
    reason: ctx.evidence.reason,
    bridge: `The notes are the same ones that fell apart at speed.${played} What changes here is that the pulse stays put at ${pulseBpm} and you fit ${notesPerBeat} notes inside each beat. You are not playing faster — the beat is holding still while the notes get closer, which is the coordination the passage actually needs.`,
    steps,
    bpm: clickBpm,
    estimatedMinutes: 6,
    instructions: [
      `${notesPerBeat} notes per beat, pulse at ${pulseBpm}.`,
      'The click marks every note. Count the beats, not the notes.',
    ],
    successSummary: `Play all ${steps.length} notes at ${notesPerBeat} per beat without the pulse slipping, keeping all but a note or two in tune.`,
    fallbackCriteria: `If note detection is uncertain, play the figure left-hand pizzicato at ${notesPerBeat} notes per beat — the coordination is still trainable without the bow.`,
    coachPromptContext: `Coach a Galamian-style rhythmic acceleration at ${notesPerBeat} notes per beat over a ${pulseBpm} pulse. Focus on evenness and holding the pulse, not on speed. Evidence: ${ctx.evidence.evidenceSummary}`,
    target: {
      metricKey: 'rhythmAccuracy',
      string: preferString ?? stringForMidi(anchor),
      midiNote: source[0],
      scaleName: key.name,
      startSeconds: target.startSeconds,
      endSeconds: target.endSeconds,
    },
  });
}
