/**
 * App Tracking Transparency.
 *
 * Firebase Analytics only reads the IDFA once ATT is authorised, and the IDFA is
 * what makes install attribution (Apple Search Ads, Google Ads UAC) possible.
 * Everything else — funnels, conversions, retention, revenue — is unaffected by
 * a denial, so nothing in the app gates on the result.
 *
 * Requested from the onboarding permissions step, where the user is already
 * granting camera and microphone, rather than on first launch: Apple requires
 * the prompt to actually appear, and a cold-start prompt with no context is the
 * one most people dismiss.
 */

import {
  getTrackingPermissionsAsync,
  requestTrackingPermissionsAsync,
} from 'expo-tracking-transparency';

import { setAdConsent } from './analytics';

export type AttStatus = 'granted' | 'denied' | 'undetermined' | 'unavailable';

let cached: AttStatus = 'undetermined';

/** Last known status, for the `att_status` user property. */
export function getCachedAttStatus(): AttStatus {
  return cached;
}

function apply(status: string | undefined): AttStatus {
  const next: AttStatus =
    status === 'granted' || status === 'denied' || status === 'undetermined'
      ? status
      : 'unavailable';
  cached = next;
  setAdConsent(next === 'granted');
  return next;
}

/** Reads the current status without prompting. */
export async function refreshTrackingStatus(): Promise<AttStatus> {
  try {
    const { status } = await getTrackingPermissionsAsync();
    return apply(status);
  } catch {
    cached = 'unavailable';
    return cached;
  }
}

/**
 * Shows the system prompt if it hasn't been answered yet. Safe to call more than
 * once — iOS only ever presents it a single time and returns the stored answer
 * afterwards.
 */
export async function requestTrackingPermission(): Promise<AttStatus> {
  try {
    const { status } = await requestTrackingPermissionsAsync();
    return apply(status);
  } catch {
    cached = 'unavailable';
    return cached;
  }
}
