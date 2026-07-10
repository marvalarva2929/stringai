import { create } from 'zustand';
import { persist, createJSONStorage, StateStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { markComplete } from '../lib/practiceProgress';

// Pure progress helpers live in ../lib/practiceProgress (Node-testable);
// re-exported here so screens can import store + helpers from one place.
export { completedBlockIdsFor, nextIncompleteBlock } from '../lib/practiceProgress';

// Wraps AsyncStorage so full-device errors are swallowed rather than crashing.
const safeStorage: StateStorage = {
  getItem: (name) => AsyncStorage.getItem(name).catch(() => null),
  setItem: (name, value) => AsyncStorage.setItem(name, value).catch(() => {}),
  removeItem: (name) => AsyncStorage.removeItem(name).catch(() => {}),
};

interface PracticeProgressState {
  /** Completed block ids per plan id. Plans of different scopes (daily, session,
   *  piece warmup) coexist here — see `markComplete` for pruning. */
  completedByPlan: Record<string, string[]>;

  /** Mark a block done for a plan, leaving other plans' progress intact. */
  markBlockComplete: (planId: string, blockId: string) => void;
  /** Clear progress for one plan (e.g. "Restart today"). */
  resetPlan: (planId: string) => void;
  /** Clear all progress across every plan. */
  reset: () => void;
}

/** Shape of the v1 persisted state, kept only for migration. */
interface PersistedV1 {
  planId?: string | null;
  completedBlockIds?: string[];
}

export const usePracticeProgressStore = create<PracticeProgressState>()(
  persist(
    (set) => ({
      completedByPlan: {},

      markBlockComplete: (planId, blockId) =>
        set((state) => ({ completedByPlan: markComplete(state.completedByPlan, planId, blockId) })),

      resetPlan: (planId) =>
        set((state) => {
          const next = { ...state.completedByPlan };
          delete next[planId];
          return { completedByPlan: next };
        }),

      reset: () => set({ completedByPlan: {} }),
    }),
    {
      name: 'stringai-practice-progress-v1',
      storage: createJSONStorage(() => safeStorage),
      version: 2,
      // v1 held a single { planId, completedBlockIds }; carry it across so the
      // user does not lose the plan they were partway through.
      migrate: (persisted, fromVersion) => {
        if (fromVersion >= 2) return persisted as PracticeProgressState;
        const old = (persisted ?? {}) as PersistedV1;
        const completedByPlan: Record<string, string[]> = {};
        if (old.planId && old.completedBlockIds?.length) {
          completedByPlan[old.planId] = old.completedBlockIds;
        }
        return { completedByPlan } as PracticeProgressState;
      },
    }
  )
);
