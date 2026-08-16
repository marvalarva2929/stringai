/**
 * RevenueCat wrapper.
 *
 * RevenueCat's `pro` entitlement is the client-side source of truth; the
 * RevenueCat webhook mirrors it onto profiles.entitlement, which is what the
 * server enforces. We use the Supabase user id as the RevenueCat App User ID so
 * the webhook can map an event back to a profile row.
 *
 * Every export no-ops safely when the API key is absent (Expo Go, a build
 * without EAS env wiring, Android before the Play product exists), mirroring
 * the isSupabaseConfigured pattern in services/supabase.ts. Purchases also do
 * not work in the iOS Simulator — that needs a device with a sandbox account.
 */

import { Platform } from 'react-native';
import Purchases, {
  INTRO_ELIGIBILITY_STATUS,
  LOG_LEVEL,
  type CustomerInfo,
  type PurchasesOffering,
  type PurchasesPackage,
} from 'react-native-purchases';

const apiKey = Platform.select({
  ios: process.env.EXPO_PUBLIC_REVENUECAT_API_KEY_IOS,
  android: process.env.EXPO_PUBLIC_REVENUECAT_API_KEY_ANDROID,
});

export const isPurchasesConfigured = !!apiKey;

let configured = false;

if (!isPurchasesConfigured && typeof __DEV__ !== 'undefined' && __DEV__) {
  console.warn('[purchases] EXPO_PUBLIC_REVENUECAT_API_KEY_* not set — subscriptions disabled.');
}

/** Idempotent: safe to call on every mount of the root layout. */
export function configurePurchases(): void {
  if (!isPurchasesConfigured || configured) return;
  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    Purchases.setLogLevel(LOG_LEVEL.WARN);
  }
  Purchases.configure({ apiKey: apiKey! });
  configured = true;
}

/**
 * Aliases the current (possibly anonymous) RevenueCat user onto the Supabase
 * user id. Call on sign-in and on sign-up, so a purchase made before the
 * account existed still transfers.
 */
export async function identifyPurchaser(userId: string): Promise<CustomerInfo | null> {
  if (!configured) return null;
  const { customerInfo } = await Purchases.logIn(userId);
  return customerInfo;
}

/**
 * Required by the RevenueCat → Firebase integration: without this subscriber
 * attribute, RevenueCat cannot match a customer to a GA4 user, and the
 * server-side subscription lifecycle events (renewal, cancellation, billing
 * issue, refund) never arrive. Those are the only source of churn data, since
 * they happen when the app is closed.
 */
export async function setFirebaseAppInstanceId(appInstanceId: string | null): Promise<void> {
  if (!configured || !appInstanceId) return;
  try {
    await Purchases.setFirebaseAppInstanceID(appInstanceId);
  } catch {
    // Attribute writes are best-effort; a failure only costs attribution.
  }
}

/** Returns RevenueCat to an anonymous id so the next user starts clean. */
export async function logOutPurchaser(): Promise<void> {
  if (!configured) return;
  try {
    await Purchases.logOut();
  } catch {
    // Throws when already anonymous — not an error worth surfacing.
  }
}

export async function getCurrentOffering(): Promise<PurchasesOffering | null> {
  if (!configured) return null;
  const offerings = await Purchases.getOfferings();
  return offerings.current ?? null;
}

export async function getCustomerInfo(): Promise<CustomerInfo | null> {
  if (!configured) return null;
  return Purchases.getCustomerInfo();
}

/**
 * Returns the CustomerInfo on success, or null when the user cancelled — the
 * caller should treat null as "nothing happened" and show no error.
 */
export async function purchasePackage(pkg: PurchasesPackage): Promise<CustomerInfo | null> {
  if (!configured) throw new Error('Purchases are unavailable on this build.');
  try {
    const { customerInfo } = await Purchases.purchasePackage(pkg);
    return customerInfo;
  } catch (err: unknown) {
    if ((err as { userCancelled?: boolean }).userCancelled) return null;
    throw err;
  }
}

export async function restorePurchases(): Promise<CustomerInfo | null> {
  if (!configured) throw new Error('Purchases are unavailable on this build.');
  return Purchases.restorePurchases();
}

/**
 * Which of the given products the user can actually start a free trial on.
 *
 * Apple grants one introductory offer per *subscription group*, not per
 * product, so a user who already took the monthly plan's 7-day trial is
 * ineligible for the annual plan's 14-day one. A product's `introPrice` is the
 * offer definition and is present either way — advertising a trial off that
 * alone would promise something the App Store then charges for immediately.
 *
 * iOS-only: Android always reports UNKNOWN. Anything other than a definite
 * ELIGIBLE is treated as not eligible, per RevenueCat's own guidance to show
 * non-intro pricing rather than risk a misleading claim.
 *
 * Returns the set of eligible product identifiers; empty on any failure.
 */
export async function checkTrialEligibility(productIds: string[]): Promise<Set<string>> {
  if (!configured || productIds.length === 0) return new Set();
  try {
    const result = await Purchases.checkTrialOrIntroductoryPriceEligibility(productIds);
    return new Set(
      Object.entries(result)
        .filter(([, e]) => e.status === INTRO_ELIGIBILITY_STATUS.INTRO_ELIGIBILITY_STATUS_ELIGIBLE)
        .map(([productId]) => productId),
    );
  } catch {
    return new Set();
  }
}

/**
 * Fires whenever RevenueCat's entitlement state changes — including renewals,
 * expiries and purchases made on another device. This is a push, so nothing
 * needs to poll. Returns an unsubscribe function.
 */
export function onCustomerInfoChange(listener: (info: CustomerInfo) => void): () => void {
  if (!configured) return () => {};
  Purchases.addCustomerInfoUpdateListener(listener);
  return () => Purchases.removeCustomerInfoUpdateListener(listener);
}

/** Deep-links to the platform's subscription management screen. */
export const MANAGE_SUBSCRIPTION_URL = Platform.select({
  ios: 'https://apps.apple.com/account/subscriptions',
  android: 'https://play.google.com/store/account/subscriptions',
  default: 'https://apps.apple.com/account/subscriptions',
});
