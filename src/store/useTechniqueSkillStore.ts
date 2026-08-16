import { create } from 'zustand';
import { persist, createJSONStorage, StateStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

// ─────────────────────────────────────────────────────────────
// What the player has actually been taught.
//
// Separate from `skillLevel`, which is a self-assessment ("intermediate") and
// says nothing about whether anyone has shown them how to shift. A player can
// be two years in, have a lovely first-position tone, and have never left it.
//
// This exists because a drill that asks for 3rd position from someone who has
// never been taught it is worse than useless: they will invent a fingering,
// practise it, and get better at the wrong thing. So the app asks once, and
// until it has an answer it keeps its exercises in first position.
//
// Local-only. `unknown` is the honest default — not "no".
// ─────────────────────────────────────────────────────────────

const safeStorage: StateStorage = {
  getItem: (name) => AsyncStorage.getItem(name).catch(() => null),
  setItem: (name, value) => AsyncStorage.setItem(name, value).catch(() => {}),
  removeItem: (name) => AsyncStorage.removeItem(name).catch(() => {}),
};

export type SkillAnswer = 'unknown' | 'yes' | 'no';

interface TechniqueSkillState {
  /** Has the player been taught to shift into 3rd position? */
  thirdPosition: SkillAnswer;
  setThirdPosition: (answer: Exclude<SkillAnswer, 'unknown'>) => void;
  reset: () => void;
}

export const useTechniqueSkillStore = create<TechniqueSkillState>()(
  persist(
    (set) => ({
      thirdPosition: 'unknown',
      setThirdPosition: (answer) => set({ thirdPosition: answer }),
      reset: () => set({ thirdPosition: 'unknown' }),
    }),
    {
      name: 'stringai-technique-skill-v1',
      storage: createJSONStorage(() => safeStorage),
    },
  ),
);

/**
 * Whether exercises may leave first position.
 *
 * Deliberately false while the answer is `unknown`: assuming a student can
 * shift and being wrong teaches them a bad habit, whereas assuming they can't
 * and being wrong just gives them an easy exercise and a question to answer.
 */
export function mayShift(answer: SkillAnswer): boolean {
  return answer === 'yes';
}
