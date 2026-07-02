import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  Pressable,
  ScrollView,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { colors, spacing, radius } from '../src/constants/theme';
import { Button } from '../src/components/ui/Button';

type Plan = 'monthly' | 'annual';

const FEATURES = [
  'Unlimited analyses',
  'Full session history',
  '13 detailed metrics',
  'Progress charts & milestones',
  'Bow & posture video analysis',
  'Personalized practice tips',
];

export default function Paywall() {
  const [selectedPlan, setSelectedPlan] = useState<Plan>('annual');
  const [loading, setLoading] = useState(false);

  const handlePurchase = async () => {
    setLoading(true);
    try {
      // TODO: integrate RevenueCat Purchases.purchasePackage()
      await new Promise((r) => setTimeout(r, 1500)); // stub
      Alert.alert('Purchase Successful', 'Welcome to StringAI Pro!', [
        { text: 'Start Playing', onPress: () => router.back() },
      ]);
    } catch (err: any) {
      if (err.userCancelled) return;
      Alert.alert('Purchase Failed', err.message ?? 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  };

  const handleRestore = async () => {
    // TODO: RevenueCat Purchases.restorePurchases()
    Alert.alert('Restored', 'Your purchases have been restored.');
  };

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {/* Close button */}
        <Pressable style={styles.closeBtn} onPress={() => router.back()}>
          <Text style={styles.closeBtnText}>✕</Text>
        </Pressable>

        {/* Header */}
        <LinearGradient
          colors={[colors.brand[900], colors.brand[600]]}
          style={styles.heroGradient}
        >
          <Text style={styles.heroEmoji}>🎻</Text>
          <Text style={styles.heroTitle}>StringAI Pro</Text>
          <Text style={styles.heroSubtitle}>
            Unlimited feedback. Real improvement.
          </Text>
        </LinearGradient>

        <View style={styles.content}>
          {/* Feature list */}
          <View style={styles.features}>
            {FEATURES.map((f) => (
              <View key={f} style={styles.featureRow}>
                <View style={styles.featureCheck}>
                  <Text style={styles.featureCheckText}>✓</Text>
                </View>
                <Text style={styles.feature}>{f}</Text>
              </View>
            ))}
          </View>

          {/* Plan picker */}
          <View style={styles.plans}>
            <Pressable
              style={[styles.planCard, selectedPlan !== 'annual' && styles.planCardDimmed]}
              onPress={() => setSelectedPlan('annual')}
            >
              <View style={[styles.planCardInner, selectedPlan === 'annual' && styles.planCardInnerSelected]}>
                {selectedPlan === 'annual' && (
                  <View style={styles.planSelectedMark}>
                    <Text style={styles.planSelectedMarkText}>✓</Text>
                  </View>
                )}
                <View style={styles.planBadge}>
                  <Text style={styles.planBadgeText}>Best Value</Text>
                </View>
                <Text style={styles.planName}>Annual</Text>
                <Text style={[styles.planPrice, selectedPlan === 'annual' && styles.planPriceSelected]}>$59.99</Text>
                <Text style={styles.planPer}>per year — just $5/mo</Text>
              </View>
            </Pressable>

            <Pressable
              style={[styles.planCard, selectedPlan !== 'monthly' && styles.planCardDimmed]}
              onPress={() => setSelectedPlan('monthly')}
            >
              <View style={[styles.planCardInner, selectedPlan === 'monthly' && styles.planCardInnerSelected]}>
                {selectedPlan === 'monthly' && (
                  <View style={styles.planSelectedMark}>
                    <Text style={styles.planSelectedMarkText}>✓</Text>
                  </View>
                )}
                <Text style={styles.planName}>Monthly</Text>
                <Text style={[styles.planPrice, selectedPlan === 'monthly' && styles.planPriceSelected]}>$9.99</Text>
                <Text style={styles.planPer}>per month</Text>
              </View>
            </Pressable>
          </View>

          {/* CTA */}
          {loading ? (
            <ActivityIndicator color={colors.brand[600]} style={{ marginVertical: spacing.lg }} />
          ) : (
            <Button
              label={selectedPlan === 'annual' ? 'Get Annual — $59.99/yr' : 'Get Monthly — $9.99/mo'}
              onPress={handlePurchase}
              size="lg"
              fullWidth
            />
          )}

          <Text style={styles.cancelText}>Cancel anytime · Secure payment via App Store</Text>

          <Pressable onPress={handleRestore} style={styles.restoreBtn}>
            <Text style={styles.restoreText}>Restore purchases</Text>
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  scroll: { flexGrow: 1 },
  closeBtn: {
    position: 'absolute',
    top: 16,
    right: 16,
    zIndex: 10,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(0,0,0,0.3)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  heroGradient: {
    paddingTop: 48,
    paddingBottom: spacing.xxl,
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
  },
  heroEmoji: { fontSize: 56, marginBottom: spacing.md },
  heroTitle: { fontSize: 30, fontWeight: '800', color: '#fff' },
  heroSubtitle: { fontSize: 15, color: 'rgba(255,255,255,0.75)', marginTop: spacing.sm, textAlign: 'center' },
  content: { padding: spacing.xl, gap: spacing.lg },
  features: { gap: 10 },
  featureRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  featureCheck: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: colors.brand[100],
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
    flexShrink: 0,
  },
  featureCheckText: { color: colors.brand[600], fontSize: 12, fontWeight: '800' },
  feature: { fontSize: 15, color: colors.text.primary, lineHeight: 22, flex: 1 },
  plans: { flexDirection: 'row', gap: spacing.sm },
  planCard: {
    flex: 1,
    borderRadius: radius.lg,
    borderWidth: 2,
    borderColor: colors.brand[600],
    overflow: 'hidden',
  },
  planCardDimmed: {
    borderColor: '#e5e7eb',
    opacity: 0.7,
  },
  planCardInner: {
    padding: spacing.md,
    backgroundColor: '#fff',
    alignItems: 'center',
    gap: 4,
    minHeight: 130,
    justifyContent: 'center',
  },
  planCardInnerSelected: {
    backgroundColor: colors.brand[50],
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
  planPriceSelected: { fontWeight: '800' },
  planBadge: {
    backgroundColor: colors.brand[600],
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginBottom: 4,
  },
  planBadgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  planName: { fontSize: 15, fontWeight: '700', color: colors.text.primary },
  planPrice: { fontSize: 24, fontWeight: '800', color: colors.brand[700] },
  planPer: { fontSize: 11, color: colors.text.muted, textAlign: 'center' },
  cancelText: { fontSize: 12, color: colors.text.muted, textAlign: 'center' },
  restoreBtn: { alignItems: 'center' },
  restoreText: { fontSize: 13, color: colors.brand[600], fontWeight: '500' },
});
