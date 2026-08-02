import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { StateStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { BowCalibration } from '../types/calibration';

// Same swallow-on-failure wrapper as the other persisted stores: a full
// device must not crash the app at launch.
const safeStorage: StateStorage = {
  getItem: (name) => AsyncStorage.getItem(name).catch(() => null),
  setItem: (name, value) => AsyncStorage.setItem(name, value).catch(() => {}),
  removeItem: (name) => AsyncStorage.removeItem(name).catch(() => {}),
};

interface CalibrationState {
  calibration: BowCalibration | null;
  setCalibration: (calibration: BowCalibration) => void;
  clearCalibration: () => void;
}

export const useCalibrationStore = create<CalibrationState>()(
  persist(
    (set) => ({
      calibration: null,
      setCalibration: (calibration) => set({ calibration }),
      clearCalibration: () => set({ calibration: null }),
    }),
    {
      name: 'stringai-calibration-v1',
      storage: createJSONStorage(() => safeStorage),
    },
  ),
);
