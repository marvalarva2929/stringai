import React, { useEffect, useMemo, useState } from 'react';
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
  getCurrentOffering,
  isPurchasesConfigured,
  purchasePackage,
  restorePurchases,
} from '../../services/purchases';
import { useEntitlementStore } from '../../store/useEntitlementStore';
import { FREE_DAILY_ANALYSES, isPro } from '../../lib/entitlements';
import { PRIVACY_POLICY_URL, TERMS_OF_SERVICE_URL } from '../../constants/links';

type Plan = 'monthly' | 'annual';

const FALLBACK_MONTHLY_PRICE = 9.99;
const FALLBACK_ANNUAL_PRICE = 59.99;

// A private violin lesson runs roughly $50/hr; a typical weekly-lesson
// student pays for ~4 lessons a month. Used only to anchor the price against
// a familiar alternative, not billed anywhere.
const AVERAGE_TUTOR_MONTHLY_COST = 200;

const FREE_FEATURES: string[] = [
  `${FREE_DAILY_ANALYSES} analyses per day`,
  'Static coaching feedback',
  'Session history & progress tracking',
];

const PRO_FEATURES: string[] = [
  'Live camera recording with real-time feedback',
  'Personal AI coaching from Claude after every session',
  'Unlimited analyses — no daily limit',
];

// $59.99/yr -> "$5" (whole dollars round cleanly; anything else keeps cents).
function formatMonthlyEquivalent(annualPrice: number): string {
  const perMonth = Math.round((annualPrice / 12) * 100) / 100;
  return Number.isInteger(perMonth) ? `$${perMonth}` : `$${perMonth.toFixed(2)}`;
}

interface PaywallViewProps {
  /** Close button (✕) action. */
  onClose: () => void;
  /** Called when the success alert's button is pressed. Defaults to onClose. */
  onPurchased?: () => void;
}

// The single Pro subscription screen — a blue backdrop with a white sheet
// that slides up from the bottom. Shared by app/paywall.tsx (pushed as a
// modal from every in-app gate) and the onboarding Pro step, so both look
// and behave identically.
export function PaywallView({ onClose, onPurchased }: PaywallViewProps) {
  const [selectedPlan, setSelectedPlan] = useState<Plan>('annual');
  const [loading, setLoading] = useState(false);
  const [packages, setPackages] = useState<{ monthly?: PurchasesPackage; annual?: PurchasesPackage }>({});
  const [offeringsLoading, setOfferingsLoading] = useState(true);

  const { applyCustomerInfo } = useEntitlementStore();

  useEffect(() => {
    let cancelled = false;
    getCurrentOffering()
      .then((offering) => {
        if (cancelled || !offering) return;
        setPackages({ monthly: offering.monthly ?? undefined, annual: offering.annual ?? undefined });
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setOfferingsLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const selectedPackage = selectedPlan === 'annual' ? packages.annual : packages.monthly;
  const priceFor = (plan: Plan) => {
    const pkg = plan === 'annual' ? packages.annual : packages.monthly;
    return pkg?.product.priceString ?? (plan === 'annual' ? '$59.99' : '$9.99');
  };
  const monthlyNumericPrice = packages.monthly?.product.price ?? FALLBACK_MONTHLY_PRICE;
  const annualNumericPrice = packages.annual?.product.price ?? FALLBACK_ANNUAL_PRICE;
  const hasTrial = !!selectedPackage?.product.introPrice;

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

  const handlePurchase = async () => {
    if (!selectedPackage) {
      Alert.alert(
        'Unavailable',
        isPurchasesConfigured
          ? 'Subscriptions are still loading. Please try again in a moment.'
          : 'Subscriptions are not available on this build.',
      );
      return;
    }
    setLoading(true);
    try {
      const info = await purchasePackage(selectedPackage);
      if (!info) return; // user cancelled — say nothing
      applyCustomerInfo(info);
      Alert.alert('Welcome to StringAI Pro', 'Live recording and AI coaching are unlocked.', [
        { text: 'Continue', onPress: onPurchased ?? onClose },
      ]);
    } catch (err: any) {
      Alert.alert('Purchase Failed', err?.message ?? 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  };

  const handleRestore = async () => {
    setLoading(true);
    try {
      const info = await restorePurchases();
      if (info) applyCustomerInfo(info);
      const restored = info ? isPro(useEntitlementStore.getState().entitlement) : false;
      Alert.alert(
        restored ? 'Purchases Restored' : 'Nothing to Restore',
        restored
          ? 'Your StringAI Pro subscription is active again.'
          : 'We could not find an active subscription for this Apple ID.',
      );
    } catch (err: any) {
      Alert.alert('Restore Failed', err?.message ?? 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.backdrop}>
      <Pressable style={styles.closeBtn} onPress={onClose}>
        <Text style={styles.closeBtnText}>✕</Text>
      </Pressable>

      <Animated.View entering={SlideInDown.duration(380)} style={styles.sheet}>
        <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
          <Text style={styles.unlockHeadline}>Unlock More Features</Text>

          <View style={styles.freeSection}>
            <Text style={styles.freeIntro}>Your free features include:</Text>
            {FREE_FEATURES.map((f) => (
              <View key={f} style={styles.freeRow}>
                <Ionicons name="checkmark" size={16} color={colors.brand[600]} />
                <Text style={styles.freeText}>{f}</Text>
              </View>
            ))}
          </View>

          <Text style={styles.proHeadline}>Get StringAI Pro</Text>

          <View style={styles.proBox}>
            <Text style={styles.proBoxTitle}>Features with StringAI Pro</Text>
            {PRO_FEATURES.map((f) => (
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
                onPress={() => setSelectedPlan('annual')}
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
              </Pressable>
              {savingsPct !== null && (
                <View style={styles.savingsSticker}>
                  <Text style={styles.savingsStickerText}>SAVE {savingsPct}%</Text>
                </View>
              )}
            </View>

            <Pressable
              style={[styles.planCard, selectedPlan !== 'monthly' && styles.planCardDimmed]}
              onPress={() => setSelectedPlan('monthly')}
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
            </Pressable>
          </View>

          {tutorMultiple !== null && (
            <Text style={styles.tutorAnchor}>
              {tutorMultiple}x cheaper than the average private tutor
            </Text>
          )}

          {loading || offeringsLoading ? (
            <ActivityIndicator color={colors.brand[600]} style={styles.spinner} />
          ) : (
            <BigButton
              label={
                hasTrial
                  ? 'Start 7-Day Free Trial'
                  : `Get ${selectedPlan === 'annual' ? 'Annual' : 'Monthly'} — ${priceFor(selectedPlan)}`
              }
              onPress={handlePurchase}
            />
          )}

          <Text style={styles.disclaimer}>
            {hasTrial
              ? `7 days free, then ${priceFor(selectedPlan)}${selectedPlan === 'annual' ? '/yr' : '/mo'}. Cancel anytime.`
              : 'Cancel anytime · Secure payment via App Store'}
          </Text>

          <Pressable onPress={onClose} style={styles.skipBtn}>
            <Text style={styles.skipText}>Maybe Later</Text>
          </Pressable>

          <Pressable onPress={handleRestore} disabled={loading} style={styles.restoreBtn}>
            <Text style={styles.restoreText}>Restore purchases</Text>
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
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: colors.brand[600] },
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

  freeSection: { gap: spacing.xs },
  freeIntro: { fontSize: 14, fontWeight: '600', color: colors.text.secondary, marginBottom: 2 },
  freeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  freeText: { fontSize: 14, color: colors.text.primary },

  proHeadline: {
    fontSize: 24,
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
  restoreBtn: { alignItems: 'center' },
  restoreText: { fontSize: 13, color: colors.brand[600], fontWeight: '500' },
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
