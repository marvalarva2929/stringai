import { create } from 'zustand';
import { persist, createJSONStorage, StateStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AnalyticsEvent } from '../constants/analyticsEvents';
import { track } from '../services/analytics';

// Wraps AsyncStorage so full-device errors are swallowed rather than crashing.
const safeStorage: StateStorage = {
  getItem: (name) => AsyncStorage.getItem(name).catch(() => null),
  setItem: (name, value) => AsyncStorage.setItem(name, value).catch(() => {}),
  removeItem: (name) => AsyncStorage.removeItem(name).catch(() => {}),
};

/**
 * First-run activation: the path from "finished onboarding" to "has seen their
 * own playing analysed and drilled one exercise".
 *
 * Activation is an overlay layer riding on the real screens — home, analyze, the
 * results carousel, the practice plan — rather than a set of screens of its own.
 * A tour that describes the app teaches nothing; pointing at the actual buttons,
 * in the order a player would use them, does. This store is the only thing that
 * knows which stage the user is in; each screen reads `step` and decides whether
 * to show its coachmarks.
 *
 * `dismissed` and `done` are both terminal. Nothing ever re-enters the flow.
 */
export type ActivationStep =
  | 'not_started'
  | 'home'       // walking the home screen: warm-up, streak/score, record
  | 'capture'    // recording their own diagnostic take (or loading the sample)
  | 'carousel'   // walking the results carousel with coachmarks
  | 'practice'   // walking the guided practice plan
  | 'done'
  | 'dismissed';

/** Steps the user actively moves through — the funnel we measure. */
export const ACTIVATION_FUNNEL: ActivationStep[] = [
  'home', 'capture', 'carousel', 'practice', 'done',
];

export const isActivationActive = (step: ActivationStep): boolean =>
  step !== 'not_started' && step !== 'done' && step !== 'dismissed';

interface ActivationState {
  step: ActivationStep;
  /** True when the user took the sample-analysis path instead of recording. */
  usedDemo: boolean;
  /** ISO timestamp per step reached. The whole local funnel — see app/debug.tsx. */
  stepTimestamps: Partial<Record<ActivationStep, string>>;
  startedAt: string | null;
  completedAt: string | null;

  begin: () => void;
  advanceTo: (step: ActivationStep) => void;
  markDemo: () => void;
  dismiss: () => void;
  complete: () => void;
  resetActivation: () => void;
}

const initial = {
  step: 'not_started' as ActivationStep,
  usedDemo: false,
  stepTimestamps: {} as Partial<Record<ActivationStep, string>>,
  startedAt: null,
  completedAt: null,
};

const msSince = (iso: string | null | undefined): number | undefined =>
  iso ? Date.now() - new Date(iso).getTime() : undefined;

export const useActivationStore = create<ActivationState>()(
  persist(
    (set, get) => ({
      ...initial,

      begin: () => {
        const now = new Date().toISOString();
        set({ step: 'home', startedAt: now, stepTimestamps: { home: now } });
        track(AnalyticsEvent.ACTIVATION_START);
      },

      // The single funnel write. Stamping here rather than at each call site is
      // what makes the local instrumentation free — no step can be reached
      // without being recorded. The analytics event rides along for the same
      // reason: all ten transition call sites are covered by this one emit.
      advanceTo: (step) => {
        const { step: current, stepTimestamps, startedAt, usedDemo } = get();
        if (current === step) return;
        set({
          step,
          stepTimestamps: { ...stepTimestamps, [step]: new Date().toISOString() },
        });
        track(AnalyticsEvent.ACTIVATION_STEP, {
          step,
          prev_step: current,
          ms_since_start: msSince(startedAt),
          ms_since_prev: msSince(stepTimestamps[current]),
          used_demo: usedDemo,
        });
      },

      markDemo: () => set({ usedDemo: true }),

      dismiss: () => {
        const { stepTimestamps, step, startedAt } = get();
        set({
          step: 'dismissed',
          stepTimestamps: { ...stepTimestamps, dismissed: new Date().toISOString() },
        });
        // `step` here is where they bailed — the whole point of the event.
        track(AnalyticsEvent.ACTIVATION_DISMISSED, {
          step,
          ms_since_start: msSince(startedAt),
        });
      },

      complete: () => {
        const { stepTimestamps, startedAt, usedDemo } = get();
        const now = new Date().toISOString();
        set({
          step: 'done',
          completedAt: now,
          stepTimestamps: { ...stepTimestamps, done: now },
        });
        track(AnalyticsEvent.ACTIVATION_COMPLETE, {
          ms_total: msSince(startedAt),
          used_demo: usedDemo,
        });
      },

      resetActivation: () => set({ ...initial }),
    }),
    {
      name: 'stringai-activation-v1',
      storage: createJSONStorage(() => safeStorage),
      version: 2,
      // v1 had a 'review' stage between 'practice' and 'done', where the
      // "Enjoying StringAI?" prompt fired. The prompt moved to just after the
      // trial starts, so the stage is gone. Anyone persisted mid-'review' would
      // otherwise sit on a step that isActivationActive() calls active and
      // nothing ever advances — activation would never end, so SubscribeGate
      // would never fire and they'd be stuck outside the app permanently.
      migrate: (persisted, version) => {
        const state = persisted as Partial<ActivationState> | undefined;
        if (state && version < 2 && (state.step as string) === 'review') {
          return { ...state, step: 'done' as ActivationStep };
        }
        return state;
      },
    }
  )
);
