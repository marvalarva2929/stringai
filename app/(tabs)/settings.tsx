import React from 'react';
import {
  ScrollView,
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  Pressable,
  Alert,
  Linking,
} from 'react-native';
import { Ionicons, Octicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useUserStore } from '../../src/store/useUserStore';
import { useAuthStore } from '../../src/store/useAuthStore';
import { useEntitlementStore } from '../../src/store/useEntitlementStore';
import { useReminderStore } from '../../src/store/useReminderStore';
import {
  FREE_DAILY_ANALYSES,
  analysesRemaining,
  isPro,
  trialDaysRemaining,
} from '../../src/lib/entitlements';
import { MANAGE_SUBSCRIPTION_URL, restorePurchases } from '../../src/services/purchases';
import { signOut, deleteAccount } from '../../src/services/auth';
import { Card } from '../../src/components/ui/Card';
import { Button } from '../../src/components/ui/Button';
import { colors, spacing, radius } from '../../src/constants/theme';
import { INSTRUMENTS } from '../../src/constants/instruments';
import { PRIVACY_POLICY_URL, TERMS_OF_SERVICE_URL, SUPPORT_URL } from '../../src/constants/links';

interface SettingsRowProps {
  label: string;
  value?: string;
  onPress?: () => void;
  destructive?: boolean;
  icon?: React.ReactNode;
}

function SettingsRow({ label, value, onPress, destructive, icon }: SettingsRowProps) {
  return (
    <Pressable style={styles.row} onPress={onPress} disabled={!onPress}>
      {icon && (
        typeof icon === 'string'
          ? <Text style={styles.rowIcon}>{icon}</Text>
          : <View style={styles.rowIconWrap}>{icon}</View>
      )}
      <Text style={[styles.rowLabel, destructive && styles.destructiveLabel]}>{label}</Text>
      {value && <Text style={styles.rowValue}>{value}</Text>}
      {onPress && !destructive && <Text style={styles.rowArrow}>›</Text>}
    </Pressable>
  );
}

export default function SettingsScreen() {
  const { profile } = useUserStore();
  const { isAuthenticated, signOut: clearAuth } = useAuthStore();
  const { entitlement, applyCustomerInfo } = useEntitlementStore();
  const { enabled: remindersEnabled, hour: reminderHour, minute: reminderMinute } = useReminderStore();

  const reminderValue = remindersEnabled
    ? new Date(2000, 0, 1, reminderHour, reminderMinute).toLocaleTimeString(undefined, {
        hour: 'numeric',
        minute: '2-digit',
      })
    : 'Off';

  const instrumentName = profile?.instrument
    ? INSTRUMENTS[profile.instrument]?.displayName ?? profile.instrument
    : 'Violin';

  const pro = isPro(entitlement);

  const tierLabel = !pro
    ? `Free (${analysesRemaining(entitlement)} of ${FREE_DAILY_ANALYSES} today)`
    : entitlement.inTrial
      ? `Pro — trial, ${trialDaysRemaining(entitlement)} day${trialDaysRemaining(entitlement) === 1 ? '' : 's'} left`
      : entitlement.expiresAt
        ? `Pro — renews ${new Date(entitlement.expiresAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
        : 'Pro';

  const handleRestore = async () => {
    try {
      const info = await restorePurchases();
      if (info) applyCustomerInfo(info);
      Alert.alert(
        isPro(useEntitlementStore.getState().entitlement) ? 'Purchases Restored' : 'Nothing to Restore',
        isPro(useEntitlementStore.getState().entitlement)
          ? 'Your StringAI Pro subscription is active again.'
          : 'We could not find an active subscription for this Apple ID.',
      );
    } catch (err: any) {
      Alert.alert('Restore Failed', err?.message ?? 'Something went wrong.');
    }
  };

  const handleSignOut = () => {
    Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign Out',
        style: 'destructive',
        onPress: async () => {
          try {
            await signOut();
          } catch {}
          clearAuth();
          router.replace('/(auth)/login');
        },
      },
    ]);
  };

  const handleDeleteAccount = () => {
    Alert.alert(
      'Delete Account',
      'This permanently deletes your account and all of your saved sessions and progress. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete Account',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteAccount();
            } catch (err: any) {
              Alert.alert(
                'Could Not Delete Account',
                err?.message ?? 'Something went wrong. Please try again or contact support.',
              );
              return;
            }
            clearAuth();
            router.replace('/(auth)/login');
          },
        },
      ],
    );
  };

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <Text style={styles.title}>Settings</Text>
        {profile?.email && <Text style={styles.email}>{profile.email}</Text>}
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {/* Guest sign-in prompt */}
        {!isAuthenticated && (
          <Pressable onPress={() => router.push('/(auth)/login')} style={styles.signInCard}>
            <Text style={styles.signInTitle}>Sign in to save your progress</Text>
            <Text style={styles.signInSub}>Your analyses are stored locally. Sign in to back them up and access them on any device.</Text>
            <Text style={styles.signInLink}>Sign In / Create Account →</Text>
          </Pressable>
        )}

        {/* Account section */}
        <Text style={styles.sectionHeader}>Account</Text>
        <Card padded={false} style={styles.section}>
          <SettingsRow icon={<Ionicons name="mail" size={18} color={colors.muted} />} label="Email" value={profile?.email ?? '—'} />
          <View style={styles.divider} />
          <SettingsRow icon={<Ionicons name="musical-notes" size={18} color={colors.muted} />} label="Instrument" value={instrumentName} />
          <View style={styles.divider} />
          <SettingsRow
            icon={<Ionicons name="flag" size={18} color={colors.muted} />}
            label="Skill Level"
            value={profile?.skillLevel
              ? profile.skillLevel.charAt(0).toUpperCase() + profile.skillLevel.slice(1)
              : '—'}
          />
        </Card>

        {/* Subscription section */}
        <Text style={styles.sectionHeader}>Subscription</Text>
        <Card padded={false} style={styles.section}>
          <SettingsRow icon={<Octicons name="star-fill" size={18} color="#f59e0b" />} label="Current Plan" value={tierLabel} />
          {!pro && (
            <>
              <View style={styles.divider} />
              <SettingsRow
                icon="🚀"
                label="Upgrade to Pro"
                onPress={() => router.push('/paywall')}
              />
            </>
          )}
          {pro && (
            <>
              <View style={styles.divider} />
              <SettingsRow
                icon="🚀"
                label="Manage Subscription"
                onPress={() => { Linking.openURL(MANAGE_SUBSCRIPTION_URL).catch(() => {}); }}
              />
            </>
          )}
          {/* App Store review requires a restore path that is reachable without
              purchasing, so this row is always present. */}
          <View style={styles.divider} />
          <SettingsRow icon="🔄" label="Restore Purchases" onPress={handleRestore} />
        </Card>

        {/* App section */}
        <Text style={styles.sectionHeader}>App</Text>
        <Card padded={false} style={styles.section}>
          <SettingsRow
            icon="🔔"
            label="Practice Reminders"
            value={reminderValue}
            onPress={() => router.push('/reminders')}
          />
          <View style={styles.divider} />
          <SettingsRow
            icon="💬"
            label="Help & Support"
            onPress={() => { Linking.openURL(SUPPORT_URL).catch(() => {}); }}
          />
          <View style={styles.divider} />
          <SettingsRow
            icon="🔒"
            label="Privacy Policy"
            onPress={() => { Linking.openURL(PRIVACY_POLICY_URL).catch(() => {}); }}
          />
          <View style={styles.divider} />
          <SettingsRow
            icon="📄"
            label="Terms of Service"
            onPress={() => { Linking.openURL(TERMS_OF_SERVICE_URL).catch(() => {}); }}
          />
        </Card>

        {/* Account deletion — App Store Guideline 5.1.1(v). Only shown to signed-in
            users; a guest has no server-side account to delete. */}
        {isAuthenticated && (
          <Card padded={false} style={styles.section}>
            <SettingsRow
              icon="🗑️"
              label="Delete Account"
              destructive
              onPress={handleDeleteAccount}
            />
          </Card>
        )}

        {/* Sign out — only meaningful for a signed-in user; a guest has no
            session to end. */}
        {isAuthenticated && (
          <Button
            label="Sign Out"
            onPress={handleSignOut}
            variant="outline"
            fullWidth
            size="md"
          />
        )}

        {__DEV__ && (
          <>
            <Text style={styles.sectionHeader}>Developer</Text>
            <Card padded={false} style={styles.section}>
              <SettingsRow
                icon="🔧"
                label="Audio Analysis Debug"
                onPress={() => router.push('/debug')}
              />
            </Card>
          </>
        )}

        <Text style={styles.version}>StringAI v1.0.0</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  header: {
    paddingTop: 20, paddingBottom: spacing.xl, paddingHorizontal: spacing.xl,
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e5e7eb',
  },
  title: { fontSize: 24, fontWeight: '700', color: colors.text.primary },
  email: { fontSize: 13, color: colors.text.muted, marginTop: 4 },
  content: { padding: spacing.lg, gap: spacing.sm },
  sectionHeader: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.text.muted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: spacing.sm,
    marginBottom: 4,
    marginLeft: 4,
  },
  section: { overflow: 'hidden' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: 14,
  },
  rowIcon: { fontSize: 16, width: 28, textAlign: 'center', marginRight: 2 },
  rowIconWrap: { width: 28, alignItems: 'center' as const, marginRight: 2 },
  rowLabel: { flex: 1, fontSize: 15, color: colors.text.primary },
  rowValue: { fontSize: 14, color: colors.text.muted, marginRight: spacing.xs },
  rowArrow: { fontSize: 18, color: colors.text.muted },
  destructiveLabel: { color: '#ef4444' },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: '#e5e7eb', marginLeft: spacing.md },
  version: { textAlign: 'center', fontSize: 12, color: colors.text.muted, marginTop: spacing.md },
  signInCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    gap: 4,
  },
  signInTitle: { fontSize: 15, fontWeight: '700', color: colors.text.primary },
  signInSub: { fontSize: 13, color: colors.text.secondary, lineHeight: 18 },
  signInLink: { fontSize: 13, fontWeight: '700', color: colors.brand[600], marginTop: 4 },
});
