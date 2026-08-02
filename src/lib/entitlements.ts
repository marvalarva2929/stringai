/**
 * Entitlement rules — the single source of truth for what each tier can do.
 *
 * Pure and dependency-free (no zustand, no RevenueCat, no Supabase) so the
 * gating rules can be unit-tested in plain Node, matching the convention in
 * practiceProgress.ts / bowAnalysis.ts.
 *
 * Trial and Pro are the SAME entitlement. The App Store introductory offer
 * grants the `pro` entitlement for its 7 days, so no gate ever branches on
 * trial — `inTrial` exists only so the paywall and settings can say
 * "4 days left". Keep it that way: a gate that checks `inTrial` is a bug.
 */

export type Tier = 'free' | 'pro';

/** RevenueCat's entitlement identifier, configured in the RevenueCat dashboard. */
export const PRO_ENTITLEMENT_ID = 'pro';

export const FREE_DAILY_ANALYSES = 3;

export interface Entitlement {
  tier: Tier;
  /** Display only — never gate on this. See file header. */
  inTrial: boolean;
  /** ISO timestamp the trial converts to paid, or null. */
  trialEndsAt: string | null;
  /** ISO timestamp the subscription lapses, or null for a lifetime/free row. */
  expiresAt: string | null;
  analysesUsedToday: number;
  /**
   * The day `analysesUsedToday` was counted against, as `YYYY-MM-DD`.
   * Lets the counter roll over on read rather than needing a scheduled reset.
   */
  analysesCountDate: string;
}

/**
 * `YYYY-MM-DD` in the device's local timezone.
 *
 * Only meaningful for guests. For signed-in users the server's `current_date`
 * is authoritative (see `consume_analysis`), and a user who crosses midnight in
 * a different timezone than the database may see the client's remaining-count
 * hint disagree with the server by a few hours. The server always wins, so the
 * worst case is a stale number in the UI, never a bypassed cap.
 */
export function localDateKey(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function freeEntitlement(now: Date = new Date()): Entitlement {
  return {
    tier: 'free',
    inTrial: false,
    trialEndsAt: null,
    expiresAt: null,
    analysesUsedToday: 0,
    analysesCountDate: localDateKey(now),
  };
}

/** Usage rolled over to `today` — zero once the stored count is from a past day. */
export function analysesUsedOn(e: Entitlement, today: string = localDateKey()): number {
  return e.analysesCountDate === today ? e.analysesUsedToday : 0;
}

// ── The gates ──────────────────────────────────────────────────

export const isPro = (e: Entitlement): boolean => e.tier === 'pro';

/** Live in-app camera recording (the pose-camera module). */
export const canRecordLive = isPro;

/** L10 Claude coaching. Free users fall back to buildSessionFeedback(). */
export const canUseLlmCoaching = isPro;

/** Post-session curated exercises (the per-piece practice plan after a recording). */
export const canUseCuratedExercises = isPro;

/** Phase 6. Free tier only — trial and Pro are always ad-free. */
export const showAds = (e: Entitlement): boolean => !isPro(e);

export function analysesRemaining(e: Entitlement, today: string = localDateKey()): number {
  if (isPro(e)) return Infinity;
  return Math.max(0, FREE_DAILY_ANALYSES - analysesUsedOn(e, today));
}

export function canAnalyze(e: Entitlement, today: string = localDateKey()): boolean {
  return analysesRemaining(e, today) > 0;
}

/**
 * Optimistic local decrement for guests. Signed-in users must go through the
 * `consume_analysis` RPC instead — this never writes to the server.
 */
export function consumeAnalysis(e: Entitlement, today: string = localDateKey()): Entitlement {
  if (isPro(e)) return e;
  return { ...e, analysesUsedToday: analysesUsedOn(e, today) + 1, analysesCountDate: today };
}

/** Whole days until the trial converts. 0 once it has elapsed. */
export function trialDaysRemaining(e: Entitlement, now: Date = new Date()): number {
  if (!e.inTrial || !e.trialEndsAt) return 0;
  const ms = new Date(e.trialEndsAt).getTime() - now.getTime();
  return ms <= 0 ? 0 : Math.ceil(ms / 86_400_000);
}

// ── Mapping RevenueCat's CustomerInfo onto an Entitlement ──────
//
// Structurally typed rather than importing from react-native-purchases, so this
// module stays runnable under plain Node in tests.

export interface CustomerInfoLike {
  entitlements: {
    active: Record<string, { periodType?: string; expirationDate?: string | null } | undefined>;
  };
}

/**
 * Derives the entitlement from RevenueCat, carrying the daily counter over from
 * `previous` — RevenueCat knows nothing about analysis counts.
 */
export function entitlementFromCustomerInfo(
  info: CustomerInfoLike,
  previous: Entitlement,
): Entitlement {
  const active = info.entitlements.active[PRO_ENTITLEMENT_ID];
  if (!active) {
    return { ...previous, tier: 'free', inTrial: false, trialEndsAt: null, expiresAt: null };
  }
  // RevenueCat types periodType as a bare string; the native SDKs emit 'TRIAL'
  // but their docs write 'trial'. Compare case-insensitively rather than bet.
  const inTrial = active.periodType?.toUpperCase() === 'TRIAL';
  const expiresAt = active.expirationDate ?? null;
  return {
    ...previous,
    tier: 'pro',
    inTrial,
    trialEndsAt: inTrial ? expiresAt : null,
    expiresAt,
  };
}
