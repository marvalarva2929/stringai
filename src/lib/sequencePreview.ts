import { File, Paths } from 'expo-file-system';
import { noteNameToMidi } from './pitchNaming';
import type { SequenceStep } from './practiceBlocks';
import { buildSequenceWav, sequenceCacheKey } from './sequenceWav';

/**
 * Writes the exercise preview to the cache and returns a file:// URI, or null
 * when the steps carry no parseable notes (a camera or tone drill has nothing
 * to preview). Synthesis itself lives in sequenceWav.ts so it stays testable.
 */
export async function getSequencePreviewUri(
  steps: SequenceStep[],
  bpm: number,
): Promise<string | null> {
  const midiNotes = steps
    .map((step) => noteNameToMidi(step.note))
    .filter((midi): midi is number => midi != null);
  if (midiNotes.length === 0) return null;

  const file = new File(Paths.cache, sequenceCacheKey(midiNotes, bpm));
  await file.write(buildSequenceWav(midiNotes, bpm));
  return file.uri;
}

export { sequencePreviewSeconds } from './sequenceWav';
