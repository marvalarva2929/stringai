import { create } from 'zustand';
import { persist, createJSONStorage, StateStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { CustomerInfo } from 'react-native-purchases';
import { supabase, isSupabaseConfigured } from '../services/supabase';
import {
  canAnalyze,
  consumeAnalysis,
  entitlementFromCustomerInfo,
  freeEntitlement,
  localDateKey,
  type Entitlement,
} from '../lib/entitlements';
import { DEBUG_FORCE_PRO } from '../constants/featureFlags';

// Debug override, applied wherever entitlement state enters the store so every
// consumer sees Pro without touching the pure rules in lib/entitlements. The
// forced tier does get persisted — after flipping the flag off, sign out (or
// wait for the next RevenueCat push) to restore the real tier.
const withDebugPro = (e: Entitlement): Entitlement =>
  DEBUG_FORCE_PRO ? { ...e, tier: 'pro' } : e;

// Same swallow-on-failure wrapper as useAnalysisStore: a full device must not
// crash the app at launch.
const safeStorage: StateStorage = {
  getItem: (name) => AsyncStorage.getItem(name).catch(() => null),
  setItem: (name, value) => AsyncStorage.setItem(name, value).catch(() => {}),
  removeItem: (name) => AsyncStorage.removeItem(name).catch(() => {}),
};

interface EntitlementState {
  entitlement: Entitlement;

  /** Push from RevenueCat's customer-info listener. */
  applyCustomerInfo: (info: CustomerInfo) => void;
  /** Pull today's server-side count so the UI matches what the server will allow. */
  syncUsageFromServer: () => Promise<void>;
  /**
   * Records one analysis. Signed-in users go through the consume_analysis RPC,
   * which is the only writer and the only authority; guests are metered
   * locally. Returns false when the daily cap is already spent.
   */
  tryConsumeAnalysis: (isAuthenticated: boolean) => Promise<boolean>;
  /** Back to a clean free row — call on sign-out. */
  resetEntitlement: () => void;
}

export const useEntitlementStore = create<EntitlementState>()(
  persist(
    (set, get) => ({
      entitlement: withDebugPro(freeEntitlement()),

      applyCustomerInfo: (info) =>
        set((state) => ({ entitlement: withDebugPro(entitlementFromCustomerInfo(info, state.entitlement)) })),

      syncUsageFromServer: async () => {
        if (!isSupabaseConfigured) return;
        const { data, error } = await supabase.rpc('get_analyses_used_today');
        if (error || typeof data !== 'number') return;
        set((state) => ({
          entitlement: {
            ...state.entitlement,
            analysesUsedToday: data,
            analysesCountDate: localDateKey(),
          },
        }));
      },

      tryConsumeAnalysis: async (isAuthenticated) => {
        const current = get().entitlement;
        const today = localDateKey();

        if (isAuthenticated && isSupabaseConfigured) {
          const { data, error } = await supabase.rpc('consume_analysis');
          if (error) {
            // Offline, or the RPC is unavailable. Fall back to the local counter
            // rather than locking a user out of an app that works offline. The
            // server reconciles on the next successful call, so the only
            // exposure is a few extra analyses while genuinely offline.
            if (!canAnalyze(current, today)) return false;
            set({ entitlement: consumeAnalysis(current, today) });
            return true;
          }
          if (data === false) return false;
          // Mirror the server's increment locally so the UI updates instantly.
          set({ entitlement: consumeAnalysis(current, today) });
          return true;
        }

        // Guest: local only. A reinstall resets the count, which is acceptable —
        // the trial requires an account, so the ceiling on abuse is one free
        // day's worth of uploads per reinstall.
        if (!canAnalyze(current, today)) return false;
        set({ entitlement: consumeAnalysis(current, today) });
        return true;
      },

      resetEntitlement: () => set({ entitlement: withDebugPro(freeEntitlement()) }),
    }),
    {
      name: 'stringai-entitlement-v1',
      storage: createJSONStorage(() => safeStorage),
      // Persisting the whole entitlement lets the app open offline with the
      // last-known tier. RevenueCat corrects it on the first customer-info push.
      partialize: (state) => ({ entitlement: state.entitlement }),
      merge: (persisted, current) => {
        const p = persisted as { entitlement?: Entitlement } | undefined;
        return { ...current, entitlement: withDebugPro(p?.entitlement ?? current.entitlement) };
      },
    },
  ),
);
