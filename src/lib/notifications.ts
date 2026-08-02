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

/** Cancels any existing reminder, then schedules a new daily one at hour:minute
 *  local time. Reminders are the app's only scheduled notifications, so a full
 *  cancel-then-schedule can't clobber anything else. */
export async function scheduleDailyReminder(hour: number, minute: number): Promise<void> {
  await ensureAndroidChannel();
  await Notifications.cancelAllScheduledNotificationsAsync();
  await Notifications.scheduleNotificationAsync({
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
  await Notifications.cancelAllScheduledNotificationsAsync();
}
