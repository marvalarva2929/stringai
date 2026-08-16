/**
 * Firebase Analytics (GA4) wrapper.
 *
 * Every export no-ops safely when Firebase is unavailable — no
 * GoogleService-Info.plist in the bundle, a build without the native module, or
 * a JS-only test run — mirroring the isSupabaseConfigured / isPurchasesConfigured
 * pattern in services/supabase.ts and services/purchases.ts. Analytics must
 * never be the reason a screen fails to render, so nothing here throws and
 * nothing here is awaited by a caller in the UI path.
 *
 * Uses the modular API (`logEvent(getAnalytics(), ...)`). The namespaced
 * `analytics().logEvent(...)` form is deprecated in v23 and removed in v26.
 */

import {
  getAnalytics,
  getAppInstanceId,
  logBeginCheckout,
  logEvent as fbLogEvent,
  logLogin,
  logPurchase,
  logScreenView,
  logSignUp,
  setAnalyticsCollectionEnabled,
  setConsent,
  setUserId,
  setUserProperties,
} from '@react-native-firebase/analytics';
import { getApps } from '@react-native-firebase/app';

import type { CustomAnalyticsEventName, PaywallSource, SubscriptionPlan } from '../constants/analyticsEvents';
import { sanitizeParams, type AnalyticsParams } from '../lib/analyticsUserProps';

const isDev = typeof __DEV__ !== 'undefined' && __DEV__;

/**
 * False until a default Firebase app exists. `getApps()` throws rather than
 * returning [] when the native module is absent entirely, so the probe is
 * wrapped — this is the state the app is in before GoogleService-Info.plist is
 * added to the Xcode target.
 */
export const isAnalyticsConfigured = ((): boolean => {
  try {
    return getApps().length > 0;
  } catch {
    return false;
  }
})();

if (!isAnalyticsConfigured && isDev) {
  console.warn('[analytics] No Firebase app — analytics disabled (add GoogleService-Info.plist).');
}

/** Lazily resolved so a misconfigured build fails the probe, not the import. */
function analytics() {
  return getAnalytics();
}

/**
 * Records an event. Fire-and-forget by design: callers sit in render paths and
 * gesture handlers where an await would be a behaviour change.
 */
export function track(name: CustomAnalyticsEventName, params?: AnalyticsParams): void {
  const clean = sanitizeParams(params);
  if (isDev) console.log(`[analytics] ${name}`, clean);
  if (!isAnalyticsConfigured) return;
  fbLogEvent(analytics(), name, clean).catch(() => {});
}

/** Aliases GA4 onto the Supabase user id; pass null on sign-out. */
export function setAnalyticsUser(userId: string | null): void {
  if (!isAnalyticsConfigured) return;
  setUserId(analytics(), userId).catch(() => {});
}

/** Values are strings or null, where null clears the property. */
export function setUserProps(props: Record<string, string | null>): void {
  if (isDev) console.log('[analytics] user properties', props);
  if (!isAnalyticsConfigured) return;
  setUserProperties(analytics(), props).catch(() => {});
}

/**
 * expo-router owns navigation, so Firebase's automatic screen reporting is off
 * in firebase.json and screen views come from here instead.
 */
export function logScreen(screenName: string, screenClass?: string): void {
  if (!isAnalyticsConfigured) return;
  logScreenView(analytics(), {
    screen_name: screenName,
    screen_class: screenClass ?? screenName,
  }).catch(() => {});
}

/**
 * The RevenueCat → Firebase integration needs this id as a subscriber
 * attribute; without it, server-side subscription events (renewal, cancellation,
 * billing issue) never reach GA4. Returns null when analytics consent is denied.
 */
export async function fetchAppInstanceId(): Promise<string | null> {
  if (!isAnalyticsConfigured) return null;
  try {
    return await getAppInstanceId(analytics());
  } catch {
    return null;
  }
}

export interface SubscriptionPurchase {
  productId: string;
  plan: SubscriptionPlan;
  source: PaywallSource;
  hasTrial: boolean;
  price: number;
  currency: string;
  transactionId?: string;
  /**
   * Which remote paywall configuration produced this purchase. See
   * src/lib/paywallContent.ts — without it a copy test changes conversion with
   * no way to attribute the change.
   */
  variant?: string;
}

/**
 * The GA4 ecommerce item for a subscription. `begin_checkout` and `purchase`
 * take fixed parameter shapes with no room for custom fields, so the dimensions
 * we care about ride along inside the item: which paywall sent the user
 * (`item_category`), whether they entered through a trial (`item_variant`), and
 * which remote copy variant they saw (`item_category2` — `item_variant` was
 * already spoken for).
 */
function subscriptionItem(p: SubscriptionPurchase) {
  return {
    item_id: p.productId,
    item_name: p.plan,
    item_category: p.source,
    item_category2: p.variant ?? 'default',
    item_variant: p.hasTrial ? 'trial' : 'direct',
    price: p.price,
    quantity: 1,
  };
}

/** GA4 recommended `begin_checkout` — the top of the purchase funnel. */
export function trackBeginCheckout(p: SubscriptionPurchase): void {
  if (isDev) console.log('[analytics] begin_checkout', p);
  if (!isAnalyticsConfigured) return;
  logBeginCheckout(analytics(), {
    currency: p.currency,
    value: p.price,
    items: [subscriptionItem(p)],
  }).catch(() => {});
}

/**
 * GA4 recommended `purchase` — the event that drives every revenue report.
 * Sent client-side on the immediate purchase; RevenueCat's server-side
 * integration independently reports renewals, cancellations and refunds.
 */
export function trackPurchase(p: SubscriptionPurchase): void {
  if (isDev) console.log('[analytics] purchase', p);
  if (!isAnalyticsConfigured) return;
  logPurchase(analytics(), {
    currency: p.currency,
    value: p.price,
    transaction_id: p.transactionId,
    items: [subscriptionItem(p)],
  }).catch(() => {});
}

export function trackSignUp(method: string): void {
  if (isDev) console.log('[analytics] sign_up', method);
  if (!isAnalyticsConfigured) return;
  logSignUp(analytics(), { method }).catch(() => {});
}

export function trackLogin(method: string): void {
  if (isDev) console.log('[analytics] login', method);
  if (!isAnalyticsConfigured) return;
  logLogin(analytics(), { method }).catch(() => {});
}

export function setAnalyticsEnabled(enabled: boolean): void {
  if (!isAnalyticsConfigured) return;
  setAnalyticsCollectionEnabled(analytics(), enabled).catch(() => {});
}

/**
 * Mirrors the ATT decision onto Google's consent signals. Measurement continues
 * either way; denying only turns off the advertising uses of the same data.
 */
export function setAdConsent(granted: boolean): void {
  if (!isAnalyticsConfigured) return;
  setConsent(analytics(), {
    analytics_storage: true,
    ad_storage: granted,
    ad_user_data: granted,
    ad_personalization: granted,
  }).catch(() => {});
}
