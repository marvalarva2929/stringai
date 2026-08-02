import { useState, useRef, useEffect, useCallback } from 'react';
import { Audio } from 'expo-av';
import { File, Paths } from 'expo-file-system';
import { forceSpeakerOutput } from '../services/micPitch';

function buildClickWav(): Uint8Array {
  const SR = 22050;
  const DURATION = 0.05;
  const numSamples = Math.floor(SR * DURATION);
  const dataBytes = numSamples * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const str = (off: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };

  str(0, 'RIFF'); v.setUint32(4, 36 + dataBytes, true);
  str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, SR, true);
  v.setUint32(28, SR * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, dataBytes, true);

  for (let i = 0; i < numSamples; i++) {
    const t = i / SR;
    const env = Math.exp(-t * 60); // short percussive decay
    const sig = Math.sin(2 * Math.PI * 1000 * t);
    v.setInt16(44 + i * 2, Math.round(env * 0.8 * 32767 * sig), true);
  }
  return new Uint8Array(buf);
}

let cachedClickUri: string | null = null;
async function getClickUri(): Promise<string> {
  if (cachedClickUri) return cachedClickUri;
  const file = new File(Paths.cache, 'metronome_click.wav');
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
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  const soundRef = useRef<Audio.Sound | null>(null);
  const loadingRef = useRef<Promise<Audio.Sound> | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const beatRef = useRef(-1);
  const onBeatRef = useRef(onBeat);
  onBeatRef.current = onBeat;

  // Loads the click sound once and keeps it around so a count-in click
  // (playClick, before the take starts) and the graded take's own clicks
  // share the same ready-to-play sound instead of each reloading it.
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
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setRunning(false);
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

  // A single click with no beat-counting/grading effect — used to give the
  // player a tempo count-in (e.g. during a "get ready" countdown) before the
  // graded take begins.
  const playClick = useCallback(async () => {
    const sound = await ensureSound();
    sound.replayAsync().catch(() => {});
  }, [ensureSound]);

  const start = useCallback(async () => {
    if (timerRef.current) return;
    const sound = await ensureSound();
    beatRef.current = -1;
    setRunning(true);

    const tick = () => {
      beatRef.current += 1;
      if (beatRef.current >= beatCount) {
        stop();
        return;
      }
      setCurrentBeat(beatRef.current);
      if (!mutedRef.current) sound.replayAsync().catch(() => {});
      onBeatRef.current?.(beatRef.current);
    };

    tick();
    timerRef.current = setInterval(tick, Math.round(60000 / bpm));
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
    /** 0-based position within the bar; -1 before the first beat. */
    beatInBar: currentBeat < 0 ? -1 : currentBeat % beatsPerBar,
    start,
    stop,
    playClick,
    preload,
  };
}
