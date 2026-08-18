import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  Pressable,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Alert,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { signIn, fetchProfile, resetPassword } from '../../src/services/auth';
import { useAuthStore } from '../../src/store/useAuthStore';
import { useUserStore } from '../../src/store/useUserStore';
import { Button } from '../../src/components/ui/Button';
import { OAuthButtons } from '../../src/components/auth/OAuthButtons';
import { track, trackLogin } from '../../src/services/analytics';
import { AnalyticsEvent } from '../../src/constants/analyticsEvents';
import { errorReason } from '../../src/lib/analyticsUserProps';
import { colors, spacing } from '../../src/constants/theme';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [emailFocused, setEmailFocused] = useState(false);
  const [passwordFocused, setPasswordFocused] = useState(false);

  const handleForgotPassword = async () => {
    if (!email.trim()) {
      Alert.alert('Enter your email', 'Type your email address above, then tap Forgot password.');
      return;
    }
    try {
      await resetPassword(email.trim());
      Alert.alert('Email sent', `Check ${email.trim()} for a password reset link.`);
    } catch (err: any) {
      Alert.alert('Error', err.message ?? 'Could not send reset email.');
    }
  };

  const { setAuthenticated } = useAuthStore();
  const { setProfile } = useUserStore();

  const handleOAuthSuccess = () => {
    // supabase.auth.onAuthStateChange in app/_layout.tsx picks up the new
    // session (setAuthenticated + fetchProfile) — nothing more to do here.
    router.replace('/(tabs)/home');
  };

  const handleLogin = async () => {
    if (!email || !password) return;
    setLoading(true);
    try {
      const data = await signIn(email.trim(), password);
      if (data.user && data.session) {
        trackLogin('email');
        setAuthenticated(data.user.id, data.session.access_token);
        const profile = await fetchProfile(data.user.id);
        setProfile(profile);
        router.replace('/(tabs)/home');
      }
    } catch (err: any) {
      track(AnalyticsEvent.AUTH_FAILED, {
        stage: 'sign_in',
        method: 'email',
        reason: errorReason(err),
      });
      Alert.alert('Sign In Failed', err.message ?? 'Please check your credentials.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <LinearGradient colors={[colors.brand[900], colors.brand[800]]} style={styles.gradient}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.container}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.logo}>🎻</Text>
          <Text style={styles.title}>Welcome back</Text>
          <Text style={styles.subtitle}>Sign in to StringAI</Text>

          <View style={styles.form}>
            <OAuthButtons onSuccess={handleOAuthSuccess} />

            <View style={styles.dividerRow}>
              <View style={styles.dividerLine} />
              <Text style={styles.dividerText}>or</Text>
              <View style={styles.dividerLine} />
            </View>

            <Text style={styles.fieldLabel}>Email</Text>
            <TextInput
              style={[styles.input, emailFocused && styles.inputFocused]}
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              keyboardType="email-address"
              placeholder="you@example.com"
              placeholderTextColor="rgba(255,255,255,0.4)"
              onFocus={() => setEmailFocused(true)}
              onBlur={() => setEmailFocused(false)}
            />

            <Text style={styles.fieldLabel}>Password</Text>
            <TextInput
              style={[styles.input, passwordFocused && styles.inputFocused]}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              placeholder="••••••••"
              placeholderTextColor="rgba(255,255,255,0.4)"
              onFocus={() => setPasswordFocused(true)}
              onBlur={() => setPasswordFocused(false)}
            />

            <Button
              label="Sign In"
              onPress={handleLogin}
              loading={loading}
              fullWidth
              size="lg"
            />

            <Pressable style={styles.link} onPress={handleForgotPassword}>
              <Text style={styles.linkText}>Forgot password?</Text>
            </Pressable>
          </View>

          <View style={styles.footer}>
            <Text style={styles.footerText}>Don't have an account? </Text>
            <Pressable onPress={() => router.push('/(auth)/register')}>
              <Text style={styles.footerLink}>Sign up free</Text>
            </Pressable>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  gradient: { flex: 1 },
  flex: { flex: 1 },
  container: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.xxl,
  },
  logo: { fontSize: 52, textAlign: 'center', marginBottom: spacing.md },
  title: { fontSize: 28, fontWeight: '700', color: '#fff', textAlign: 'center' },
  subtitle: { fontSize: 15, color: 'rgba(255,255,255,0.65)', textAlign: 'center', marginBottom: spacing.xl },
  form: { gap: spacing.sm },
  dividerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginVertical: spacing.xs },
  dividerLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: 'rgba(255,255,255,0.25)' },
  dividerText: { fontSize: 12, color: 'rgba(255,255,255,0.55)' },
  fieldLabel: { fontSize: 13, fontWeight: '600', color: 'rgba(255,255,255,0.8)', marginBottom: 4 },
  input: {
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderRadius: 12,
    paddingHorizontal: spacing.md,
    paddingVertical: 14,
    color: '#fff',
    fontSize: 15,
    marginBottom: spacing.sm,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
  },
  inputFocused: {
    borderColor: 'rgba(255,255,255,0.65)',
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  link: { alignItems: 'center', paddingVertical: spacing.sm },
  linkText: { color: 'rgba(255,255,255,0.55)', fontSize: 13 },
  footer: { flexDirection: 'row', justifyContent: 'center', marginTop: spacing.xl },
  footerText: { color: 'rgba(255,255,255,0.55)', fontSize: 14 },
  footerLink: { color: colors.brand[200], fontSize: 14, fontWeight: '600' },
});
