import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { PlayerCategory } from '../types/analysis';

// Analysis quotas live in useEntitlementStore / src/lib/entitlements.ts — this
// store is only session and onboarding state.
const ONBOARDING_KEY = 'has_completed_onboarding';
const PLAYER_CATEGORY_KEY = 'player_category';
const WEEKLY_GOAL_KEY = 'weekly_goal_minutes';

interface AuthState {
  isAuthenticated: boolean;
  userId: string | null;
  accessToken: string | null;
  hasCompletedOnboarding: boolean;
  playerCategory: PlayerCategory | null;
  weeklyGoalMinutes: number | null;

  setAuthenticated: (userId: string, token: string) => void;
  setOnboardingComplete: () => void;
  setPlayerCategory: (category: PlayerCategory) => Promise<void>;
  setWeeklyGoal: (minutes: number) => Promise<void>;
  loadOnboardingStatus: () => Promise<void>;
  signOut: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  isAuthenticated: false,
  userId: null,
  accessToken: null,
  hasCompletedOnboarding: false,
  playerCategory: null,
  weeklyGoalMinutes: null,

  setAuthenticated: (userId, token) =>
    set({ isAuthenticated: true, userId, accessToken: token }),

  setOnboardingComplete: () => {
    set({ hasCompletedOnboarding: true });
    AsyncStorage.setItem(ONBOARDING_KEY, 'true').catch(() => {});
  },

  setPlayerCategory: async (category) => {
    set({ playerCategory: category });
    await AsyncStorage.setItem(PLAYER_CATEGORY_KEY, category).catch(() => {});
  },

  setWeeklyGoal: async (minutes) => {
    set({ weeklyGoalMinutes: minutes });
    await AsyncStorage.setItem(WEEKLY_GOAL_KEY, String(minutes)).catch(() => {});
  },

  loadOnboardingStatus: async () => {
    const [onboarding, category, weeklyGoal] = await Promise.all([
      AsyncStorage.getItem(ONBOARDING_KEY),
      AsyncStorage.getItem(PLAYER_CATEGORY_KEY),
      AsyncStorage.getItem(WEEKLY_GOAL_KEY),
    ]);
    set({
      hasCompletedOnboarding: onboarding === 'true',
      playerCategory: (category as PlayerCategory | null) ?? null,
      weeklyGoalMinutes: weeklyGoal ? parseInt(weeklyGoal, 10) : null,
    });
  },

  signOut: () =>
    set({ isAuthenticated: false, userId: null, accessToken: null }),
}));
