import { useCallback, useEffect, useRef, useState } from 'react';
import { Audio } from 'expo-av';
import type { SequenceStep } from '../lib/practiceBlocks';
import { getSequencePreviewUri } from '../lib/sequencePreview';

/**
 * Plays the whole exercise, in order, at its tempo.
 *
 * Rendered as a single wav (see sequencePreview.ts) so the rhythm comes from
 * the audio clock rather than from chained JS timers.
 */
export function useSequencePreview(steps: SequenceStep[], bpm: number) {
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const soundRef = useRef<Audio.Sound | null>(null);

  const unload = useCallback(async () => {
    const sound = soundRef.current;
    soundRef.current = null;
    if (sound) await sound.unloadAsync().catch(() => {});
  }, []);

  useEffect(() => {
    // A new drill's preview is a different file; drop the old one.
    void unload();
    setPlaying(false);
  }, [steps, bpm, unload]);

  useEffect(() => () => { void unload(); }, [unload]);

  const stop = useCallback(async () => {
    setPlaying(false);
    await soundRef.current?.stopAsync().catch(() => {});
  }, []);

  const toggle = useCallback(async () => {
    if (playing) { await stop(); return; }
    if (steps.length === 0) return;

    setLoading(true);
    try {
      const uri = await getSequencePreviewUri(steps, bpm);
      if (!uri) return;
      await unload();
      await Audio.setAudioModeAsync({ playsInSilentModeIOS: true });
      const { sound } = await Audio.Sound.createAsync({ uri }, { shouldPlay: true, volume: 1 });
      soundRef.current = sound;
      setPlaying(true);
      sound.setOnPlaybackStatusUpdate((status) => {
        if (status.isLoaded && status.didJustFinish) setPlaying(false);
      });
    } catch {
      // A preview that won't play is a missing nicety, not a broken exercise.
      setPlaying(false);
    } finally {
      setLoading(false);
    }
  }, [playing, steps, bpm, stop, unload]);

  return { playing, loading, toggle, stop };
}
