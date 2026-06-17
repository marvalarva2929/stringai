import React from 'react';
import {
  ScrollView,
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  Pressable,
  Alert,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useUserStore } from '../../src/store/useUserStore';
import { useAuthStore } from '../../src/store/useAuthStore';
import { signOut } from '../../src/services/auth';
import { Card } from '../../src/components/ui/Card';
import { Button } from '../../src/components/ui/Button';
import { colors, spacing, radius } from '../../src/constants/theme';
import { INSTRUMENTS } from '../../src/constants/instruments';

interface SettingsRowProps {
  label: string;
  value?: string;
  onPress?: () => void;
  destructive?: boolean;
}

function SettingsRow({ label, value, onPress, destructive }: SettingsRowProps) {
  return (
    <Pressable style={styles.row} onPress={onPress} disabled={!onPress}>
      <Text style={[styles.rowLabel, destructive && styles.destructiveLabel]}>{label}</Text>
      {value && <Text style={styles.rowValue}>{value}</Text>}
      {onPress && !destructive && <Text style={styles.rowArrow}>›</Text>}
    </Pressable>
  );
}

export default function SettingsScreen() {
  const { profile } = useUserStore();
  const { isAuthenticated, signOut: clearAuth } = useAuthStore();

  const instrumentName = profile?.instrument
    ? INSTRUMENTS[profile.instrument]?.displayName ?? profile.instrument
    : 'Violin';

  const tierLabel =
    profile?.subscriptionTier === 'monthly' ? 'Monthly ($9.99/mo)'
    : profile?.subscriptionTier === 'annual' ? 'Annual ($59.99/yr)'
    : `Free (${2 - (profile?.freeAnalysesUsed ?? 0)} analyses left)`;

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

  return (
    <SafeAreaView style={styles.safe}>
      <LinearGradient colors={[colors.brand[900], colors.brand[800]]} style={styles.header}>
        <Text style={styles.title}>Settings</Text>
        {profile?.email && <Text style={styles.email}>{profile.email}</Text>}
      </LinearGradient>

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
          <SettingsRow label="Email" value={profile?.email ?? '—'} />
          <View style={styles.divider} />
          <SettingsRow label="Instrument" value={instrumentName} />
          <View style={styles.divider} />
          <SettingsRow
            label="Skill Level"
            value={profile?.skillLevel
              ? profile.skillLevel.charAt(0).toUpperCase() + profile.skillLevel.slice(1)
              : '—'}
          />
        </Card>

        {/* Subscription section */}
        <Text style={styles.sectionHeader}>Subscription</Text>
        <Card padded={false} style={styles.section}>
          <SettingsRow label="Current Plan" value={tierLabel} />
          {profile?.subscriptionTier === 'free' && (
            <>
              <View style={styles.divider} />
              <SettingsRow
                label="Upgrade to Pro"
                onPress={() => router.push('/paywall')}
              />
            </>
          )}
          {profile?.subscriptionTier !== 'free' && (
            <>
              <View style={styles.divider} />
              <SettingsRow label="Manage Subscription" onPress={() => {
                // TODO: open RevenueCat customer center or App Store subscription management
                Alert.alert('Manage Subscription', 'Visit Settings > Apple ID > Subscriptions on your device.');
              }} />
            </>
          )}
        </Card>

        {/* App section */}
        <Text style={styles.sectionHeader}>App</Text>
        <Card padded={false} style={styles.section}>
          <SettingsRow label="Practice Reminders" onPress={() => {
            Alert.alert('Coming soon', 'Push notification reminders will be available in a future update.');
          }} />
          <View style={styles.divider} />
          <SettingsRow label="Privacy Policy" onPress={() => {}} />
          <View style={styles.divider} />
          <SettingsRow label="Terms of Service" onPress={() => {}} />
        </Card>

        {/* Sign out */}
        <Button
          label="Sign Out"
          onPress={handleSignOut}
          variant="outline"
          fullWidth
          size="md"
        />

        {__DEV__ && (
          <>
            <Text style={styles.sectionHeader}>Developer</Text>
            <Card padded={false} style={styles.section}>
              <SettingsRow
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
  header: { paddingTop: 20, paddingBottom: spacing.xl, paddingHorizontal: spacing.xl },
  title: { fontSize: 24, fontWeight: '700', color: '#fff' },
  email: { fontSize: 13, color: 'rgba(255,255,255,0.6)', marginTop: 4 },
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
  rowLabel: { flex: 1, fontSize: 15, color: colors.text.primary },
  rowValue: { fontSize: 14, color: colors.text.muted, marginRight: spacing.xs },
  rowArrow: { fontSize: 18, color: colors.text.muted },
  destructiveLabel: { color: '#ef4444' },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: '#f0eeff', marginLeft: spacing.md },
  version: { textAlign: 'center', fontSize: 12, color: colors.text.muted, marginTop: spacing.md },
  signInCard: {
    backgroundColor: colors.brand[50],
    borderRadius: radius.lg,
    padding: spacing.md,
    borderWidth: 1.5,
    borderColor: colors.brand[200],
    gap: 4,
  },
  signInTitle: { fontSize: 15, fontWeight: '700', color: colors.brand[800] },
  signInSub: { fontSize: 13, color: colors.brand[700], lineHeight: 18 },
  signInLink: { fontSize: 13, fontWeight: '700', color: colors.brand[600], marginTop: 4 },
});
