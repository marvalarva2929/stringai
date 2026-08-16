import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { REMINDER_NOTIFICATION } from '../constants/onboardingContent';

// Local-only daily practice reminders. No remote push, no backend token
// storage — everything here is scheduled on-device via expo-notifications.

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

const ANDROID_CHANNEL_ID = 'practice-reminders';

export async function ensureAndroidChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(ANDROID_CHANNEL_ID, {
    name: 'Practice reminders',
    importance: Notifications.AndroidImportance.DEFAULT,
  });
}

/** Requests notification permission if not already determined. Returns whether
 *  the app is allowed to schedule/show notifications. */
export async function ensureReminderPermission(): Promise<boolean> {
  const existing = await Notifications.getPermissionsAsync();
  if (existing.granted) return true;
  if (!existing.canAskAgain) return false;
  const requested = await Notifications.requestPermissionsAsync();
  return requested.granted;
}

/**
 * Stable identifiers, so each scheduled notification can be replaced without
 * touching the others.
 *
 * This used to be a `cancelAllScheduledNotificationsAsync()` before every
 * schedule, on the reasoning that the daily reminder was the only thing the app
 * ever scheduled. That stopped being true with the trial recap: rescheduling
 * the reminder would silently delete the recap, and vice versa.
 */
export const DAILY_REMINDER_ID = 'daily-practice-reminder';
export const TRIAL_RECAP_ID = 'trial-recap';

/** Cancels any existing reminder, then schedules a new daily one at hour:minute
 *  local time. Addressed by id so it can't disturb the trial recap. */
export async function scheduleDailyReminder(hour: number, minute: number): Promise<void> {
  await ensureAndroidChannel();
  await Notifications.cancelScheduledNotificationAsync(DAILY_REMINDER_ID).catch(() => {});
  await Notifications.scheduleNotificationAsync({
    identifier: DAILY_REMINDER_ID,
    content: {
      title: REMINDER_NOTIFICATION.title,
      body: REMINDER_NOTIFICATION.body,
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DAILY,
      hour,
      minute,
    },
  });
}

export async function cancelReminders(): Promise<void> {
  await Notifications.cancelScheduledNotificationAsync(DAILY_REMINDER_ID).catch(() => {});
}

/**
 * Schedules the one-off trial recap for an absolute date, replacing any
 * previous one.
 *
 * Re-scheduled rather than written once, because a local notification's body is
 * fixed at schedule time and the whole point of this message is to carry the
 * user's *actual* progress. Every app open rewrites it with current numbers —
 * see syncTrialRecap in src/lib/trialRecap.ts.
 */
export async function scheduleTrialRecap(
  fireAt: Date,
  content: { title: string; body: string },
): Promise<void> {
  await ensureAndroidChannel();
  await Notifications.cancelScheduledNotificationAsync(TRIAL_RECAP_ID).catch(() => {});
  // A date in the past fires immediately on some platforms — never schedule one.
  if (fireAt.getTime() <= Date.now()) return;
  await Notifications.scheduleNotificationAsync({
    identifier: TRIAL_RECAP_ID,
    content,
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DATE,
      date: fireAt,
    },
  });
}

export async function cancelTrialRecap(): Promise<void> {
  await Notifications.cancelScheduledNotificationAsync(TRIAL_RECAP_ID).catch(() => {});
}
