import { create } from 'zustand';
import { persist, createJSONStorage, StateStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  ReviewState,
  ReviewOutcome,
  initialReviewState,
  recordPrompted,
} from '../lib/reviewPrompt';

// Wraps AsyncStorage so full-device errors are swallowed rather than crashing.
const safeStorage: StateStorage = {
  getItem: (name) => AsyncStorage.getItem(name).catch(() => null),
  setItem: (name, value) => AsyncStorage.setItem(name, value).catch(() => {}),
  removeItem: (name) => AsyncStorage.removeItem(name).catch(() => {}),
};

/**
 * The persisted half of the review pipeline. All the *rules* live in
 * src/lib/reviewPrompt.ts (pure, unit-tested); this only holds the record of
 * what we've asked and what the user said.
 */
interface ReviewStoreState extends ReviewState {
  /**
   * Set the moment a trial starts, cleared once the prompt has been offered.
   *
   * The ask can't fire at the purchase itself: AccountStep is presented
   * straight after, and two modals stacked on the highest-intent moment of the
   * funnel loses both. So the purchase raises this flag and whichever screen
   * the user first lands on consumes it. Persisted because that landing can be
   * a separate app launch — email-confirmation signup sends them out to a mail
   * client in between.
   */
  pendingSubscribedReview: boolean;
  markPrompted: (now?: Date) => void;
  setOutcome: (outcome: ReviewOutcome) => void;
  /** Raised by the paywall on a successful purchase. */
  flagSubscribed: () => void;
  /** Consumes the flag, returning whether it was set. Safe to call on mount. */
  takeSubscribedReviewFlag: () => boolean;
  resetReview: () => void;
}

export const useReviewStore = create<ReviewStoreState>()(
  persist(
    (set, get) => ({
      ...initialReviewState(),
      pendingSubscribedReview: false,

      markPrompted: (now = new Date()) => {
        const { promptCount, lastPromptedAt, outcome } = get();
        set(recordPrompted({ promptCount, lastPromptedAt, outcome }, now));
      },

      setOutcome: (outcome) => set({ outcome }),

      flagSubscribed: () => set({ pendingSubscribedReview: true }),

      takeSubscribedReviewFlag: () => {
        if (!get().pendingSubscribedReview) return false;
        set({ pendingSubscribedReview: false });
        return true;
      },

      resetReview: () => set({ ...initialReviewState(), pendingSubscribedReview: false }),
    }),
    {
      name: 'stringai-review-v1',
      storage: createJSONStorage(() => safeStorage),
      version: 1,
      partialize: (state) => ({
        promptCount: state.promptCount,
        lastPromptedAt: state.lastPromptedAt,
        outcome: state.outcome,
        pendingSubscribedReview: state.pendingSubscribedReview,
      }),
    }
  )
);
