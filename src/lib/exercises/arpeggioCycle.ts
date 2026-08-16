import type { PracticeBlock } from '../practiceBlocks';
import { buildSequenceBlock, stepsFromMidi, tempoFor, type ExerciseContext } from './types';
import { arpeggioCycle, arpeggioNotes, resolveKey, type ArpeggioSpec } from './theory';
import { stringForMidi } from './fingerboard';

// ─────────────────────────────────────────────────────────────
// Family 1 — Arpeggio cycle
//
// For a player who reached for chord tones and landed under them. The drill is
// the chords of the key the passage was actually in, in the register they were
// actually playing, so the ear starts filing each note under a harmony instead
// of hunting for it as an isolated pitch.
//
// One chord per take rather than all seven at once: seven arpeggios is a
// twenty-minute session and a wall of notes, and a take that long can't be
// graded usefully — one slip in note 40 tells the player nothing about which
// chord they don't hear yet.
// ─────────────────────────────────────────────────────────────

/** Where in the cycle to start, by how much work the player has ahead of them. */
function chordFor(specs: ArpeggioSpec[], evidenceChordLabel?: string): ArpeggioSpec {
  // If the moment named the chord the player fumbled, drill that one.
  const matched = evidenceChordLabel
    ? specs.find((s) => s.label.toLowerCase() === evidenceChordLabel.toLowerCase())
    : undefined;
  return matched ?? specs[0];
}

/** Comfortable starting register for the drill, anchored to what they played. */
function startMidiFrom(ctx: ExerciseContext): number {
  const fromEvidence = ctx.evidence.target.midiSequence?.[0] ?? ctx.evidence.target.midiNote;
  if (fromEvidence != null) return Math.max(55, Math.min(fromEvidence, 74));
  return 62; // open D — the violin's home register
}

export function generateArpeggioCycle(ctx: ExerciseContext): PracticeBlock | null {
  const { target } = ctx.evidence;
  const key = resolveKey(target.keyName ?? target.chordLabel);
  const specs = arpeggioCycle(key);
  const spec = chordFor(specs, target.chordLabel);

  // Two octaves needs a shift. Asking for one from a player who has never been
  // taught to shift doesn't stretch them, it just gets a fingering invented.
  const wantsTwoOctaves = ctx.skillLevel === 'advanced' || ctx.intensity === 'advanced';
  const octaves = wantsTwoOctaves && ctx.canShift ? 2 : 1;
  const midis = arpeggioNotes(spec, startMidiFrom(ctx), octaves);
  if (midis.length < 4) return null;

  const preferString = target.string as ReturnType<typeof stringForMidi> | undefined;
  const steps = stepsFromMidi(midis, {
    preferString,
    allowShifting: ctx.canShift,
    annotate: (midi, index) => {
      // Naming the chord function on the root turns a pattern into a harmony.
      const isRoot = ((midi % 12) + 12) % 12 === spec.rootPitchClass;
      return isRoot && index === 0 ? `root of ${spec.label}` : undefined;
    },
  });

  const where = target.chordLabel
    ? `the ${target.chordLabel} arpeggio`
    : `the arpeggiated figure`;

  return buildSequenceBlock({
    ctx,
    slug: 'arpeggio_cycle',
    type: 'arpeggio_cycle',
    title: `${spec.label} arpeggio`,
    subtitle: `${spec.degree} in ${key.name}`,
    reason: ctx.evidence.reason,
    bridge: `${spec.label} is the ${spec.degree} of ${key.name} — ${spec.role}. These are the same notes as ${where} you played, one per click, so the chord tones become somewhere to land instead of somewhere to aim.`,
    steps,
    bpm: tempoFor(ctx.intensity),
    estimatedMinutes: octaves > 1 ? 7 : 5,
    instructions: [
      `${spec.label} is ${spec.role}. Play it once slowly on your own and listen for how the chord sits inside ${key.name}.`,
      'On the take, the metronome gives you one click per note. Stop the bow cleanly between notes so each one gets judged on its own.',
      'Aim for the note to ring against the open strings — a chord tone in tune makes the instrument resonate.',
    ],
    successSummary: `Play the ${spec.label} arpeggio in time, keeping all but a note or two in tune.`,
    fallbackCriteria: `If note detection is uncertain, play ${spec.label} slowly against a drone on ${key.name.split(' ')[0]} and hold each chord tone for two full bows.`,
    coachPromptContext: `Coach the ${spec.label} arpeggio (${spec.degree} of ${key.name}). Tie intonation to hearing the harmony, not to finger placement alone. Evidence: ${ctx.evidence.evidenceSummary}`,
    target: {
      metricKey: 'pitchAccuracy',
      scaleName: key.name,
      midiNote: midis[0],
      string: target.string,
      startSeconds: target.startSeconds,
      endSeconds: target.endSeconds,
    },
  });
}

/** The whole cycle, for callers that want to show what comes next. */
export function arpeggioCycleFor(keyName?: string | null): ArpeggioSpec[] {
  return arpeggioCycle(resolveKey(keyName));
}
