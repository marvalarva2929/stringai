import { Linking } from 'react-native';
import Constants from 'expo-constants';
import { supabase, isSupabaseConfigured } from './supabase';
import { track } from './analytics';
import { useAuthStore } from '../store/useAuthStore';
import { AnalyticsEvent } from '../constants/analyticsEvents';
import { SUPPORT_EMAIL } from '../constants/links';

/**
 * In-app feedback from the gated review prompt's unhappy path.
 *
 * Fire-and-forget, like saveSession and updateSessionLlmFeedback: someone who
 * has just told us the app disappointed them should not then be shown an error
 * dialog about it. Failures are swallowed and the UI thanks them either way.
 *
 * Guests have no row to insert against (RLS is insert-own), so they fall back to
 * opening a mail draft — better than dropping the feedback on the floor.
 */
export async function submitFeedback(message: string, context: string): Promise<void> {
  const trimmed = message.trim();
  if (!trimmed) return;

  const { isAuthenticated, userId } = useAuthStore.getState();
  const appVersion = Constants.expoConfig?.version ?? null;

  // Message text stays out of analytics — only that feedback happened, how long
  // it was, and which path delivered it.
  const report = (delivery: 'supabase' | 'mailto') =>
    track(AnalyticsEvent.FEEDBACK_SUBMITTED, {
      trigger: context,
      delivery,
      length_bkt: trimmed.length < 80 ? 'short' : trimmed.length < 400 ? 'medium' : 'long',
    });

  if (isSupabaseConfigured && isAuthenticated && userId) {
    try {
      const { error } = await supabase.from('app_feedback').insert({
        user_id: userId,
        message: trimmed.slice(0, 4000),
        context,
        app_version: appVersion,
      });
      if (!error) {
        report('supabase');
        return;
      }
    } catch {
      // fall through to mail
    }
  }

  report('mailto');
  openFeedbackMail(trimmed, context);
}

function openFeedbackMail(message: string, context: string): void {
  const subject = encodeURIComponent(`StringAI feedback (${context})`);
  const body = encodeURIComponent(message);
  Linking.openURL(`mailto:${SUPPORT_EMAIL}?subject=${subject}&body=${body}`).catch(() => {});
}
