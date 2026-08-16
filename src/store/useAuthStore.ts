import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { PlayerCategory } from '../types/analysis';

// Analysis quotas live in useEntitlementStore / src/lib/entitlements.ts — this
// store is only session and onboarding state.
const ONBOARDING_KEY = 'has_completed_onboarding';
const PLAYER_CATEGORY_KEY = 'player_category';
const WEEKLY_GOAL_KEY = 'weekly_goal_minutes';
const ACCOUNT_DEFERRED_KEY = 'account_deferred';

interface AuthState {
  isAuthenticated: boolean;
  userId: string | null;
  accessToken: string | null;
  hasCompletedOnboarding: boolean;
  playerCategory: PlayerCategory | null;
  weeklyGoalMinutes: number | null;
  /**
   * Suppresses the mandatory account wall for this install.
   *
   * Set on the two paths where insisting would trap someone rather than help:
   * signup that needs email confirmation (they've paid, the mail hasn't
   * arrived, and no amount of retrying produces a session), and a deliberate
   * sign-out. The wall has no skip button precisely because this exists — the
   * flag is the escape hatch, not a button the user can fumble into. Settings'
   * sign-in card is the way back from either. Same reasoning as SubscribeGate's
   * refusal to condition on being signed in.
   */
  accountDeferred: boolean;

  setAuthenticated: (userId: string, token: string) => void;
  setOnboardingComplete: () => void;
  setPlayerCategory: (category: PlayerCategory) => Promise<void>;
  setWeeklyGoal: (minutes: number) => Promise<void>;
  deferAccount: () => void;
  /**
   * A fresh purchase is a new reason to ask, even for someone who deferred
   * once before (e.g. after signing out). Without this, one old deferral —
   * from a completely unrelated purchase, possibly days earlier — would
   * silently suppress AccountGate forever, and every purchase after it would
   * stay invisible server-side with no prompt telling the user why.
   */
  clearAccountDeferred: () => void;
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
  accountDeferred: false,

  setAuthenticated: (userId, token) =>
    // A real session supersedes the deferral — clearing it here means a user
    // who confirms their email and signs in from Settings stops being treated
    // as account-less on the next launch.
    set({ isAuthenticated: true, userId, accessToken: token, accountDeferred: false }),

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

  deferAccount: () => {
    set({ accountDeferred: true });
    AsyncStorage.setItem(ACCOUNT_DEFERRED_KEY, 'true').catch(() => {});
  },

  clearAccountDeferred: () => {
    set({ accountDeferred: false });
    AsyncStorage.setItem(ACCOUNT_DEFERRED_KEY, 'false').catch(() => {});
  },

  loadOnboardingStatus: async () => {
    const [onboarding, category, weeklyGoal, deferred] = await Promise.all([
      AsyncStorage.getItem(ONBOARDING_KEY),
      AsyncStorage.getItem(PLAYER_CATEGORY_KEY),
      AsyncStorage.getItem(WEEKLY_GOAL_KEY),
      AsyncStorage.getItem(ACCOUNT_DEFERRED_KEY),
    ]);
    set({
      hasCompletedOnboarding: onboarding === 'true',
      playerCategory: (category as PlayerCategory | null) ?? null,
      weeklyGoalMinutes: weeklyGoal ? parseInt(weeklyGoal, 10) : null,
      accountDeferred: deferred === 'true',
    });
  },

  // Also defers the account wall. Without this, signing out as a subscriber
  // would immediately raise AccountGate over the login screen the Settings
  // button just sent them to — the sign-out would look like it did nothing.
  // The Settings sign-in card is the way back in from here.
  signOut: () => {
    set({ isAuthenticated: false, userId: null, accessToken: null, accountDeferred: true });
    AsyncStorage.setItem(ACCOUNT_DEFERRED_KEY, 'true').catch(() => {});
  },
}));
