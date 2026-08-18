import React, { useState } from 'react';
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
import { isPro, trialDaysRemaining } from '../../src/lib/entitlements';
import { MANAGE_SUBSCRIPTION_URL, restorePurchases } from '../../src/services/purchases';
import { signOut, deleteAccount } from '../../src/services/auth';
import { Card } from '../../src/components/ui/Card';
import { Button } from '../../src/components/ui/Button';
import { colors, spacing, radius } from '../../src/constants/theme';
import { INSTRUMENTS } from '../../src/constants/instruments';
import { PRIVACY_POLICY_URL, TERMS_OF_SERVICE_URL, SUPPORT_URL } from '../../src/constants/links';
import { track } from '../../src/services/analytics';
import { AnalyticsEvent } from '../../src/constants/analyticsEvents';
import { errorReason } from '../../src/lib/analyticsUserProps';
import { useTechniqueSkillStore } from '../../src/store/useTechniqueSkillStore';
import { haptic } from '../../src/lib/haptics';
import { FeedbackSheet } from '../../src/components/ui/FeedbackSheet';

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
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const { profile } = useUserStore();
  const thirdPosition = useTechniqueSkillStore((st) => st.thirdPosition);
  const setThirdPosition = useTechniqueSkillStore((st) => st.setThirdPosition);
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

  // Reaching Settings at all means an active subscription — the gate is the
  // only way in. The `!pro` label is for the seconds between an expiry landing
  // and the gate mounting over the app.
  const tierLabel = !pro
    ? 'Inactive'
    : entitlement.inTrial
      ? `Trial — ${trialDaysRemaining(entitlement)} day${trialDaysRemaining(entitlement) === 1 ? '' : 's'} left`
      : entitlement.expiresAt
        ? `Renews ${new Date(entitlement.expiresAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
        : 'Active';

  const handleRestore = async () => {
    track(AnalyticsEvent.RESTORE_STARTED, { source: 'settings' });
    try {
      const info = await restorePurchases();
      if (info) applyCustomerInfo(info);
      const restored = isPro(useEntitlementStore.getState().entitlement);
      track(AnalyticsEvent.RESTORE_RESULT, {
        source: 'settings',
        result: restored ? 'restored' : 'nothing',
      });
      Alert.alert(
        restored ? 'Purchases Restored' : 'Nothing to Restore',
        restored
          ? 'Your StringAI Pro subscription is active again.'
          : 'We could not find an active subscription for this Apple ID.',
      );
    } catch (err: any) {
      track(AnalyticsEvent.RESTORE_RESULT, {
        source: 'settings',
        result: 'failed',
        reason: errorReason(err),
      });
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
          {pro && (
            <>
              <View style={styles.divider} />
              <SettingsRow
                icon="🚀"
                label="Manage Subscription"
                onPress={() => {
                  // The last click before a cancellation — a leading churn signal
                  // that arrives days before RevenueCat reports the expiry.
                  track(AnalyticsEvent.MANAGE_SUBSCRIPTION_OPEN);
                  Linking.openURL(MANAGE_SUBSCRIPTION_URL).catch(() => {});
                }}
              />
            </>
          )}
          {/* App Store review requires a restore path that is reachable without
              purchasing, so this row is always present. */}
          <View style={styles.divider} />
          <SettingsRow icon="🔄" label="Restore Purchases" onPress={handleRestore} />
        </Card>

        {/* Technique section — what the app may ask you to play */}
        <Text style={styles.sectionHeader}>Technique</Text>
        <Card padded={false} style={styles.section}>
          <SettingsRow
            icon={<Ionicons name="hand-left" size={18} color={colors.muted} />}
            label="3rd position"
            value={
              thirdPosition === 'yes' ? 'I can shift'
              : thirdPosition === 'no' ? '1st position only'
              : 'Not set'
            }
            onPress={() => {
              // Exercises stay in first position unless this says otherwise, so
              // the toggle is the one that expands what the app will generate.
              setThirdPosition(thirdPosition === 'yes' ? 'no' : 'yes');
              haptic.light();
            }}
          />
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
            icon="🆕"
            label="What's New"
            onPress={() => router.push('/changelog')}
          />
          <View style={styles.divider} />
          <SettingsRow
            icon="✉️"
            label="Send Feedback"
            value="Straight to the developer"
            onPress={() => { haptic.light(); setFeedbackOpen(true); }}
          />
          <View style={styles.divider} />
          <SettingsRow
            icon="💬"
            label="Help & Support"
            onPress={() => {
              track(AnalyticsEvent.SUPPORT_LINK_OPEN, { target: 'support' });
              Linking.openURL(SUPPORT_URL).catch(() => {});
            }}
          />
          <View style={styles.divider} />
          <SettingsRow
            icon="🔒"
            label="Privacy Policy"
            onPress={() => {
              track(AnalyticsEvent.SUPPORT_LINK_OPEN, { target: 'privacy' });
              Linking.openURL(PRIVACY_POLICY_URL).catch(() => {});
            }}
          />
          <View style={styles.divider} />
          <SettingsRow
            icon="📄"
            label="Terms of Service"
            onPress={() => {
              track(AnalyticsEvent.SUPPORT_LINK_OPEN, { target: 'terms' });
              Linking.openURL(TERMS_OF_SERVICE_URL).catch(() => {});
            }}
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

      <FeedbackSheet visible={feedbackOpen} onClose={() => setFeedbackOpen(false)} />
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
