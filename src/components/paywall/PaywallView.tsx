import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Alert,
  Linking,
} from 'react-native';
import Animated, { SlideInDown } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import type { PurchasesPackage } from 'react-native-purchases';
import { colors, spacing, radius } from '../../constants/theme';
import { BigButton } from '../ui/BigButton';
import {
  checkTrialEligibility,
  getCurrentOffering,
  isPurchasesConfigured,
  purchasePackage,
  restorePurchases,
} from '../../services/purchases';
import { useEntitlementStore } from '../../store/useEntitlementStore';
import { useAuthStore } from '../../store/useAuthStore';
import { useReviewStore } from '../../store/useReviewStore';
import { SignInSheet } from '../auth/SignInSheet';
import { syncTrialRecap } from '../../services/trialRecapScheduler';
import { useAnalysisStore } from '../../store/useAnalysisStore';
import { useActivationStore } from '../../store/useActivationStore';
import { PRO_ENTITLEMENT_ID, introTrialDays, isPro } from '../../lib/entitlements';
import { PRIVACY_POLICY_URL, TERMS_OF_SERVICE_URL } from '../../constants/links';
import { AnalyticsEvent, type PaywallSource } from '../../constants/analyticsEvents';
import { track, trackBeginCheckout, trackPurchase } from '../../services/analytics';
import { errorReason } from '../../lib/analyticsUserProps';
import { qaCheckpoint } from '../../services/crashReporting';
import {
  paywallCopyFromMetadata,
  diagnosticFocusTitle,
  type PaywallCopy,
} from '../../lib/paywallContent';
import { useOnboardingStore } from '../../store/useOnboardingStore';
import { LEARNING_GOALS } from '../../constants/onboardingContent';

type Plan = 'monthly' | 'annual';

const FALLBACK_MONTHLY_PRICE = 9.99;
const FALLBACK_ANNUAL_PRICE = 59.99;

// A private violin lesson runs roughly $50/hr; a typical weekly-lesson
// student pays for ~4 lessons a month. Used only to anchor the price against
// a familiar alternative, not billed anywhere.
const AVERAGE_TUTOR_MONTHLY_COST = 200;

// The feature list, headline and personal note now come from
// paywallCopyFromMetadata so they can be changed from the RevenueCat dashboard
// without an App Store review. DEFAULT_FEATURES in src/lib/paywallContent.ts
// is what ships and what any missing metadata falls back to.
//
// Note the old wording claimed "Personal AI coaching from Claude after every
// session". Post-session coaching runs on DeepSeek V4 Flash via the HF router
// (supabase/functions/_shared/coachingPrompt.ts); only Maestro chat is Claude.
// Naming the wrong model in copy that also ships as App Store metadata is a
// needless review risk.

// $59.99/yr -> "$5" (whole dollars round cleanly; anything else keeps cents).
function formatMonthlyEquivalent(annualPrice: number): string {
  const perMonth = Math.round((annualPrice / 12) * 100) / 100;
  return Number.isInteger(perMonth) ? `$${perMonth}` : `$${perMonth.toFixed(2)}`;
}

interface PaywallViewProps {
  /** Close button (✕) action. Not rendered at all when `mandatory`. */
  onClose: () => void;
  /** Called when the success alert's button is pressed. Defaults to onClose. */
  onPurchased?: () => void;
  /**
   * Which gate sent the user here. Reported on every event this screen emits,
   * so conversion can be compared per entry point.
   */
  source?: PaywallSource;
  /**
   * Hides every way out except purchasing or restoring. Used by the activation
   * gate, which is the only path into the app — see SubscribeGate in
   * app/_layout.tsx. Restore and the legal links stay: Apple requires both, and
   * Restore is the only legitimate exit for an existing subscriber on a new
   * device.
   */
  mandatory?: boolean;
}

// The single subscription screen — a blue backdrop with a white sheet that
// slides up from the bottom.
export function PaywallView({
  onClose,
  onPurchased,
  source = 'unknown',
  mandatory = false,
}: PaywallViewProps) {
  const [selectedPlan, setSelectedPlan] = useState<Plan>('annual');
  const [loading, setLoading] = useState(false);
  const [packages, setPackages] = useState<{ monthly?: PurchasesPackage; annual?: PurchasesPackage }>({});
  const [offeringsLoading, setOfferingsLoading] = useState(true);
  const [signInOpen, setSignInOpen] = useState(false);
  const [copy, setCopy] = useState<PaywallCopy>(() =>
    paywallCopyFromMetadata(undefined, { mandatory }),
  );
  // Product ids the user can actually start a trial on. Null until the check
  // resolves; treated as "no trials" until then so no card can briefly promise
  // a free trial and then take it back.
  const [trialEligible, setTrialEligible] = useState<Set<string> | null>(null);
  const openedAt = useRef(Date.now());
  // Set once the purchase succeeds, so the unmount handler can tell a dismissal
  // from a conversion.
  const purchasedRef = useRef(false);

  const { applyCustomerInfo } = useEntitlementStore();
  const clearAccountDeferred = useAuthStore((s) => s.clearAccountDeferred);

  // What the diagnostic just found, and what they said they wanted. Both are
  // things the user themselves supplied minutes ago — the strongest available
  // argument, and the only one that costs nothing to make honestly.
  const focusTitle = useAnalysisStore((s) => diagnosticFocusTitle(s.currentResult?.sessionEvidence));
  const primaryGoalId = useOnboardingStore((s) => s.learningGoals[0]);
  const primaryGoal = useMemo(
    () => LEARNING_GOALS.find((g) => g.id === primaryGoalId)?.title,
    [primaryGoalId],
  );

  // Read by the unmount handler below, which would otherwise close over the
  // copy from the render it was created in — the default, not whatever loaded
  // since.
  const variantRef = useRef(copy.variant);
  variantRef.current = copy.variant;

  useEffect(() => {
    openedAt.current = Date.now();

    return () => {
      if (purchasedRef.current) return;
      track(AnalyticsEvent.PAYWALL_DISMISS, {
        source,
        variant: variantRef.current,
        ms_on_paywall: Date.now() - openedAt.current,
      });
    };
  }, [source]);

  // The impression is recorded once the offering settles rather than on mount,
  // so it can carry the variant — an A/B test whose impressions are unlabelled
  // has no denominator to divide conversions by. This does not cost coverage:
  // setOfferingsLoading(false) runs in a `finally`, so it fires on the
  // no-offering and error paths too, not just the happy one.
  const viewTrackedRef = useRef(false);
  useEffect(() => {
    if (offeringsLoading || viewTrackedRef.current) return;
    viewTrackedRef.current = true;
    track(AnalyticsEvent.PAYWALL_VIEW, {
      source,
      variant: copy.variant,
      session_count: useAnalysisStore.getState().sessionHistory.length,
      activation_step: useActivationStore.getState().step,
    });
  }, [offeringsLoading, copy.variant, source]);

  useEffect(() => {
    let cancelled = false;

    // Eligibility resolves before the CTA renders, so the button never shows
    // plain pricing and then swaps to a trial claim (or worse, the reverse).
    const load = async () => {
      try {
        const offering = await getCurrentOffering();
        if (cancelled) return;
        if (!offering) {
          // No offering means nothing can be bought — a conversion rate of zero
          // from this source would otherwise look like a copy problem.
          track(AnalyticsEvent.OFFERINGS_UNAVAILABLE, {
            source,
            reason: isPurchasesConfigured ? 'no_current_offering' : 'purchases_not_configured',
          });
          return;
        }
        const monthly = offering.monthly ?? undefined;
        const annual = offering.annual ?? undefined;
        setPackages({ monthly, annual });
        // Remote copy rides in with the products. Falls back to the shipped
        // defaults field by field, so a partial or malformed offering can only
        // cost a copy test, never the paywall itself.
        setCopy(paywallCopyFromMetadata(offering.metadata, { mandatory }));

        // Apple grants one intro offer per subscription group, so carrying an
        // introPrice is not the same as being able to use it. Check before
        // advertising a trial — see checkTrialEligibility.
        const ids = [monthly, annual]
          .map((p) => p?.product.identifier)
          .filter((id): id is string => !!id);
        const eligible = await checkTrialEligibility(ids);
        if (!cancelled) setTrialEligible(eligible);
      } catch (err) {
        if (!cancelled) {
          track(AnalyticsEvent.OFFERINGS_UNAVAILABLE, { source, reason: errorReason(err) });
        }
      } finally {
        if (!cancelled) setOfferingsLoading(false);
      }
    };

    load();
    return () => { cancelled = true; };
  }, [source]);

  const selectedPackage = selectedPlan === 'annual' ? packages.annual : packages.monthly;
  const priceFor = (plan: Plan) => {
    const pkg = plan === 'annual' ? packages.annual : packages.monthly;
    return pkg?.product.priceString ?? (plan === 'annual' ? '$59.99' : '$9.99');
  };
  const monthlyNumericPrice = packages.monthly?.product.price ?? FALLBACK_MONTHLY_PRICE;
  const annualNumericPrice = packages.annual?.product.price ?? FALLBACK_ANNUAL_PRICE;

  /**
   * Trial length for a plan, or null when there isn't one the user can take.
   * The two plans carry different offers (7 days monthly, 14 days annual), so
   * each card advertises its own rather than sharing one flag.
   */
  const trialDaysFor = (plan: Plan): number | null => {
    const pkg = plan === 'annual' ? packages.annual : packages.monthly;
    if (!pkg || !trialEligible?.has(pkg.product.identifier)) return null;
    return introTrialDays(pkg.product.introPrice);
  };
  const selectedTrialDays = trialDaysFor(selectedPlan);
  const hasTrial = selectedTrialDays !== null;

  // Annual vs. paying monthly for 12 months — drives the "SAVE X%" sticker.
  const savingsPct = useMemo(() => {
    const annualizedMonthly = monthlyNumericPrice * 12;
    if (annualizedMonthly <= 0) return null;
    const pct = Math.round((1 - annualNumericPrice / annualizedMonthly) * 100);
    return pct > 0 ? pct : null;
  }, [monthlyNumericPrice, annualNumericPrice]);

  // How much cheaper the selected plan is than an average private tutor,
  // month to month.
  const tutorMultiple = useMemo(() => {
    const effectiveMonthly = selectedPlan === 'annual' ? annualNumericPrice / 12 : monthlyNumericPrice;
    if (effectiveMonthly <= 0) return null;
    const multiple = Math.round(AVERAGE_TUTOR_MONTHLY_COST / effectiveMonthly);
    return multiple > 1 ? multiple : null;
  }, [selectedPlan, annualNumericPrice, monthlyNumericPrice]);

  // Annual is preselected, so an explicit switch to monthly is a signal about
  // price sensitivity worth separating from the default.
  const selectPlan = (plan: Plan) => {
    if (plan === selectedPlan) return;
    setSelectedPlan(plan);
    track(AnalyticsEvent.PAYWALL_PLAN_SELECTED, { source, plan, variant: copy.variant });
  };

  const handlePurchase = async () => {
    if (!selectedPackage) {
      track(AnalyticsEvent.PURCHASE_FAILED, {
        source,
        plan: selectedPlan,
        reason: isPurchasesConfigured ? 'offering_not_loaded' : 'purchases_not_configured',
      });
      Alert.alert(
        'Unavailable',
        isPurchasesConfigured
          ? 'Subscriptions are still loading. Please try again in a moment.'
          : 'Subscriptions are not available on this build.',
      );
      return;
    }
    const purchase = {
      productId: selectedPackage.product.identifier,
      plan: selectedPlan,
      source,
      hasTrial,
      price: selectedPackage.product.price,
      currency: selectedPackage.product.currencyCode ?? 'USD',
      variant: copy.variant,
    };

    setLoading(true);
    trackBeginCheckout(purchase);
    try {
      const info = await purchasePackage(selectedPackage);
      if (!info) {
        // User cancelled — silent in the UI by design, but the drop-off between
        // begin_checkout and purchase is exactly what needs explaining.
        track(AnalyticsEvent.PURCHASE_CANCELLED, { source, plan: selectedPlan, variant: copy.variant });
        return;
      }
      purchasedRef.current = true;
      qaCheckpoint('paywall_purchase_success'); // TEMPORARY — QA walkthrough checkpoint
      applyCustomerInfo(info);
      // A fresh purchase is a new reason to ask for an account, even if a
      // past sign-out deferred the wall — see clearAccountDeferred.
      clearAccountDeferred();
      // GA4 dedupes purchases on transaction_id. RevenueCat's JS SDK exposes no
      // store transaction id, so the entitlement's latest purchase timestamp
      // stands in — unique per purchase and per renewal, which is what dedup
      // actually needs.
      const entitlement = info.entitlements.active[PRO_ENTITLEMENT_ID];
      trackPurchase({
        ...purchase,
        transactionId: entitlement
          ? `${entitlement.productIdentifier}:${entitlement.latestPurchaseDate}`
          : undefined,
      });
      if (hasTrial) {
        track(AnalyticsEvent.TRIAL_STARTED, {
          source,
          plan: selectedPlan,
          product_id: purchase.productId,
        });
      }
      // Arm the review prompt. Not shown here — AccountStep comes next and two
      // modals stacked on the highest-intent moment of the funnel loses both.
      // Whichever screen the user lands on afterwards consumes the flag.
      useReviewStore.getState().flagSubscribed();
      // The trial exists as of now, so the recap can be scheduled against it.
      void syncTrialRecap();
      Alert.alert('Welcome to StringAI Pro', 'Live recording and AI coaching are unlocked.', [
        { text: 'Continue', onPress: onPurchased ?? onClose },
      ]);
    } catch (err: any) {
      track(AnalyticsEvent.PURCHASE_FAILED, {
        source,
        plan: selectedPlan,
        reason: errorReason(err),
      });
      Alert.alert('Purchase Failed', err?.message ?? 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  };

  const handleRestore = async () => {
    setLoading(true);
    track(AnalyticsEvent.RESTORE_STARTED, { source });
    try {
      const info = await restorePurchases();
      if (info) applyCustomerInfo(info);
      const restored = info ? isPro(useEntitlementStore.getState().entitlement) : false;
      // Same reasoning as the purchase path — a newly-recovered entitlement is
      // a new reason to ask for an account, even after a past deferral.
      if (restored) clearAccountDeferred();
      track(AnalyticsEvent.RESTORE_RESULT, { source, result: restored ? 'restored' : 'nothing' });
      Alert.alert(
        restored ? 'Purchases Restored' : 'Nothing to Restore',
        restored
          ? 'Your StringAI Pro subscription is active again.'
          : 'We could not find an active subscription for this Apple ID.',
      );
    } catch (err: any) {
      track(AnalyticsEvent.RESTORE_RESULT, {
        source,
        result: 'failed',
        reason: errorReason(err),
      });
      Alert.alert('Restore Failed', err?.message ?? 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.backdrop}>
      {!mandatory && (
        <Pressable style={styles.closeBtn} onPress={onClose}>
          <Text style={styles.closeBtnText}>✕</Text>
        </Pressable>
      )}

      <Animated.View entering={SlideInDown.duration(380)} style={styles.sheet}>
        <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
          <Text style={styles.unlockHeadline}>{copy.headline}</Text>

          {/* What we just measured in their own playing. Drawn from the frozen
              session evidence, so this names the same fault the first drill in
              their plan will work on. Absent when the take was clean or the
              user took the sample path — never invented. */}
          {focusTitle && (
            <View style={styles.focusCard}>
              <Text style={styles.focusLabel}>FROM THE TAKE YOU JUST PLAYED</Text>
              <Text style={styles.focusTitle}>{focusTitle}</Text>
              <Text style={styles.focusBody}>
                {primaryGoal
                  ? `That's where your plan starts — worked into ${primaryGoal.toLowerCase()}, a few minutes a day.`
                  : "That's where your practice plan starts, a few minutes a day."}
              </Text>
            </View>
          )}

          <View style={styles.proBox}>
            <Text style={styles.proBoxTitle}>Everything in StringAI</Text>
            {copy.features.map((f) => (
              <View key={f} style={styles.proRow}>
                <View style={styles.proCheckWrap}>
                  <Ionicons name="checkmark" size={14} color="#fff" />
                </View>
                <Text style={styles.proText}>{f}</Text>
              </View>
            ))}
          </View>

          <View style={styles.plans}>
            <View style={styles.planCardWrap}>
              <Pressable
                style={[styles.planCard, selectedPlan !== 'annual' && styles.planCardDimmed]}
                onPress={() => { selectPlan('annual'); }}
              >
                {selectedPlan === 'annual' && (
                  <View style={styles.planSelectedMark}>
                    <Text style={styles.planSelectedMarkText}>✓</Text>
                  </View>
                )}
                <Text style={styles.planName}>Annual</Text>
                <Text style={[styles.planPrice, selectedPlan === 'annual' && styles.planPriceSelected]}>
                  {formatMonthlyEquivalent(annualNumericPrice)} a month
                </Text>
                <Text style={styles.planPer}>{priceFor('annual')} billed annually</Text>
                {trialDaysFor('annual') !== null && (
                  <Text style={styles.planTrial}>{trialDaysFor('annual')} days free</Text>
                )}
              </Pressable>
              {savingsPct !== null && (
                <View style={styles.savingsSticker}>
                  <Text style={styles.savingsStickerText}>SAVE {savingsPct}%</Text>
                </View>
              )}
            </View>

            <Pressable
              style={[styles.planCard, selectedPlan !== 'monthly' && styles.planCardDimmed]}
              onPress={() => { selectPlan('monthly'); }}
            >
              {selectedPlan === 'monthly' && (
                <View style={styles.planSelectedMark}>
                  <Text style={styles.planSelectedMarkText}>✓</Text>
                </View>
              )}
              <Text style={styles.planName}>Monthly</Text>
              <Text style={[styles.planPrice, selectedPlan === 'monthly' && styles.planPriceSelected]}>
                {priceFor('monthly')}
              </Text>
              <Text style={styles.planPer}>per month</Text>
              {trialDaysFor('monthly') !== null && (
                <Text style={styles.planTrial}>{trialDaysFor('monthly')} days free</Text>
              )}
            </Pressable>
          </View>

          {tutorMultiple !== null && (
            <Text style={styles.tutorAnchor}>
              {tutorMultiple}x cheaper than the average private tutor
            </Text>
          )}

          {/* Spelling out the charge date reads as confidence, not risk — and a
              user who knows exactly when they'll be billed is markedly less
              likely to cancel pre-emptively on day one just to be safe. */}
          {selectedTrialDays !== null && (
            <View style={styles.timeline}>
              <TimelineRow
                icon="lock-open-outline"
                title="Today"
                body="Full access. Every feature, straight away."
              />
              <TimelineRow
                icon="notifications-outline"
                title={`Day ${Math.max(1, selectedTrialDays - 2)}`}
                body="We'll remind you before anything is charged."
              />
              <TimelineRow
                icon="card-outline"
                title={`Day ${selectedTrialDays}`}
                body={`Your ${priceFor(selectedPlan)} subscription begins. Cancel any time before this.`}
                last
              />
            </View>
          )}

          {loading || offeringsLoading ? (
            <ActivityIndicator color={colors.brand[600]} style={styles.spinner} />
          ) : (
            <BigButton
              label={
                selectedTrialDays !== null
                  ? `Start ${selectedTrialDays}-Day Free Trial`
                  : `Get ${selectedPlan === 'annual' ? 'Annual' : 'Monthly'} — ${priceFor(selectedPlan)}`
              }
              onPress={handlePurchase}
            />
          )}

          <Text style={styles.disclaimer}>
            {selectedTrialDays !== null
              ? `${selectedTrialDays} days free, then ${priceFor(selectedPlan)}${selectedPlan === 'annual' ? '/yr' : '/mo'}. Cancel anytime.`
              : 'Cancel anytime · Secure payment via App Store'}
          </Text>

          {/* Who they're actually buying from. True, and a reason to subscribe
              that a funded competitor structurally cannot offer. Remote, so the
              wording can be tested; nullable, so it can be switched off. */}
          {copy.personalNote && (
            <View style={styles.noteCard}>
              <Text style={styles.noteText}>{copy.personalNote}</Text>
            </View>
          )}

          {!mandatory && (
            <Pressable onPress={onClose} style={styles.skipBtn}>
              <Text style={styles.skipText}>Maybe Later</Text>
            </Pressable>
          )}

          <Pressable onPress={handleRestore} disabled={loading} style={styles.restoreBtn}>
            <Text style={styles.restoreText}>Restore purchases</Text>
          </Pressable>

          {/* Restore only recovers a purchase made with the same Apple ID. An
              existing subscriber on a new device — or App Review, whose
              entitlement is granted against a Supabase user id — needs to sign
              in instead, and this is the only screen they can reach. */}
          <Pressable onPress={() => setSignInOpen(true)} style={styles.restoreBtn}>
            <Text style={styles.restoreText}>Already subscribed? Sign in</Text>
          </Pressable>

          <View style={styles.legalRow}>
            <Pressable onPress={() => { Linking.openURL(PRIVACY_POLICY_URL).catch(() => {}); }}>
              <Text style={styles.legalText}>Privacy Policy</Text>
            </Pressable>
            <Text style={styles.legalDivider}>·</Text>
            <Pressable onPress={() => { Linking.openURL(TERMS_OF_SERVICE_URL).catch(() => {}); }}>
              <Text style={styles.legalText}>Terms of Service</Text>
            </Pressable>
          </View>
        </ScrollView>
      </Animated.View>

      <SignInSheet visible={signInOpen} onClose={() => setSignInOpen(false)} />
    </View>
  );
}

/** One step of the trial timeline. */
function TimelineRow({
  icon,
  title,
  body,
  last = false,
}: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  title: string;
  body: string;
  last?: boolean;
}) {
  return (
    <View style={styles.timelineRow}>
      <View style={styles.timelineRail}>
        <View style={styles.timelineDot}>
          <Ionicons name={icon} size={13} color="#fff" />
        </View>
        {!last && <View style={styles.timelineLine} />}
      </View>
      <View style={styles.timelineCopy}>
        <Text style={styles.timelineTitle}>{title}</Text>
        <Text style={styles.timelineBody}>{body}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: colors.brand[600] },

  focusCard: {
    backgroundColor: '#f0f9ff',
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: '#bae6fd',
    padding: spacing.lg,
    gap: 4,
  },
  focusLabel: { fontSize: 10, fontWeight: '800', color: colors.brand[700], letterSpacing: 0.8 },
  focusTitle: { fontSize: 17, fontWeight: '800', color: colors.text.primary },
  focusBody: { fontSize: 13, color: colors.text.secondary, lineHeight: 19 },

  timeline: { gap: 0, paddingHorizontal: spacing.xs },
  timelineRow: { flexDirection: 'row', gap: spacing.md },
  timelineRail: { alignItems: 'center', width: 24 },
  timelineDot: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.brand[600],
    alignItems: 'center',
    justifyContent: 'center',
  },
  timelineLine: { flex: 1, width: 2, backgroundColor: '#e0f2fe', minHeight: 18 },
  timelineCopy: { flex: 1, paddingBottom: spacing.md, gap: 1 },
  timelineTitle: { fontSize: 14, fontWeight: '800', color: colors.text.primary },
  timelineBody: { fontSize: 13, color: colors.text.secondary, lineHeight: 18 },

  noteCard: {
    backgroundColor: '#f9fafb',
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    padding: spacing.lg,
  },
  noteText: {
    fontSize: 13,
    color: colors.text.secondary,
    lineHeight: 20,
    fontStyle: 'italic',
    textAlign: 'center',
  },
  closeBtn: {
    position: 'absolute',
    top: 56,
    right: 20,
    zIndex: 10,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  sheet: {
    flex: 1,
    marginTop: 56,
    backgroundColor: '#fff',
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    overflow: 'hidden',
  },

  scroll: { padding: spacing.xl, paddingBottom: spacing.xxl, gap: spacing.lg },

  unlockHeadline: {
    fontSize: 28,
    fontWeight: '800',
    color: colors.text.primary,
    textAlign: 'center',
    marginTop: spacing.sm,
  },

  proBox: {
    backgroundColor: colors.brand[600],
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderBottomWidth: 4,
    borderBottomColor: colors.brand[800],
    gap: spacing.sm,
  },
  proBoxTitle: { fontSize: 16, fontWeight: '800', color: '#fff', marginBottom: spacing.xs },
  proRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  proCheckWrap: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  proText: { fontSize: 14, fontWeight: '600', color: '#fff', flex: 1, lineHeight: 19 },

  plans: { flexDirection: 'row', gap: spacing.sm },
  planCardWrap: { flex: 1, position: 'relative' },
  savingsSticker: {
    position: 'absolute',
    top: -10,
    right: -6,
    backgroundColor: '#f59e0b',
    borderRadius: radius.full,
    paddingHorizontal: 10,
    paddingVertical: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 3,
    elevation: 3,
  },
  savingsStickerText: { color: '#fff', fontSize: 11, fontWeight: '800', letterSpacing: 0.3 },
  planCard: {
    flex: 1,
    borderRadius: radius.lg,
    borderWidth: 2,
    borderColor: colors.brand[600],
    backgroundColor: '#fff',
    padding: spacing.md,
    alignItems: 'center',
    gap: 4,
    minHeight: 130,
    justifyContent: 'center',
  },
  planCardDimmed: {
    borderColor: '#e5e7eb',
    opacity: 0.7,
  },
  planSelectedMark: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: colors.brand[600],
    alignItems: 'center',
    justifyContent: 'center',
  },
  planSelectedMarkText: { color: '#fff', fontSize: 11, fontWeight: '800' },
  planName: { fontSize: 15, fontWeight: '700', color: colors.text.primary },
  planPrice: { fontSize: 22, fontWeight: '800', color: colors.brand[700] },
  planPriceSelected: { fontWeight: '800' },
  planPer: { fontSize: 11, color: colors.text.muted, textAlign: 'center' },
  planTrial: {
    fontSize: 11,
    fontWeight: '800',
    color: colors.brand[600],
    textAlign: 'center',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },

  tutorAnchor: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.brand[700],
    textAlign: 'center',
  },

  spinner: { marginVertical: spacing.lg },
  disclaimer: { fontSize: 12, color: colors.text.muted, textAlign: 'center' },
  skipBtn: { alignItems: 'center', padding: spacing.sm },
  skipText: { color: colors.text.muted, fontSize: 14, fontWeight: '600' },
  restoreBtn: { alignItems: 'center', paddingVertical: spacing.xs },
  restoreText: { fontSize: 15, color: colors.brand[600], fontWeight: '700' },
  legalRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: spacing.sm,
    gap: spacing.xs,
  },
  legalText: { fontSize: 12, color: colors.text.muted },
  legalDivider: { fontSize: 12, color: colors.text.muted },
});
