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
  Linking,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { signUp, updateProfileFields } from '../../src/services/auth';
import { useAuthStore } from '../../src/store/useAuthStore';
import { useOnboardingStore } from '../../src/store/useOnboardingStore';
import { EXPERIENCE_LEVELS } from '../../src/constants/onboardingContent';
import { Button } from '../../src/components/ui/Button';
import { OAuthButtons } from '../../src/components/auth/OAuthButtons';
import { track, trackSignUp } from '../../src/services/analytics';
import { AnalyticsEvent } from '../../src/constants/analyticsEvents';
import { errorReason } from '../../src/lib/analyticsUserProps';
import { colors, spacing } from '../../src/constants/theme';
import { PRIVACY_POLICY_URL, TERMS_OF_SERVICE_URL } from '../../src/constants/links';

export default function Register() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [emailFocused, setEmailFocused] = useState(false);
  const [passwordFocused, setPasswordFocused] = useState(false);

  const { setOnboardingComplete, weeklyGoalMinutes } = useAuthStore();
  const { experienceId } = useOnboardingStore();
  // Skill level was collected in onboarding's experience step; this screen
  // only serves post-onboarding signup now (e.g. from the login screen), so
  // fall back to 'beginner' if onboarding was never completed on this device.
  const skillLevel = EXPERIENCE_LEVELS.find((e) => e.id === experienceId)?.skillLevel ?? 'beginner';

  const handleOAuthSuccess = (userId: string) => {
    setOnboardingComplete();
    updateProfileFields(userId, {
      skill_level: skillLevel,
      ...(weeklyGoalMinutes ? { weekly_goal_minutes: weeklyGoalMinutes } : {}),
    }).catch(() => {});
    router.replace('/(tabs)/home');
  };

  const handleRegister = async () => {
    if (!email || !password) return;
    if (password.length < 8) {
      Alert.alert('Weak password', 'Password must be at least 8 characters.');
      return;
    }
    setLoading(true);
    try {
      const data = await signUp(email.trim(), password);
      trackSignUp('email');
      setOnboardingComplete();

      if (data.session) {
        // Email confirmation is disabled — user is logged in immediately.
        // Update skill level (and any locally-set weekly goal) now that we have a session.
        try {
          await updateProfileFields(data.user!.id, {
            skill_level: skillLevel,
            ...(weeklyGoalMinutes ? { weekly_goal_minutes: weeklyGoalMinutes } : {}),
          });
        } catch {}
        router.replace('/(tabs)/home');
      } else {
        // Email confirmation is enabled — session not available yet.
        Alert.alert(
          'Check your email',
          `We sent a confirmation link to ${email.trim()}. Click it to activate your account, then sign in.`,
          [{ text: 'OK', onPress: () => router.replace('/(auth)/login') }],
        );
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
          <Text style={styles.title}>Create your account</Text>
          <Text style={styles.subtitle}>Save your progress and access it anywhere</Text>

          <View style={styles.form}>
            <OAuthButtons onSuccess={handleOAuthSuccess} />

            <View style={styles.dividerRow}>
              <View style={styles.dividerLine} />
              <Text style={styles.dividerText}>or use email</Text>
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
              placeholder="At least 8 characters"
              placeholderTextColor="rgba(255,255,255,0.4)"
              onFocus={() => setPasswordFocused(true)}
              onBlur={() => setPasswordFocused(false)}
            />
            <View style={styles.strengthRow}>
              {[0, 1, 2].map((i) => (
                <View
                  key={i}
                  style={[
                    styles.strengthSegment,
                    {
                      backgroundColor:
                        password.length === 0
                          ? 'rgba(255,255,255,0.15)'
                          : password.length < 8
                          ? i === 0 ? '#ef4444' : 'rgba(255,255,255,0.15)'
                          : password.length < 13
                          ? i < 2 ? '#f59e0b' : 'rgba(255,255,255,0.15)'
                          : '#22c55e',
                    },
                  ]}
                />
              ))}
            </View>

            <Button
              label="Create Account"
              onPress={handleRegister}
              loading={loading}
              fullWidth
              size="lg"
            />
          </View>

          <View style={styles.termsRow}>
            <Text style={styles.terms}>By continuing you agree to our </Text>
            <Pressable onPress={() => { Linking.openURL(TERMS_OF_SERVICE_URL).catch(() => {}); }}>
              <Text style={styles.termsLink}>Terms of Service</Text>
            </Pressable>
            <Text style={styles.terms}> and </Text>
            <Pressable onPress={() => { Linking.openURL(PRIVACY_POLICY_URL).catch(() => {}); }}>
              <Text style={styles.termsLink}>Privacy Policy</Text>
            </Pressable>
            <Text style={styles.terms}>.</Text>
          </View>

          <View style={styles.footer}>
            <Text style={styles.footerText}>Already have an account? </Text>
            <Pressable onPress={() => router.replace('/(auth)/login')}>
              <Text style={styles.footerLink}>Sign in</Text>
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
  subtitle: { fontSize: 15, color: colors.brand[200], textAlign: 'center', marginBottom: spacing.xl },
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
  termsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    marginTop: spacing.md,
  },
  terms: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 12,
    lineHeight: 18,
  },
  termsLink: {
    color: colors.brand[200],
    fontSize: 12,
    lineHeight: 18,
    textDecorationLine: 'underline',
  },
  inputFocused: {
    borderColor: 'rgba(255,255,255,0.65)',
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  strengthRow: {
    flexDirection: 'row',
    gap: 4,
    marginTop: -spacing.xs,
    marginBottom: spacing.sm,
  },
  strengthSegment: {
    flex: 1,
    height: 3,
    borderRadius: 2,
  },
  footer: { flexDirection: 'row', justifyContent: 'center', marginTop: spacing.lg },
  footerText: { color: 'rgba(255,255,255,0.55)', fontSize: 14 },
  footerLink: { color: colors.brand[200], fontSize: 14, fontWeight: '600' },
});
