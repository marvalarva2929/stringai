import { useState, useRef, useEffect, useCallback } from 'react';
import { Audio } from 'expo-av';
import { getReferenceNoteUri } from '../lib/referenceNote';

/** Plays a single reference pitch on demand; toggling the same note stops it. */
export function useTuneNote() {
  const [playingNote, setPlayingNote] = useState<string | null>(null);
  const playingRef = useRef<string | null>(null);
  const soundRef = useRef<Audio.Sound | null>(null);

  useEffect(() => {
    return () => { soundRef.current?.unloadAsync().catch(() => {}); };
  }, []);

  const stopAll = useCallback(async () => {
    const sound = soundRef.current;
    soundRef.current = null;
    playingRef.current = null;
    setPlayingNote(null);
    if (sound) {
      await sound.stopAsync().catch(() => {});
      await sound.unloadAsync().catch(() => {});
    }
  }, []);

  const toggle = useCallback(async (pitchClass: string, midi?: number) => {
    const prev = playingRef.current;
    const prevSound = soundRef.current;
    soundRef.current = null;
    playingRef.current = null;
    setPlayingNote(null);

    if (prevSound) {
      await prevSound.stopAsync().catch(() => {});
      await prevSound.unloadAsync().catch(() => {});
    }

    if (prev === pitchClass) return;

    playingRef.current = pitchClass;
    setPlayingNote(pitchClass);
    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
        shouldDuckAndroid: false,
      });
      const uri = await getReferenceNoteUri(pitchClass, midi);
      const { sound } = await Audio.Sound.createAsync({ uri }, { shouldPlay: true, volume: 1.0 });
      soundRef.current = sound;
      sound.setOnPlaybackStatusUpdate((st) => {
        if (st.isLoaded && st.didJustFinish) {
          if (playingRef.current === pitchClass) {
            playingRef.current = null;
            setPlayingNote(null);
          }
          sound.unloadAsync().catch(() => {});
          if (soundRef.current === sound) soundRef.current = null;
        }
      });
    } catch (e) {
      console.error('[TuneNote] playback error:', e);
      playingRef.current = null;
      setPlayingNote(null);
    }
  }, []);

  return { playingNote, toggle, stopAll };
}
