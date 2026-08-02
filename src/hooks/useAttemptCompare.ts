import { useCallback, useEffect, useRef, useState } from 'react';
import { Audio } from 'expo-av';
import { File } from 'expo-file-system';
import { writeTakeClipWav } from '../lib/takeClip';
import { getReferenceNoteUri, noteNameToMidi } from '../lib/referenceNote';

const GAP_MS = 250;

/** Plays a recorded attempt's own clip, then the reference pitch it was
 *  judged against — a quick "what you played" vs "what it should sound like"
 *  A/B for a single result-screen chip. */
export function useAttemptCompare() {
  const [playingIndex, setPlayingIndex] = useState<number | null>(null);
  const soundRef = useRef<Audio.Sound | null>(null);
  const tokenRef = useRef(0);

  useEffect(() => {
    return () => {
      tokenRef.current += 1;
      soundRef.current?.unloadAsync().catch(() => {});
    };
  }, []);

  const playOnce = useCallback(async (uri: string, token: number) => {
    const { sound } = await Audio.Sound.createAsync({ uri }, { shouldPlay: true, volume: 1.0 });
    if (token !== tokenRef.current) {
      sound.unloadAsync().catch(() => {});
      return;
    }
    soundRef.current = sound;
    await new Promise<void>((resolve) => {
      sound.setOnPlaybackStatusUpdate((st) => {
        if (st.isLoaded && st.didJustFinish) resolve();
      });
    });
    sound.unloadAsync().catch(() => {});
    if (soundRef.current === sound) soundRef.current = null;
  }, []);

  const compare = useCallback(
    async (
      index: number,
      samples: Float32Array,
      sampleRate: number,
      startSeconds: number,
      endSeconds: number,
      noteLabel?: string | null,
      midiNote?: number,
    ) => {
      if (playingIndex != null) return;
      const token = ++tokenRef.current;
      setPlayingIndex(index);
      try {
        await Audio.setAudioModeAsync({
          allowsRecordingIOS: false,
          playsInSilentModeIOS: true,
          staysActiveInBackground: false,
          shouldDuckAndroid: false,
        });

        const takeUri = await writeTakeClipWav(samples, sampleRate, startSeconds, endSeconds);
        try {
          await playOnce(takeUri, token);
        } finally {
          // Regenerated from `samples` on every compare() call — safe to
          // drop immediately after playback instead of leaving it in cache.
          try { new File(takeUri).delete(); } catch {}
        }
        if (token !== tokenRef.current) return;

        if (noteLabel) {
          await new Promise((r) => setTimeout(r, GAP_MS));
          if (token !== tokenRef.current) return;
          const midi = midiNote ?? noteNameToMidi(noteLabel) ?? undefined;
          const refUri = await getReferenceNoteUri(noteLabel, midi);
          await playOnce(refUri, token);
        }
      } catch (e) {
        console.error('[AttemptCompare] playback error:', e);
      } finally {
        if (token === tokenRef.current) setPlayingIndex(null);
      }
    },
    [playingIndex, playOnce],
  );

  return { playingIndex, compare };
}
