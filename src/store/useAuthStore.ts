import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { PlayerCategory } from '../types/analysis';

const GUEST_ANALYSES_KEY = 'guest_analyses_used';
const ONBOARDING_KEY = 'has_completed_onboarding';
const PLAYER_CATEGORY_KEY = 'player_category';
const WEEKLY_GOAL_KEY = 'weekly_goal_minutes';
const FREE_LIMIT = 2;

interface AuthState {
  isAuthenticated: boolean;
  userId: string | null;
  accessToken: string | null;
  hasCompletedOnboarding: boolean;
  playerCategory: PlayerCategory | null;
  weeklyGoalMinutes: number | null;
  guestAnalysesUsed: number;

  setAuthenticated: (userId: string, token: string) => void;
  setOnboardingComplete: () => void;
  setPlayerCategory: (category: PlayerCategory) => Promise<void>;
  setWeeklyGoal: (minutes: number) => Promise<void>;
  loadOnboardingStatus: () => Promise<void>;
  signOut: () => void;
  loadGuestCount: () => Promise<void>;
  incrementGuestCount: () => Promise<void>;
  canAnalyzeAsGuest: () => boolean;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  isAuthenticated: false,
  userId: null,
  accessToken: null,
  hasCompletedOnboarding: false,
  playerCategory: null,
  weeklyGoalMinutes: null,
  guestAnalysesUsed: 0,

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

  loadGuestCount: async () => {
    const stored = await AsyncStorage.getItem(GUEST_ANALYSES_KEY);
    set({ guestAnalysesUsed: stored ? parseInt(stored, 10) : 0 });
  },

  incrementGuestCount: async () => {
    const next = get().guestAnalysesUsed + 1;
    set({ guestAnalysesUsed: next });
    await AsyncStorage.setItem(GUEST_ANALYSES_KEY, String(next)).catch(() => {});
  },

  canAnalyzeAsGuest: () => get().guestAnalysesUsed < FREE_LIMIT,
}));
