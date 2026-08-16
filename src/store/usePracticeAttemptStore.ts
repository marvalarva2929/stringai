import { create } from 'zustand';
import { persist, createJSONStorage, StateStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { recordAttempt, type PracticeAttempt } from '../lib/practiceAttempts';

// Pure helpers live in ../lib/practiceAttempts (Node-testable); re-exported here
// so screens can import store + helpers from one place, matching the pattern in
// usePracticeProgressStore.
export {
  attemptsForIssue,
  attemptsForPiece,
  tallyAttempts,
  scoreHistoryFor,
  type PracticeAttempt,
  type ScoreHistory,
} from '../lib/practiceAttempts';

// Wraps AsyncStorage so full-device errors are swallowed rather than crashing.
const safeStorage: StateStorage = {
  getItem: (name) => AsyncStorage.getItem(name).catch(() => null),
  setItem: (name, value) => AsyncStorage.setItem(name, value).catch(() => {}),
  removeItem: (name) => AsyncStorage.removeItem(name).catch(() => {}),
};

interface PracticeAttemptState {
  /** Newest-first. Append-only; a retake is a second attempt, not an overwrite. */
  attempts: PracticeAttempt[];
  addAttempt: (attempt: PracticeAttempt) => void;
  reset: () => void;
}

export const usePracticeAttemptStore = create<PracticeAttemptState>()(
  persist(
    (set) => ({
      attempts: [],
      addAttempt: (attempt) =>
        set((state) => ({ attempts: recordAttempt(state.attempts, attempt) })),
      reset: () => set({ attempts: [] }),
    }),
    {
      name: 'stringai-practice-attempts-v1',
      storage: createJSONStorage(() => safeStorage),
    },
  ),
);
