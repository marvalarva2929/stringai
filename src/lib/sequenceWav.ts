import { midiToFreq } from './pitchNaming';

// ─────────────────────────────────────────────────────────────
// Sequence preview audio (pure synthesis).
//
// Split from sequencePreview.ts, which writes the file: expo-file-system can't
// be type-stripped under the Node test harness, so anything that imports it is
// untestable there. Same split as pitchNaming.ts / referenceNote.ts.
//
// "Play it for me first."
//
// Reading a column of note names and imagining how they go is a skill, and it
// is not the skill these drills are for. Hearing the exercise once — the whole
// thing, in order, at the tempo you'll play it — is how anyone learns a passage
// from a teacher, and it removes the guesswork before the take starts.
//
// The whole sequence is rendered into ONE wav rather than scheduling a series
// of individual note files: playback timing then comes from the audio clock
// instead of from JS timers, so the preview is exactly the rhythm the player is
// about to be graded against. (Chaining timers is precisely what made the
// metronome drift.)
// ─────────────────────────────────────────────────────────────

const SAMPLE_RATE = 22050;
/** Fraction of each beat the note actually sounds for; the rest is the gap. */
const NOTE_DUTY = 0.72;
const ATTACK_S = 0.02;
const RELEASE_S = 0.09;

function writeWavHeader(view: DataView, dataBytes: number): void {
  const str = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  str(0, 'RIFF'); view.setUint32(4, 36 + dataBytes, true);
  str(8, 'WAVE'); str(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  str(36, 'data'); view.setUint32(40, dataBytes, true);
}

/** Same additive timbre as the single-note reference, so the two match. */
function sampleAt(frequency: number, t: number): number {
  return (
    0.55 * Math.sin(2 * Math.PI * frequency * t) +
    0.27 * Math.sin(2 * Math.PI * frequency * 2 * t) +
    0.12 * Math.sin(2 * Math.PI * frequency * 3 * t) +
    0.06 * Math.sin(2 * Math.PI * frequency * 4 * t)
  );
}

export function buildSequenceWav(midiNotes: number[], bpm: number): Uint8Array {
  const beatSeconds = 60 / Math.max(20, bpm);
  const noteSeconds = beatSeconds * NOTE_DUTY;
  const samplesPerBeat = Math.floor(SAMPLE_RATE * beatSeconds);
  const samplesPerNote = Math.floor(SAMPLE_RATE * noteSeconds);
  const numSamples = Math.max(1, samplesPerBeat * midiNotes.length);
  const dataBytes = numSamples * 2;

  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  writeWavHeader(view, dataBytes);

  midiNotes.forEach((midi, index) => {
    const frequency = midiToFreq(midi);
    const offset = index * samplesPerBeat;
    for (let i = 0; i < samplesPerNote; i++) {
      const t = i / SAMPLE_RATE;
      let env = 1;
      if (t < ATTACK_S) env = t / ATTACK_S;
      else if (t > noteSeconds - RELEASE_S) env = Math.max(0, (noteSeconds - t) / RELEASE_S);
      const value = Math.round(env * 0.6 * 32767 * sampleAt(frequency, t));
      view.setInt16(44 + (offset + i) * 2, Math.max(-32768, Math.min(32767, value)), true);
    }
  });

  return new Uint8Array(buf);
}

/** Stable cache name for one sequence at one tempo. */
export function sequenceCacheKey(midiNotes: number[], bpm: number): string {
  // Length + tempo + a cheap rolling hash: enough to avoid collisions between
  // drills without writing an unbounded set of files named after every note.
  let hash = 0;
  for (const midi of midiNotes) hash = (hash * 31 + midi) >>> 0;
  return `seq_${midiNotes.length}_${Math.round(bpm)}_${hash.toString(36)}.wav`;
}

/** How long the preview runs, so a caller can show progress or auto-reset. */
export function sequencePreviewSeconds(stepCount: number, bpm: number): number {
  return (stepCount * 60) / Math.max(20, bpm);
}
