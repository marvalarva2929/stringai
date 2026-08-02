import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { StateStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Same swallow-on-failure wrapper as the other persisted stores: a full
// device must not crash the app at launch.
const safeStorage: StateStorage = {
  getItem: (name) => AsyncStorage.getItem(name).catch(() => null),
  setItem: (name, value) => AsyncStorage.setItem(name, value).catch(() => {}),
  removeItem: (name) => AsyncStorage.removeItem(name).catch(() => {}),
};

export const MIN_BPM = 40;
export const MAX_BPM = 208;
// The steppers nudge by a single beat; the slider covers the whole range for
// coarse moves. Fine control was the point — musicians pick exact tempos.
export const BPM_STEP = 1;

export function clampBpm(bpm: number): number {
  return Math.max(MIN_BPM, Math.min(MAX_BPM, Math.round(bpm)));
}

interface MetronomeState {
  /** Run a metronome during the next recording. */
  enabled: boolean;
  bpm: number;
  /** Audible click. When false the metronome is visual-only — which is also the
   *  cleanest option for analysis, since the click is picked up by the mic. */
  sound: boolean;
  setEnabled: (enabled: boolean) => void;
  setBpm: (bpm: number) => void;
  setSound: (sound: boolean) => void;
}

export const useMetronomeStore = create<MetronomeState>()(
  persist(
    (set) => ({
      enabled: false,
      bpm: 80,
      sound: true,
      setEnabled: (enabled) => set({ enabled }),
      setBpm: (bpm) => set({ bpm: clampBpm(bpm) }),
      setSound: (sound) => set({ sound }),
    }),
    {
      name: 'stringai-metronome-v1',
      storage: createJSONStorage(() => safeStorage),
    },
  ),
);
