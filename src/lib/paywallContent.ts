/**
 * What the paywall says, and where it comes from.
 *
 * Pure and dependency-free (no react, no zustand, no RevenueCat) so the rules
 * are unit-testable in plain Node, matching the convention in entitlements.ts.
 *
 * ── Why this is remote ──────────────────────────────────────
 *
 * Every copy change to a compiled paywall costs an App Store review, which is
 * 1-3 days. That is the difference between testing the wall two or three times
 * a month and testing it weekly, and it matters most in the window right after
 * launch when traffic arrives in bursts from individual videos.
 *
 * RevenueCat's Offering metadata is already fetched with the products, so
 * reading copy out of it costs one extra field and no new dependency — and
 * changing an offering in the dashboard is instant. That is deliberately a
 * smaller step than RevenueCat Paywalls v2, which would need the purchases-ui
 * package and a v7→v8 SDK bump, and would replace a hand-built screen with a
 * templated one.
 *
 * Everything here falls back to a hardcoded default. A misconfigured or empty
 * offering must degrade to the shipped paywall, never to a blank one — an
 * offering typo should cost a copy test, not the entire funnel.
 */

/** The shipped defaults. Also the fallback for every remote field. */
export const DEFAULT_FEATURES: string[] = [
  'Live camera recording with real-time feedback',
  'AI coaching on every session, written for what you actually played',
  'Unlimited analyses of every piece you play',
  'Session history & progress tracking',
];

export const DEFAULT_HEADLINE_MANDATORY = 'Start your free trial';
export const DEFAULT_HEADLINE_OPTIONAL = 'Unlock More Features';

/**
 * The indie framing, in the product rather than only in the marketing.
 *
 * This is true, which is the whole point — it is a reason to buy that a funded
 * competitor structurally cannot offer, and it costs nothing to say honestly.
 * Kept remote so its wording can be tested without a release.
 */
export const DEFAULT_PERSONAL_NOTE =
  "I'm a student building StringAI on my own. Your subscription pays for the servers that analyse your playing, and buys me the time to keep making it better.";

export interface PaywallCopy {
  headline: string;
  features: string[];
  /** Null hides the block entirely, so it can be switched off remotely. */
  personalNote: string | null;
  /**
   * Labels this configuration in analytics. Rides on paywall_view,
   * begin_checkout and purchase so a copy test is attributable — without it a
   * remote change is invisible in the funnel and cannot be judged.
   */
  variant: string;
}

/** Reads a string out of RevenueCat's `unknown`-typed metadata bag. */
function readString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Reads a string array, tolerating the two shapes a dashboard produces: a real
 * JSON array, or a newline-separated string typed into a text field.
 */
function readStringList(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string[] | undefined {
  const value = metadata?.[key];
  if (Array.isArray(value)) {
    const items = value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
    return items.length > 0 ? items.map((v) => v.trim()) : undefined;
  }
  if (typeof value === 'string') {
    const items = value.split('\n').map((v) => v.trim()).filter((v) => v.length > 0);
    return items.length > 0 ? items : undefined;
  }
  return undefined;
}

export interface PaywallCopyOpts {
  /** The mandatory activation gate reads differently from an optional upsell. */
  mandatory: boolean;
}

export function paywallCopyFromMetadata(
  metadata: Record<string, unknown> | undefined,
  { mandatory }: PaywallCopyOpts,
): PaywallCopy {
  const defaultHeadline = mandatory ? DEFAULT_HEADLINE_MANDATORY : DEFAULT_HEADLINE_OPTIONAL;
  // An explicit empty string switches the note off remotely; an absent key
  // keeps the default. `readString` collapses empty to undefined, so the
  // presence of the key is what distinguishes the two.
  const noteKeyPresent = metadata != null && 'personal_note' in metadata;
  const remoteNote = readString(metadata, 'personal_note');

  return {
    headline: readString(metadata, 'headline') ?? defaultHeadline,
    features: readStringList(metadata, 'features') ?? DEFAULT_FEATURES,
    personalNote: noteKeyPresent ? (remoteNote ?? null) : DEFAULT_PERSONAL_NOTE,
    variant: readString(metadata, 'variant') ?? 'default',
  };
}

// ── Echoing the diagnostic back ────────────────────────────

/** The subset of a session this module needs. Structurally typed so the
 *  module stays runnable under plain Node in tests. */
export interface SessionEvidenceLike {
  title: string;
  priority?: number;
}

/**
 * The one-line "here is what we just found in your playing" for the paywall.
 *
 * Drawn from the session's frozen practice evidence rather than recomputed, so
 * the sentence on the paywall and the first drill in the plan are guaranteed to
 * name the same thing. A user who is told their third finger runs flat and then
 * opens a plan about something else has been sold on a claim the app didn't
 * keep.
 *
 * Returns null when there is nothing grounded to say — no session, or a take
 * clean enough that nothing was flagged. The paywall then falls back to generic
 * copy rather than inventing a fault, which is the entire reason this reads
 * frozen evidence instead of writing its own sentence.
 */
export function diagnosticFocusTitle(evidence: SessionEvidenceLike[] | undefined): string | null {
  if (!evidence || evidence.length === 0) return null;
  const best = [...evidence].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))[0];
  const title = best?.title?.trim();
  return title && title.length > 0 ? title : null;
}
