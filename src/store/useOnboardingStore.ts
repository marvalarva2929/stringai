import { create } from 'zustand';
import { persist, createJSONStorage, StateStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Answers collected during the onboarding revamp that don't have a home in
// useAuthStore (playerCategory/weeklyGoalMinutes) or the Supabase `profiles`
// table (skill_level). Local-only — nothing here syncs server-side today.
// Pre-existing users who onboarded before this store existed simply keep the
// defaults below; nothing reads these fields as required.

const safeStorage: StateStorage = {
  getItem: (name) => AsyncStorage.getItem(name).catch(() => null),
  setItem: (name, value) => AsyncStorage.setItem(name, value).catch(() => {}),
  removeItem: (name) => AsyncStorage.removeItem(name).catch(() => {}),
};

export type Handedness = 'right' | 'left';
export type FocusPreference = 'tone' | 'speed' | 'balanced';

interface OnboardingAnswersState {
  learningGoals: string[];
  dailyTimeId: string | null;
  experienceId: string | null;
  handedness: Handedness;
  focusPreference: FocusPreference;
  violinSize: string | null;
  accessories: string[];

  toggleLearningGoal: (id: string) => void;
  setDailyTimeId: (id: string) => void;
  setExperienceId: (id: string) => void;
  setHandedness: (h: Handedness) => void;
  setFocusPreference: (f: FocusPreference) => void;
  setViolinSize: (id: string) => void;
  toggleAccessory: (id: string) => void;
}

export const useOnboardingStore = create<OnboardingAnswersState>()(
  persist(
    (set) => ({
      learningGoals: [],
      dailyTimeId: null,
      experienceId: null,
      handedness: 'right',
      focusPreference: 'balanced',
      violinSize: null,
      accessories: [],

      toggleLearningGoal: (id) =>
        set((state) => ({
          learningGoals: state.learningGoals.includes(id)
            ? state.learningGoals.filter((g) => g !== id)
            : [...state.learningGoals, id],
        })),

      setDailyTimeId: (id) => set({ dailyTimeId: id }),
      setExperienceId: (id) => set({ experienceId: id }),
      setHandedness: (h) => set({ handedness: h }),
      setFocusPreference: (f) => set({ focusPreference: f }),
      setViolinSize: (id) => set({ violinSize: id }),

      toggleAccessory: (id) =>
        set((state) => ({
          accessories: state.accessories.includes(id)
            ? state.accessories.filter((a) => a !== id)
            : [...state.accessories, id],
        })),
    }),
    {
      name: 'stringai-onboarding-answers-v1',
      storage: createJSONStorage(() => safeStorage),
      version: 1,
    }
  )
);
