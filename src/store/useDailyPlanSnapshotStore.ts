import { create } from 'zustand';
import { persist, createJSONStorage, StateStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { PracticePlan } from '../lib/practicePlan';

// Wraps AsyncStorage so full-device errors are swallowed rather than crashing.
const safeStorage: StateStorage = {
  getItem: (name) => AsyncStorage.getItem(name).catch(() => null),
  setItem: (name, value) => AsyncStorage.setItem(name, value).catch(() => {}),
  removeItem: (name) => AsyncStorage.removeItem(name).catch(() => {}),
};

interface DailyPlanSnapshotState {
  /** Calendar date (YYYY-MM-DD) the current snapshot was frozen for. */
  snapshotDate: string | null;
  /** The daily plan as first computed that day. Recording and analyzing a new
   *  session later the same day must NOT change this — new evidence only
   *  feeds into the next day's snapshot (see useDailyPracticePlan.ts). */
  snapshot: PracticePlan | null;
  /** True once AsyncStorage has finished rehydrating this store. Gates writes
   *  so a cold-boot render (before the persisted snapshot has loaded) can't
   *  stamp a fresh computation over today's real snapshot. */
  hasHydrated: boolean;
  setSnapshot: (date: string, plan: PracticePlan) => void;
  setHasHydrated: (hydrated: boolean) => void;
}

export const useDailyPlanSnapshotStore = create<DailyPlanSnapshotState>()(
  persist(
    (set) => ({
      snapshotDate: null,
      snapshot: null,
      hasHydrated: false,
      setSnapshot: (date, plan) => set({ snapshotDate: date, snapshot: plan }),
      setHasHydrated: (hydrated) => set({ hasHydrated: hydrated }),
    }),
    {
      name: 'stringai-daily-plan-snapshot-v1',
      storage: createJSONStorage(() => safeStorage),
      version: 1,
      onRehydrateStorage: () => (state) => {
        state?.setHasHydrated(true);
      },
    },
  ),
);
