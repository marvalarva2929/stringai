import { useState, useRef, useEffect, useCallback } from 'react';
import { Audio } from 'expo-av';
import { File, Paths } from 'expo-file-system';
import { forceSpeakerOutput } from '../services/micPitch';
import { buildClickWav } from '../lib/clickTone';

let cachedClickUri: string | null = null;
// The write below is unconditional on the first call of each app session, so a changed
// waveform does reach existing installs on its own. The version is belt-and-braces:
// it keeps a stale file from being picked up if an existence check is ever added here,
// and it makes the history legible. v2 replaced the original 1 kHz sine — which the
// pitch detector read as a note on every beat — with an aperiodic burst; v3 moved that
// burst's body down to 1.4 kHz so it sounds like a woodblock instead of a hiss.
const CLICK_FILENAME = 'metronome_click_v3.wav';

async function getClickUri(): Promise<string> {
  if (cachedClickUri) return cachedClickUri;
  const file = new File(Paths.cache, CLICK_FILENAME);
  await file.write(buildClickWav());
  cachedClickUri = file.uri;
  return cachedClickUri;
}

export interface MetronomeOptions {
  /** Beats per bar for the downbeat accent. The recording overlay flashes
   *  brighter on beat 1 so the player can find the bar without counting. */
  beatsPerBar?: number;
  /** Run the clicks silently — the beat callbacks and beat counter still fire,
   *  driving a visual-only metronome. */
  muted?: boolean;
}

export interface MetronomeStartOptions {
  /**
   * Audible count-in beats played before beat 0, on the same clock.
   *
   * The count-in used to be a chain of React setTimeouts in the runner, with
   * the recorder's `await` calls landing between the last count-in click and
   * the first graded beat. That gap was a beat plus however long the mic took
   * to open — which is exactly the "first two beats sound off" that a player
   * hears. One clock, no awaits inside it, and the handover is just another
   * beat.
   */
  leadInBeats?: number;
}

/**
 * Paces a take at bpm: plays a click and fires onBeat(i) each beat.
 *
 * `beatCount` bounds the run (a scale take stops after its last note). Pass
 * Infinity for a free-running metronome alongside an open-ended recording.
 */
export function useMetronome(
  bpm: number,
  beatCount: number,
  onBeat?: (index: number) => void,
  options: MetronomeOptions = {},
) {
  const { beatsPerBar = 4, muted = false } = options;
  const [running, setRunning] = useState(false);
  const [currentBeat, setCurrentBeat] = useState(-1);
  /** Count-in beats still to play before beat 0; 0 once the take is under way. */
  const [leadInRemaining, setLeadInRemaining] = useState(0);
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  const soundRef = useRef<Audio.Sound | null>(null);
  const loadingRef = useRef<Promise<Audio.Sound> | null>(null);
  /** Guards a double start across the await in `start` (timerRef is still null then). */
  const startingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const beatRef = useRef(-1);
  const onBeatRef = useRef(onBeat);
  onBeatRef.current = onBeat;

  // Loads the click once and keeps it ready, so the count-in click and the
  // graded take's clicks share one prepared sound instead of each reloading it.
  const ensureSound = useCallback(async () => {
    if (soundRef.current) return soundRef.current;
    if (!loadingRef.current) {
      loadingRef.current = (async () => {
        await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
        // playAndRecord (above) defaults output to the quiet earpiece — force
        // it back to the speaker so the count-in click before recording
        // starts is audible too, not just the graded take's own clicks.
        await forceSpeakerOutput();
        const uri = await getClickUri();
        const { sound } = await Audio.Sound.createAsync({ uri }, { shouldPlay: false, volume: 0.9 });
        soundRef.current = sound;
        return sound;
      })();
    }
    return loadingRef.current;
  }, []);

  const stop = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    startingRef.current = false;
    setRunning(false);
    setLeadInRemaining(0);
  }, []);

  useEffect(() => {
    return () => {
      stop();
      const sound = soundRef.current;
      soundRef.current = null;
      if (sound) sound.unloadAsync().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = useCallback(async (startOptions: MetronomeStartOptions = {}) => {
    if (timerRef.current || startingRef.current) return;
    startingRef.current = true;
    const leadIn = Math.max(0, Math.round(startOptions.leadInBeats ?? 0));
    // Everything async happens BEFORE the clock starts. Any await between two
    // beats becomes an audible stumble, so there are none once ticking begins.
    const sound = await ensureSound();
    startingRef.current = false;

    beatRef.current = -1;
    setRunning(true);
    setLeadInRemaining(leadIn);

    const period = 60000 / bpm;
    const startedAt = Date.now();
    // Beat n is scheduled against absolute time, not chained off the previous
    // timeout, so a slow frame delays one beat instead of shifting every beat
    // after it. setInterval accumulated that error indefinitely.
    let index = 0;

    const tick = () => {
      const isLeadIn = index < leadIn;
      if (!mutedRef.current) sound.replayAsync().catch(() => {});

      if (isLeadIn) {
        // Counts DOWN TO the first beat, not down to zero: with a 4-beat lead-in
        // the clicks read 4, 3, 2, 1 and the take begins on the very next one.
        // Counting to zero showed "Go!" a full beat before anything started —
        // an extra beat the player sat through wondering what happened.
        setLeadInRemaining(leadIn - index);
      } else {
        // Clears on the first graded beat, which is what flips the screen from
        // the count-in to the take. Unconditional: reading leadInRemaining here
        // would read the value captured when `start` was created, not the live one.
        setLeadInRemaining(0);
        beatRef.current = index - leadIn;
        if (beatRef.current >= beatCount) {
          stop();
          return;
        }
        setCurrentBeat(beatRef.current);
        onBeatRef.current?.(beatRef.current);
      }

      index += 1;
      if (index - leadIn >= beatCount) {
        stop();
        return;
      }
      // `index` has already been advanced, so this IS the next beat's target
      // time — wait until it, don't add another period on top. Doing that made
      // the very first gap twice as long as every other one.
      const nextBeatAt = startedAt + index * period;
      timerRef.current = setTimeout(tick, Math.max(0, nextBeatAt - Date.now()));
    };

    tick();
  }, [bpm, beatCount, stop, ensureSound]);

  // Pre-writes the click WAV to the cache so the first beat isn't delayed by
  // file I/O. Deliberately does NOT call ensureSound: that reconfigures the
  // shared AVAudioSession (setAudioModeAsync), which interrupts a live
  // AVCaptureSession — and on the Analyze screen the camera preview is already
  // running when this is called, so touching the session here would freeze the
  // pose/bow stream that calibration and the live coach depend on. The session
  // is set up lazily in ensureSound, at the moment the metronome first plays.
  const preload = useCallback(async () => {
    try {
      await getClickUri();
    } catch {
      // A metronome that can't pre-write its click is not worth failing over.
    }
  }, []);

  return {
    running,
    currentBeat,
    /** Count-in beats left before beat 0. Drives the "get ready" display. */
    leadInRemaining,
    /** True while the count-in is running and the graded beats haven't begun. */
    inLeadIn: leadInRemaining > 0,
    /** 0-based position within the bar; -1 before the first beat. */
    beatInBar: currentBeat < 0 ? -1 : currentBeat % beatsPerBar,
    start,
    stop,
    preload,
  };
}
