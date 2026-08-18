import { useCallback, useEffect, useRef, useState } from 'react';
import { addPitchListener, type PitchReading } from '../services/micPitch';

/**
 * Live "did you land this note?" detection, for drilling one pitch at a time.
 *
 * Deliberately not the record-then-grade loop the rest of the practice runner
 * uses. Intonation cannot be fixed from a verdict delivered after the fact —
 * nobody can feel 23 cents in retrospect. It is fixed *inside* the note: you
 * sound it, you hear that it is flat, you move the finger until it locks, and
 * the hand remembers where that was. That requires feedback while the note is
 * still sounding, which means the live mic stream rather than a graded clip.
 *
 * A landing counts when the pitch stays inside tolerance continuously for
 * HOLD_MS. Requiring it to be *held* is the point: brushing past the right pitch
 * on the way somewhere else is not landing it, and a detector that rewarded the
 * brush would certify exactly the habit the drill exists to break. The player
 * then has to stop the note before another can count, so one long lucky note
 * cannot clear the whole drill.
 */

/** How long the pitch must sit inside tolerance for the note to count as landed. */
const HOLD_MS = 700;
/** Silence this long ends the current note, arming the next landing. */
const RELEASE_MS = 180;
/** Below this the detector is guessing at room noise. Matches useTakeLiveFeedback. */
const MIN_CLARITY = 0.5;
/**
 * How long the approach note must sound before it counts as played.
 *
 * Shorter than HOLD_MS on purpose: the approach only has to be identifiable,
 * not held in tune. It is where the hand is coming FROM, and the thing being
 * judged is where it arrives.
 */
const APPROACH_MS = 250;
/** How wide a net to cast when recognising the approach note. */
const APPROACH_TOLERANCE_CENTS = 60;

export interface LiveNoteLanding {
  /** Signed cents from the target note. Null while nothing is sounding. */
  cents: number | null;
  /** True while a note is actually sounding. */
  voiced: boolean;
  /** Landings banked so far. */
  landed: number;
  /** 0–1 progress through the current hold, for a fill/ring. Resets on release. */
  holdProgress: number;
  /**
   * With an approach note configured: whether it has been played, so the next
   * landing counts. Always true when there is no approach note.
   */
  approached: boolean;
  /** Clears the count, for moving to the next note or restarting. */
  reset: () => void;
}

function centsBetween(hz: number, targetHz: number): number {
  return 1200 * Math.log2(hz / targetHz);
}

export function useLiveNoteLanding(
  active: boolean,
  targetHz: number,
  toleranceCents: number,
  /**
   * The note the hand is arriving FROM. When set, a landing only counts if this
   * note was played first — which is the whole point of drilling an interval
   * rather than a note. Intonation is relative: a player can find a pitch from
   * silence and still miss it every time when approaching it from the note
   * before, and that second case is the one that shows up in real playing.
   */
  approachHz?: number | null,
): LiveNoteLanding {
  const [state, setState] = useState({
    cents: null as number | null,
    voiced: false,
    landed: 0,
    holdProgress: 0,
    approached: !approachHz,
  });

  // Hold tracking lives in refs: readings arrive ~47/sec and must not each
  // cause a React render.
  const inToleranceSinceRef = useRef<number | null>(null);
  const lastVoicedAtRef = useRef(0);
  const countedCurrentRef = useRef(false);
  const landedRef = useRef(0);
  const onApproachSinceRef = useRef<number | null>(null);
  const approachedRef = useRef(!approachHz);

  const reset = useCallback(() => {
    inToleranceSinceRef.current = null;
    countedCurrentRef.current = false;
    landedRef.current = 0;
    onApproachSinceRef.current = null;
    approachedRef.current = !approachHz;
    setState({ cents: null, voiced: false, landed: 0, holdProgress: 0, approached: !approachHz });
  }, [approachHz]);

  useEffect(() => {
    if (!active) {
      inToleranceSinceRef.current = null;
      countedCurrentRef.current = false;
      return;
    }

    const sub = addPitchListener((reading: PitchReading) => {
      const now = Date.now();

      const usable = reading.voiced && reading.clarity >= MIN_CLARITY && reading.hz > 0;
      if (!usable) {
        // Only treat this as a release once the gap is long enough — a single
        // dropped frame mid-note must not discard an in-progress hold.
        if (now - lastVoicedAtRef.current > RELEASE_MS) {
          inToleranceSinceRef.current = null;
          countedCurrentRef.current = false;
          setState((prev) =>
            prev.voiced || prev.holdProgress > 0
              ? { ...prev, cents: null, voiced: false, holdProgress: 0 }
              : prev,
          );
        }
        return;
      }

      lastVoicedAtRef.current = now;
      const cents = centsBetween(reading.hz, targetHz);
      const inTolerance = Math.abs(cents) <= toleranceCents;

      // Arriving from the right note is half of an interval drill. Recognised on
      // a loose tolerance and a short hold: the approach note only has to be
      // identifiably itself, because it is not the note being judged.
      if (approachHz && !approachedRef.current) {
        const fromCents = centsBetween(reading.hz, approachHz);
        if (Math.abs(fromCents) <= APPROACH_TOLERANCE_CENTS) {
          if (onApproachSinceRef.current == null) onApproachSinceRef.current = now;
          if (now - onApproachSinceRef.current >= APPROACH_MS) {
            approachedRef.current = true;
            setState((prev) => ({ ...prev, cents, voiced: true, approached: true }));
            return;
          }
        } else {
          onApproachSinceRef.current = null;
        }
        // Until the approach is played, the target is not being judged — show
        // the pitch, bank nothing.
        setState((prev) => ({ ...prev, cents, voiced: true, holdProgress: 0 }));
        return;
      }

      if (!inTolerance) {
        // Drifting out restarts the hold, but does not un-bank a landing that
        // already completed — the note was held, and then it ended.
        inToleranceSinceRef.current = null;
        setState((prev) => ({ ...prev, cents, voiced: true, holdProgress: 0 }));
        return;
      }

      if (inToleranceSinceRef.current == null) inToleranceSinceRef.current = now;
      const held = now - inToleranceSinceRef.current;

      if (held >= HOLD_MS && !countedCurrentRef.current) {
        countedCurrentRef.current = true;
        landedRef.current += 1;
        // Re-arm: the next landing needs its own approach, so one arrival
        // cannot be parlayed into several.
        approachedRef.current = !approachHz;
        onApproachSinceRef.current = null;
        setState({
          cents,
          voiced: true,
          landed: landedRef.current,
          holdProgress: 1,
          approached: !approachHz,
        });
        return;
      }

      setState((prev) => ({
        ...prev,
        cents,
        voiced: true,
        holdProgress: countedCurrentRef.current ? 1 : Math.min(1, held / HOLD_MS),
      }));
    });

    return () => sub?.remove();
  }, [active, targetHz, toleranceCents, approachHz]);

  return { ...state, reset };
}
