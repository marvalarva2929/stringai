import { useEffect, useRef, useState } from 'react';
import { addPitchListener, type PitchReading } from '../services/micPitch';
import { centsFromNearestNote } from '../services/dsp';
import { midiToNoteName } from '../lib/pitchNaming';

/** Fractional MIDI number of a frequency (A4 = 69 = 440Hz). */
function midiFromFrequency(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440);
}

export interface LiveTakeFeedback {
  /** Cents from the note being played (or from `targetMidi`, when the block has one). */
  cents: number | null;
  /** Note name currently being heard, e.g. "B3". Null while silent. */
  noteName: string | null;
  /** Completed note attempts heard so far this take. */
  reps: number;
  /** True while a note is actually sounding. */
  voiced: boolean;
}

// A reading below this clarity is the detector guessing at room noise.
const MIN_CLARITY = 0.5;
// A note has to sound this long to count as a rep, filtering out bow-change blips.
const MIN_REP_MS = 250;
// Silence this long ends the current rep.
const REP_GAP_MS = 120;

/**
 * Live pitch feedback for a take in progress: what the player is playing right
 * now, how far off it is, and how many reps they've banked. Purely observational
 * — the graded verdict still comes from the recorded clip (see runEvaluator), so
 * a dropout here costs the player nothing.
 *
 * Only subscribes while `active`. Emits nothing when the native mic-pitch module
 * is absent (Android, Expo Go), in which case the take screen just shows less.
 */
export function useTakeLiveFeedback(active: boolean, targetMidi?: number): LiveTakeFeedback {
  const [state, setState] = useState<LiveTakeFeedback>({ cents: null, noteName: null, reps: 0, voiced: false });

  // Rep tracking lives in refs — it updates far faster than we want to re-render.
  const noteStartedAtRef = useRef<number | null>(null);
  const lastVoicedAtRef = useRef(0);
  const countedCurrentRef = useRef(false);
  const repsRef = useRef(0);

  useEffect(() => {
    if (!active) {
      noteStartedAtRef.current = null;
      countedCurrentRef.current = false;
      repsRef.current = 0;
      setState({ cents: null, noteName: null, reps: 0, voiced: false });
      return;
    }

    const onReading = (reading: PitchReading) => {
      const now = Date.now();
      // The metronome click needs no special case here: it is an aperiodic noise
      // tick (see lib/clickTone.ts), so it never clears the clarity gate. It used
      // to be a 1 kHz sine, which did — on every beat, exactly when the gauge is
      // read — and was excluded by frequency, which also blinded the gauge to a
      // real B5 at that pitch.
      const voiced = reading.voiced
        && reading.clarity >= MIN_CLARITY
        && reading.hz > 0;

      if (!voiced) {
        // A gap long enough to close out the note that was sounding.
        if (noteStartedAtRef.current != null && now - lastVoicedAtRef.current > REP_GAP_MS) {
          noteStartedAtRef.current = null;
          countedCurrentRef.current = false;
        }
        setState((prev) => (prev.voiced ? { ...prev, voiced: false, cents: null, noteName: null } : prev));
        return;
      }

      lastVoicedAtRef.current = now;
      if (noteStartedAtRef.current == null) noteStartedAtRef.current = now;

      // Count the rep once it has sustained long enough to be a real note.
      if (!countedCurrentRef.current && now - noteStartedAtRef.current >= MIN_REP_MS) {
        countedCurrentRef.current = true;
        repsRef.current += 1;
      }

      // Against the block's own target when it has one, so a wrong note reads as
      // badly out of tune rather than as a perfectly-tuned different note.
      const cents = targetMidi != null
        ? (midiFromFrequency(reading.hz) - targetMidi) * 100
        : centsFromNearestNote(reading.hz);
      const heardMidi = targetMidi ?? Math.round(midiFromFrequency(reading.hz));

      setState({
        cents,
        noteName: midiToNoteName(heardMidi),
        reps: repsRef.current,
        voiced: true,
      });
    };

    const sub = addPitchListener(onReading);
    return () => sub?.remove();
  }, [active, targetMidi]);

  return state;
}
