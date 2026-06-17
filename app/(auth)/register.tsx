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
import { signUp, updateProfileFields } from '../../src/services/auth';
import { useAuthStore } from '../../src/store/useAuthStore';
import { Button } from '../../src/components/ui/Button';
import { colors, spacing } from '../../src/constants/theme';
import { SkillLevel } from '../../src/types/user';

const SKILL_OPTIONS: { label: string; value: SkillLevel }[] = [
  { label: 'Beginner (0–2 years)', value: 'beginner' },
  { label: 'Intermediate (2–5 years)', value: 'intermediate' },
  { label: 'Advanced (5+ years)', value: 'advanced' },
];

export default function Register() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [skillLevel, setSkillLevel] = useState<SkillLevel>('beginner');
  const [loading, setLoading] = useState(false);

  const { setOnboardingComplete } = useAuthStore();

  const handleRegister = async () => {
    if (!email || !password) return;
    if (password.length < 8) {
      Alert.alert('Weak password', 'Password must be at least 8 characters.');
      return;
    }
    setLoading(true);
    try {
      const data = await signUp(email.trim(), password);
      setOnboardingComplete();

      if (data.session) {
        // Email confirmation is disabled — user is logged in immediately.
        // Update skill level now that we have a session.
        try {
          await updateProfileFields(data.user!.id, { skill_level: skillLevel });
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
            <Text style={styles.fieldLabel}>Email</Text>
            <TextInput
              style={styles.input}
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              keyboardType="email-address"
              placeholder="you@example.com"
              placeholderTextColor="rgba(255,255,255,0.4)"
            />

            <Text style={styles.fieldLabel}>Password</Text>
            <TextInput
              style={styles.input}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              placeholder="At least 8 characters"
              placeholderTextColor="rgba(255,255,255,0.4)"
            />

            <Text style={styles.sectionLabel}>Your skill level</Text>
            <View style={styles.skillRow}>
              {SKILL_OPTIONS.map((opt) => (
                <Pressable
                  key={opt.value}
                  style={[styles.skillChip, skillLevel === opt.value && styles.skillChipActive]}
                  onPress={() => setSkillLevel(opt.value)}
                >
                  <Text style={[styles.skillChipText, skillLevel === opt.value && styles.skillChipTextActive]}>
                    {opt.label}
                  </Text>
                </Pressable>
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

          <Text style={styles.terms}>
            By continuing you agree to our Terms of Service and Privacy Policy.
          </Text>

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
  fieldLabel: { fontSize: 13, fontWeight: '600', color: 'rgba(255,255,255,0.8)', marginBottom: 4 },
  sectionLabel: { fontSize: 13, fontWeight: '600', color: 'rgba(255,255,255,0.8)', marginTop: spacing.sm },
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
  skillRow: { gap: spacing.xs, marginBottom: spacing.sm },
  skillChip: {
    paddingVertical: 10,
    paddingHorizontal: spacing.md,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.25)',
  },
  skillChipActive: {
    backgroundColor: colors.brand[600],
    borderColor: colors.brand[400],
  },
  skillChipText: { color: 'rgba(255,255,255,0.65)', fontSize: 13 },
  skillChipTextActive: { color: '#fff', fontWeight: '600' },
  terms: {
    color: 'rgba(255,255,255,0.35)',
    fontSize: 11,
    textAlign: 'center',
    marginTop: spacing.md,
    lineHeight: 16,
  },
  footer: { flexDirection: 'row', justifyContent: 'center', marginTop: spacing.lg },
  footerText: { color: 'rgba(255,255,255,0.55)', fontSize: 14 },
  footerLink: { color: colors.brand[200], fontSize: 14, fontWeight: '600' },
});
