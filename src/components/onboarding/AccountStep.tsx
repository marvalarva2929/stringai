import React, { useState } from 'react';
import { View, Text, TextInput, StyleSheet, Alert, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, spacing } from '../../constants/theme';
import { STEP_COPY } from '../../constants/onboardingContent';
import { signUp } from '../../services/auth';
import { track, trackSignUp } from '../../services/analytics';
import { AnalyticsEvent } from '../../constants/analyticsEvents';
import { errorReason } from '../../lib/analyticsUserProps';
import { Button } from '../ui/Button';
import { OAuthButtons } from '../auth/OAuthButtons';
import { haptic } from '../../lib/haptics';

interface AccountStepProps {
  /** Called once an authenticated session exists right after signup. */
  onCreated: (userId: string) => void;
  /**
   * Signup succeeded but email confirmation is required, so there is no session
   * yet. The user has already paid at this point, so they are let into the app
   * and sign in from Settings once the mail arrives — see `accountDeferred` in
   * useAuthStore. Holding them here would wall a paying customer behind a
   * message that may never be delivered.
   */
  onConfirmationSent: () => void;
}

// An account is required: the app is subscription-only and the server gates
// coaching on profiles.entitlement, so a user with no profile row would end up
// paying for a degraded app. There is deliberately no skip.
//
// Rendered by AccountGate, immediately after the purchase. It used to be the
// last step of onboarding, where it sat between the user and everything the
// app does; see AccountGate for why it moved.
export function AccountStep({ onCreated, onConfirmationSent }: AccountStepProps) {
  const insets = useSafeAreaInsets();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [confirmNote, setConfirmNote] = useState(false);

  const handleCreate = async () => {
    if (!email || !password) return;
    if (password.length < 8) {
      Alert.alert('Weak password', 'Password must be at least 8 characters.');
      return;
    }
    haptic.light();
    setLoading(true);
    try {
      const data = await signUp(email.trim(), password);
      trackSignUp('email');
      if (data.session && data.user) {
        onCreated(data.user.id);
      } else {
        // Email confirmation required — don't block onboarding completion.
        setConfirmNote(true);
      }
    } catch (err: any) {
      track(AnalyticsEvent.AUTH_FAILED, {
        stage: 'sign_up',
        method: 'email',
        reason: errorReason(err),
      });
      Alert.alert('Registration Failed', err.message ?? 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={[styles.container, { paddingTop: insets.top + spacing.xl }]}
      showsVerticalScrollIndicator={false}
    >
      <Text style={styles.title}>{STEP_COPY.account.title}</Text>
      <Text style={styles.subtitle}>{STEP_COPY.account.subtitle}</Text>
      <Text style={styles.closing}>{STEP_COPY.account.closing}</Text>

      {confirmNote ? (
        <View style={styles.confirmCard}>
          <Text style={styles.confirmText}>
            Check your email to activate your account — you can sign in later from Settings.
          </Text>
          <Button label="Continue" onPress={onConfirmationSent} fullWidth size="lg" />
        </View>
      ) : (
        <View style={styles.form}>
          <OAuthButtons light onSuccess={onCreated} />

          <View style={styles.dividerRow}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>or use email</Text>
            <View style={styles.dividerLine} />
          </View>

          <TextInput
            style={styles.input}
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
            placeholder="Email"
            placeholderTextColor={colors.text.muted}
          />
          <TextInput
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            placeholder="Password (at least 8 characters)"
            placeholderTextColor={colors.text.muted}
          />
          <Button
            label={STEP_COPY.account.cta}
            onPress={handleCreate}
            loading={loading}
            fullWidth
            size="lg"
          />
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { paddingHorizontal: spacing.xl, paddingBottom: spacing.xl },
  title: { fontSize: 24, fontWeight: '700', color: colors.text.primary, textAlign: 'center', marginBottom: spacing.sm },
  subtitle: {
    fontSize: 14,
    color: colors.text.secondary,
    textAlign: 'center',
    lineHeight: 20,
  },
  closing: {
    fontSize: 13,
    color: colors.text.muted,
    textAlign: 'center',
    lineHeight: 18,
    marginBottom: spacing.lg,
  },
  form: { gap: spacing.sm },
  dividerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginVertical: spacing.xs },
  dividerLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: '#e5e7eb' },
  dividerText: { fontSize: 12, color: colors.text.muted },
  input: {
    backgroundColor: '#fff',
    borderRadius: 12,
    paddingHorizontal: spacing.md,
    paddingVertical: 14,
    color: colors.text.primary,
    fontSize: 15,
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  confirmCard: { gap: spacing.md },
  confirmText: {
    fontSize: 14,
    color: colors.text.secondary,
    textAlign: 'center',
    lineHeight: 20,
  },
});
