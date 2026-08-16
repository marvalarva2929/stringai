import { create } from 'zustand';
import { persist, createJSONStorage, StateStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { CustomerInfo } from 'react-native-purchases';
import { entitlementFromCustomerInfo, freeEntitlement, type Entitlement } from '../lib/entitlements';
import { DEBUG_FORCE_PRO } from '../constants/featureFlags';

// Debug override, applied wherever entitlement state enters the store so every
// consumer sees Pro without touching the pure rules in lib/entitlements. This
// is what bypasses the subscribe gate in a dev build. The forced tier does get
// persisted — after flipping the flag off, sign out (or wait for the next
// RevenueCat push) to restore the real tier.
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
  /** Back to a clean unsubscribed row — call on sign-out. */
  resetEntitlement: () => void;
}

export const useEntitlementStore = create<EntitlementState>()(
  persist(
    (set) => ({
      entitlement: withDebugPro(freeEntitlement()),

      applyCustomerInfo: (info) =>
        set({ entitlement: withDebugPro(entitlementFromCustomerInfo(info)) }),

      resetEntitlement: () => set({ entitlement: withDebugPro(freeEntitlement()) }),
    }),
    {
      // v2: v1 rows carried the retired daily-analysis counter.
      name: 'stringai-entitlement-v2',
      storage: createJSONStorage(() => safeStorage),
      // Persisting the entitlement lets the app open offline with the
      // last-known tier. RevenueCat corrects it on the first customer-info push.
      partialize: (state) => ({ entitlement: state.entitlement }),
      merge: (persisted, current) => {
        const p = persisted as { entitlement?: Entitlement } | undefined;
        return { ...current, entitlement: withDebugPro(p?.entitlement ?? current.entitlement) };
      },
    },
  ),
);
