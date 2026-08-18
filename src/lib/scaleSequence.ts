import { PITCH_CLASS_MIDI, midiToNoteName } from './pitchNaming';

const SCALE_INTERVALS = {
  major: [0, 2, 4, 5, 7, 9, 11, 12],
  naturalMinor: [0, 2, 3, 5, 7, 8, 10, 12],
  melodicMinor: [0, 2, 3, 5, 7, 9, 11, 12],
} as const;

type ScaleQuality = keyof typeof SCALE_INTERVALS;

function parseScaleName(scaleName: string): { root: string; quality: ScaleQuality } | null {
  const [root, ...rest] = scaleName.split(' ');
  const quality = rest.join(' ');
  if (quality === 'major') return { root, quality: 'major' };
  if (quality === 'minor') return { root, quality: 'naturalMinor' };
  if (quality === 'melodic minor') return { root, quality: 'melodicMinor' };
  return null;
}

/**
 * Ordered one-octave-up-and-back-down note sequence for a scale name like
 * "G major" (matches the exact names scaleForPitch() in practiceBlocks.ts
 * produces) — root up to the octave, then back down to the root, e.g.
 * G3,A3,B3,C4,D4,E4,F#4,G4,F#4,E4,D4,C4,B3,A3,G3.
 *
 * Rooted at the open-string octave (PITCH_CLASS_MIDI) by default. When
 * `anchorMidiNote` is given (the flagged note's actual octave, e.g. A3 rather
 * than the default open A4), the root is shifted to whichever octave puts
 * that note on its natural scale degree — so the judged sequence matches the
 * octave the player was actually told to focus on, instead of always
 * defaulting to the open-string register.
 */
/**
 * Highest scale root that keeps a one-octave scale inside first position: from
 * B4 the octave lands on B5, the 4th finger on the E string. Anything higher
 * needs a shift.
 */
const SCALE_ROOT_CEILING_MIDI = 71; // B4
/** Open G — nothing on the instrument sounds below it. */
const SCALE_ROOT_FLOOR_MIDI = 55; // G3

export function scaleNoteSequence(scaleName: string, anchorMidiNote?: number): string[] {
  const parsed = parseScaleName(scaleName);
  if (!parsed) return [];
  let rootMidi = PITCH_CLASS_MIDI[parsed.root];
  if (rootMidi == null) return [];
  // PITCH_CLASS_MIDI exists to name the open strings for the tuner (G3/D4/A4/E5),
  // and reusing it as a scale root put four keys an octave too high to play: a
  // C, C#, E or F scale climbed to C6/E6/F6, around sixth position on the E
  // string. Drills default to first position (see canShift in exercises/types.ts),
  // so a root above B4 has to come down an octave. G/D/A/B are already low
  // enough and keep their open-string register.
  while (rootMidi > SCALE_ROOT_CEILING_MIDI) rootMidi -= 12;
  while (rootMidi < SCALE_ROOT_FLOOR_MIDI) rootMidi += 12;
  if (anchorMidiNote != null) {
    const rootPitchClass = ((rootMidi % 12) + 12) % 12;
    const anchorPitchClass = ((anchorMidiNote % 12) + 12) % 12;
    const offset = ((anchorPitchClass - rootPitchClass) % 12 + 12) % 12;
    if (SCALE_INTERVALS[parsed.quality].some((interval) => interval % 12 === offset)) {
      rootMidi = anchorMidiNote - offset;
    }
  }
  const ascending = SCALE_INTERVALS[parsed.quality].map((interval) => rootMidi + interval);
  // Descend back to the root, skipping the octave note (already the last
  // ascending note) so it isn't played twice in a row.
  const descending = ascending.slice(0, -1).reverse();
  return [...ascending, ...descending].map(midiToNoteName);
}
