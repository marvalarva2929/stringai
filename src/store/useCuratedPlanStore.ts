import { create } from 'zustand';
import { persist, createJSONStorage, StateStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { CuratedBlockSpec } from '../lib/practiceCuration';

// Wraps AsyncStorage so full-device errors are swallowed rather than crashing.
const safeStorage: StateStorage = {
  getItem: (name) => AsyncStorage.getItem(name).catch(() => null),
  setItem: (name, value) => AsyncStorage.setItem(name, value).catch(() => {}),
  removeItem: (name) => AsyncStorage.removeItem(name).catch(() => {}),
};

interface CuratedPlanState {
  /**
   * Grounded LLM copy for a plan's blocks, keyed by planId (e.g.
   * `session:<sessionId>`). Written once when the Claude coaching response
   * for that session lands (Phase 3.5: never regenerated on render), read by
   * usePracticePlan to overlay `reason` text on the matching deterministic
   * blocks. Absent for a planId = deterministic-only, same as today.
   */
  curatedBlocksByPlan: Record<string, CuratedBlockSpec[]>;

  setCuratedBlocks: (planId: string, blocks: CuratedBlockSpec[]) => void;
  reset: () => void;
}

export const useCuratedPlanStore = create<CuratedPlanState>()(
  persist(
    (set) => ({
      curatedBlocksByPlan: {},

      setCuratedBlocks: (planId, blocks) =>
        set((state) => ({
          curatedBlocksByPlan: { ...state.curatedBlocksByPlan, [planId]: blocks },
        })),

      reset: () => set({ curatedBlocksByPlan: {} }),
    }),
    {
      name: 'stringai-curated-plan-v1',
      storage: createJSONStorage(() => safeStorage),
      version: 1,
    }
  )
);
