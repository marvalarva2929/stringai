import React, { useState } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  Alert,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, spacing, radius } from '../../constants/theme';
import { signIn } from '../../services/auth';
import { track, trackLogin } from '../../services/analytics';
import { AnalyticsEvent } from '../../constants/analyticsEvents';
import { errorReason } from '../../lib/analyticsUserProps';
import { Button } from '../ui/Button';
import { OAuthButtons } from './OAuthButtons';
import { haptic } from '../../lib/haptics';

/**
 * Sign-in for an existing subscriber, presented from the mandatory paywall.
 *
 * Why this exists as a Modal rather than a link to /(auth)/login: SubscribeGate
 * renders as an overlay *over* the navigator, so routing to the login screen
 * would push it underneath the paywall where nobody can see or touch it. A
 * native Modal is the one thing that reliably draws above an absolute-fill
 * overlay.
 *
 * Why it exists at all: with account creation moved after the purchase, the
 * paywall is the first screen a returning user meets on a new device, and it
 * was previously a dead end for them — Restore only recovers a purchase made
 * with the same Apple ID, and an entitlement granted against a Supabase user id
 * (which is how App Review is let in) can only be reached by signing in.
 *
 * Nothing is needed on success beyond closing: onAuthStateChange in
 * app/_layout.tsx picks up the session, calls identifyPurchaser to alias
 * RevenueCat onto the user id, and the refreshed entitlement clears the gate.
 */
export function SignInSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSignIn = async () => {
    if (!email.trim() || !password) return;
    haptic.light();
    setLoading(true);
    try {
      const data = await signIn(email.trim(), password);
      if (data.session && data.user) {
        trackLogin('email');
        onClose();
      }
    } catch (err: any) {
      track(AnalyticsEvent.AUTH_FAILED, {
        stage: 'sign_in',
        method: 'email',
        reason: errorReason(err),
      });
      Alert.alert('Sign-in failed', err?.message ?? 'Check your email and password.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          style={styles.flex}
          contentContainerStyle={[styles.body, { paddingTop: insets.top + spacing.lg }]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.headerRow}>
            <Text style={styles.title}>Sign in</Text>
            <Pressable onPress={onClose} hitSlop={12}>
              <Text style={styles.close}>Done</Text>
            </Pressable>
          </View>
          <Text style={styles.subtitle}>
            Already subscribed? Sign in to restore your subscription and your history.
          </Text>

          <OAuthButtons light onSuccess={onClose} />

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
            autoComplete="email"
            keyboardType="email-address"
            placeholder="Email"
            placeholderTextColor={colors.text.muted}
          />
          <TextInput
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoComplete="current-password"
            placeholder="Password"
            placeholderTextColor={colors.text.muted}
          />
          <Button label="Sign In" onPress={handleSignIn} loading={loading} fullWidth size="lg" />
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.background },
  body: { paddingHorizontal: spacing.xl, paddingBottom: spacing.xxl, gap: spacing.sm },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: 24, fontWeight: '800', color: colors.text.primary },
  close: { fontSize: 15, fontWeight: '700', color: colors.brand[600] },
  subtitle: {
    fontSize: 14,
    color: colors.text.secondary,
    lineHeight: 20,
    marginBottom: spacing.md,
  },
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginVertical: spacing.xs,
  },
  dividerLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: '#e5e7eb' },
  dividerText: { fontSize: 12, color: colors.text.muted },
  input: {
    backgroundColor: '#fff',
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 14,
    color: colors.text.primary,
    fontSize: 15,
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
});
