/**
 * Firebase Crashlytics wrapper.
 *
 * Two things this app needs that a bare Crashlytics install does not give you:
 *
 *  - **Non-fatal reporting.** Most failures here are caught and swallowed —
 *    `.catch(() => {})` appears throughout the services and stores — so without
 *    explicit recordError calls a broken upload or a failing edge function is
 *    invisible. `reportError` is the single entry point for those.
 *  - **Unhandled promise rejections.** Crashlytics installs a global handler for
 *    unhandled *exceptions* only. Rejections are tracked separately by React
 *    Native and merely logged, so they are chained here.
 *
 * The Crashlytics module is loaded lazily rather than imported at the top of the
 * file, because `@react-native-firebase/crashlytics` deliberately throws on
 * import when no default Firebase app exists:
 *
 *     // This will throw with 'Default App Not initialized' ...
 *     firebase.crashlytics.call(null, getApp(), MODULAR_DEPRECATION_ARG);
 *
 * A static import would therefore blow up at startup on any build without
 * GoogleService-Info.plist — before a runtime guard could ever run. Loading on
 * first use keeps this file inert until Firebase is actually configured, which
 * is the same contract as services/analytics.ts and services/purchases.ts.
 *
 * Caveat worth knowing when reading reports: Crashlytics cannot symbolicate
 * Hermes JavaScript frames, so release-build JS stacks are minified. The
 * breadcrumbs and custom keys set here are what make those reports actionable.
 */

import { getApps } from '@react-native-firebase/app';

import { AnalyticsEvent } from '../constants/analyticsEvents';
import { errorReason } from '../lib/analyticsUserProps';
import { track } from './analytics';

const isDev = typeof __DEV__ !== 'undefined' && __DEV__;

/** True once FirebaseApp.configure() has run natively with a valid plist. */
function hasDefaultApp(): boolean {
  try {
    return getApps().length > 0;
  } catch {
    return false;
  }
}

export const isCrashReportingConfigured = hasDefaultApp();

if (!isCrashReportingConfigured && isDev) {
  console.warn('[crashlytics] No Firebase app — crash reporting disabled.');
}

type CrashlyticsModule = typeof import('@react-native-firebase/crashlytics');

let cached: CrashlyticsModule | null = null;
let loadFailed = false;

/**
 * Returns the Crashlytics module, or null when Firebase is unconfigured.
 * Importing it is also what installs React Native Firebase's own global
 * JavaScript exception handler, so the first call here is a meaningful moment —
 * see initCrashReporting, which forces it at startup.
 */
function crashlytics(): CrashlyticsModule | null {
  if (cached || loadFailed) return cached;
  if (!hasDefaultApp()) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@react-native-firebase/crashlytics');
    // Metro's ESM interop can nest the named exports under `default`.
    const resolved = (typeof mod?.getCrashlytics === 'function' ? mod : mod?.default) as
      | CrashlyticsModule
      | undefined;
    if (typeof resolved?.getCrashlytics !== 'function') throw new Error('unexpected module shape');
    cached = resolved;
  } catch (err) {
    loadFailed = true;
    if (isDev) console.warn('[crashlytics] module failed to load', err);
  }
  return cached;
}

/** The screen a report came from, kept current by useScreenTracking. */
let currentScreen = 'unknown';

/**
 * Records a caught error as a Crashlytics non-fatal and mirrors it to GA4 as an
 * `app_error` count, so error *rate* is trendable alongside the funnels while
 * Crashlytics holds the stack.
 *
 * `domain` is a short, stable bucket ('analysis', 'purchase', 'render', ...) —
 * keep it low-cardinality so the GA4 dimension stays useful.
 */
export function reportError(
  error: unknown,
  domain: string,
  context?: Record<string, string | number | boolean | undefined>,
): void {
  const reason = errorReason(error);
  if (isDev) console.warn(`[crash] ${domain}: ${reason}`, context ?? '');

  track(AnalyticsEvent.APP_ERROR, { domain, reason, screen: currentScreen, ...context });

  const api = crashlytics();
  if (!api) return;

  const instance = api.getCrashlytics();
  const err = error instanceof Error ? error : new Error(reason);
  if (context) {
    const attrs: Record<string, string> = { domain, screen: currentScreen };
    for (const [k, v] of Object.entries(context)) {
      if (v !== undefined) attrs[k] = String(v);
    }
    api.setAttributes(instance, attrs).catch(() => {});
  }
  api.recordError(instance, err, domain);
}

/** A trail message attached to whatever crash comes next. */
export function breadcrumb(message: string): void {
  const api = crashlytics();
  if (!api) return;
  api.log(api.getCrashlytics(), message);
}

export function setCrashUser(userId: string | null): void {
  const api = crashlytics();
  if (!api) return;
  api.setUserId(api.getCrashlytics(), userId ?? '').catch(() => {});
}

export function setCrashKeys(keys: Record<string, string>): void {
  const api = crashlytics();
  if (!api) return;
  api.setAttributes(api.getCrashlytics(), keys).catch(() => {});
}

/** Called by useScreenTracking so reports carry the screen they happened on. */
export function setCurrentScreen(screen: string): void {
  currentScreen = screen;
  const api = crashlytics();
  if (!api) return;
  api.setAttributes(api.getCrashlytics(), { screen }).catch(() => {});
}

export function setCrashReportingEnabled(enabled: boolean): void {
  const api = crashlytics();
  if (!api) return;
  api.setCrashlyticsCollectionEnabled(api.getCrashlytics(), enabled).catch(() => {});
}

/**
 * Forces a native crash. Only reachable from the debug screen — and note that
 * expo-dev-client's error overlay intercepts native crashes, so verifying
 * Crashlytics requires a release build.
 */
export function forceTestCrash(): void {
  const api = crashlytics();
  if (!api) return;
  api.crash(api.getCrashlytics());
}

let rejectionTrackingInstalled = false;

/**
 * Loads Crashlytics (installing its global exception handler) and chains our own
 * reporting onto React Native's promise-rejection tracking rather than replacing
 * it, so LogBox keeps working in development.
 */
export function initCrashReporting(): void {
  if (rejectionTrackingInstalled) return;
  rejectionTrackingInstalled = true;

  // Force the lazy load at startup so RNFB's global JS exception handler is
  // installed before anything can throw, not on the first reportError call.
  crashlytics();

  try {
    // Untyped RN internals, present in 0.81 but not public API. require() on
    // purpose: a static import would fail the bundle outright if either path
    // moves in a future upgrade, where this only skips rejection tracking.
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { enable } = require('promise/setimmediate/rejection-tracking');
    const defaults = require('react-native/Libraries/promiseRejectionTrackingOptions').default;
    /* eslint-enable @typescript-eslint/no-require-imports */

    enable({
      ...defaults,
      onUnhandled: (id: number, rejection: unknown) => {
        reportError(rejection, 'unhandled_rejection', { rejection_id: id });
        defaults?.onUnhandled?.(id, rejection);
      },
    });
  } catch {
    // Rejection tracking is a nicety; its absence must not break startup.
  }
}
