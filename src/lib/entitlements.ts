/**
 * Entitlement rules — the single source of truth for what a subscription grants.
 *
 * Pure and dependency-free (no zustand, no RevenueCat, no Supabase) so the
 * rules can be unit-tested in plain Node, matching the convention in
 * practiceProgress.ts / bowAnalysis.ts.
 *
 * The app is subscription-only. There is no reduced free experience: a user
 * without the `pro` entitlement sees the paywall, not a smaller app. That is
 * why there is exactly one gate here (`requiresSubscription`) rather than a
 * per-feature predicate for each locked thing — nothing inside the app is
 * reachable without a subscription, so nothing inside the app needs to ask.
 *
 * Trial and paid are the SAME entitlement. The App Store introductory offer
 * grants `pro` for its 7 or 14 days, so no gate ever branches on trial —
 * `inTrial` exists only so the paywall and settings can say "4 days left".
 * Keep it that way: a gate that checks `inTrial` is a bug.
 */

export type Tier = 'free' | 'pro';

/** RevenueCat's entitlement identifier, configured in the RevenueCat dashboard. */
export const PRO_ENTITLEMENT_ID = 'pro';

export interface Entitlement {
  /** `free` means "no active subscription" — i.e. blocked at the paywall. */
  tier: Tier;
  /** Display only — never gate on this. See file header. */
  inTrial: boolean;
  /** ISO timestamp the trial converts to paid, or null. */
  trialEndsAt: string | null;
  /** ISO timestamp the subscription lapses, or null for a lifetime/free row. */
  expiresAt: string | null;
}

export function freeEntitlement(): Entitlement {
  return { tier: 'free', inTrial: false, trialEndsAt: null, expiresAt: null };
}

// ── The gate ───────────────────────────────────────────────────

export const isPro = (e: Entitlement): boolean => e.tier === 'pro';

/**
 * The only entitlement gate in the app. True means the subscribe screen is
 * shown over everything (see the SubscribeGate in app/_layout.tsx).
 */
export const requiresSubscription = (e: Entitlement): boolean => !isPro(e);

/** Whole days until the trial converts. 0 once it has elapsed. */
export function trialDaysRemaining(e: Entitlement, now: Date = new Date()): number {
  if (!e.inTrial || !e.trialEndsAt) return 0;
  const ms = new Date(e.trialEndsAt).getTime() - now.getTime();
  return ms <= 0 ? 0 : Math.ceil(ms / 86_400_000);
}

// ── Introductory offers ────────────────────────────────────────

/**
 * The shape of RevenueCat's `PurchasesIntroPrice` that we actually read.
 * Structurally typed rather than imported from react-native-purchases so this
 * module stays runnable under plain Node in tests — same reasoning as
 * CustomerInfoLike below.
 */
export interface IntroPriceLike {
  /** DAY | WEEK | MONTH | YEAR. */
  periodUnit: string;
  periodNumberOfUnits: number;
  /** Billing cycles the offer covers. A free trial is always 1. */
  cycles?: number;
}

const DAYS_PER_UNIT: Record<string, number> = {
  DAY: 1,
  WEEK: 7,
  // Approximations, and deliberately so: these only ever produce the number in
  // "Start a 14-Day Free Trial". App Store trials are configured in days or
  // weeks in practice, so the month/year rows are just defensive.
  MONTH: 30,
  YEAR: 365,
};

/**
 * Trial length in days from a RevenueCat intro offer, or null when there is no
 * offer (or its period unit is unrecognised — better to fall back to plain
 * pricing than to advertise a duration we cannot name).
 *
 * Both plans carry an intro offer of different lengths, so this must be read
 * per package. Note that the presence of an intro offer is not the same as the
 * user being *eligible* for it: Apple grants one introductory offer per
 * subscription group, so someone who used the monthly trial cannot then take
 * the annual one. Eligibility is a separate runtime check — see
 * checkTrialEligibility in services/purchases.ts.
 */
export function introTrialDays(intro: IntroPriceLike | null | undefined): number | null {
  if (!intro) return null;
  const perUnit = DAYS_PER_UNIT[intro.periodUnit?.toUpperCase()];
  if (!perUnit || !intro.periodNumberOfUnits) return null;
  const cycles = intro.cycles && intro.cycles > 0 ? intro.cycles : 1;
  return perUnit * intro.periodNumberOfUnits * cycles;
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

/** Derives the entitlement from RevenueCat's customer info. */
export function entitlementFromCustomerInfo(info: CustomerInfoLike): Entitlement {
  const active = info.entitlements.active[PRO_ENTITLEMENT_ID];
  if (!active) return freeEntitlement();
  // RevenueCat types periodType as a bare string; the native SDKs emit 'TRIAL'
  // but their docs write 'trial'. Compare case-insensitively rather than bet.
  const inTrial = active.periodType?.toUpperCase() === 'TRIAL';
  const expiresAt = active.expirationDate ?? null;
  return {
    tier: 'pro',
    inTrial,
    trialEndsAt: inTrial ? expiresAt : null,
    expiresAt,
  };
}
