import { useAnalysisStore } from '../store/useAnalysisStore';
import { useEntitlementStore } from '../store/useEntitlementStore';
import { useReminderStore } from '../store/useReminderStore';
import { computeStreak } from '../lib/streak';
import { buildTrialRecap, recapFireDate, daysUntil } from '../lib/trialRecap';
import { scheduleTrialRecap, cancelTrialRecap, ensureReminderPermission } from '../lib/notifications';

/**
 * Keeps the pre-conversion trial recap in sync with what the user has actually
 * done.
 *
 * A local notification's body is frozen when it is scheduled, so a message
 * written on day one would report day-one progress on day five. Rewriting it on
 * every app open costs one cheap cancel-and-reschedule and means the numbers are
 * as fresh as the user's last visit — which, for anyone worth sending this to,
 * is recent.
 *
 * Safe to call unconditionally and often. It cancels rather than schedules for
 * anyone not in a trial, so an expired, converted, or never-started
 * subscription cleans up after itself without a separate teardown path.
 *
 * Deliberately does NOT request notification permission. Onboarding already
 * asks, in context, with the daily reminder toggle; asking again here — cold,
 * mid-trial — is exactly the prompt people deny reflexively, and a denial would
 * also cost the daily reminder.
 */
export async function syncTrialRecap(): Promise<void> {
  try {
    const { entitlement } = useEntitlementStore.getState();

    if (!entitlement.inTrial || !entitlement.trialEndsAt) {
      await cancelTrialRecap();
      return;
    }

    const trialEndsAt = new Date(entitlement.trialEndsAt);
    if (Number.isNaN(trialEndsAt.getTime())) {
      await cancelTrialRecap();
      return;
    }

    const fireAt = recapFireDate(trialEndsAt);
    // Trial too short, or already inside the lead window. Nothing to send —
    // and a message arriving after the charge is worse than none.
    if (!fireAt) {
      await cancelTrialRecap();
      return;
    }

    // Only schedule if we can actually deliver. Checked rather than requested:
    // see the note above.
    const allowed = await ensureReminderPermission().catch(() => false);
    if (!allowed) return;

    const { sessionHistory } = useAnalysisStore.getState();
    // The whole history is the trial's history. The entitlement carries
    // trialEndsAt but not a start date, and there is nothing to subtract it
    // from — the trial begins at the end of the first run, so every session a
    // trialing user has is one they recorded during it. (Apple grants one
    // introductory offer per subscription group, so a second trial with a back
    // catalogue behind it isn't a case that arises.)
    const content = buildTrialRecap({
      scores: sessionHistory.map((s) => s.overallScore),
      streak: computeStreak(sessionHistory),
      daysLeft: daysUntil(trialEndsAt, fireAt),
    });

    await scheduleTrialRecap(atReminderHour(fireAt), content);
  } catch {
    // A recap that cannot be scheduled is not worth failing an app launch over.
  }
}

/**
 * Moves the fire time to the hour the user chose for their daily reminder.
 *
 * The raw fire date is "trial end minus two days", which is whatever time of
 * day they happened to subscribe — potentially 3am. They already told us when
 * they want to hear from us; reuse it. Falls back to the reminder store's own
 * 18:00 default, which is what an untouched install holds.
 */
function atReminderHour(fireAt: Date): Date {
  const { hour, minute } = useReminderStore.getState();
  const at = new Date(fireAt);
  at.setHours(hour, minute, 0, 0);
  // Pulling it back to the chosen hour can push it into the past; a day earlier
  // is still inside the trial and still useful, so nudge forward instead.
  if (at.getTime() <= Date.now()) at.setDate(at.getDate() + 1);
  return at;
}
