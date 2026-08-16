import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet, Alert, ActivityIndicator } from 'react-native';
import { FontAwesome6 } from '@expo/vector-icons';
import { signInWithProvider, OAuthProvider } from '../../services/auth';
import { haptic } from '../../lib/haptics';
import { track, trackLogin } from '../../services/analytics';
import { AnalyticsEvent } from '../../constants/analyticsEvents';
import { errorReason } from '../../lib/analyticsUserProps';
import { colors, spacing, radius } from '../../constants/theme';

interface OAuthButtonsProps {
  /** Called with the authenticated user id once a session exists. */
  onSuccess: (userId: string) => void;
  /** Light-card style for the light onboarding theme. Defaults to the
   *  translucent-on-dark style used by login/register. */
  light?: boolean;
}

// Apple first, deliberately. It is the only path that produces an account
// without an email round-trip, which matters because confirmation mail is the
// least reliable part of the signup stack — and Apple's own guidelines require
// Sign in with Apple to be at least as prominent as any other provider.
const PROVIDERS: { id: OAuthProvider; label: string; icon: string }[] = [
  { id: 'apple', label: 'Continue with Apple', icon: 'apple' },
  { id: 'google', label: 'Continue with Google', icon: 'google' },
];

// Shared Google/Apple sign-in buttons for login, register, and the onboarding
// account step — all three drive the same signInWithProvider OAuth flow.
export function OAuthButtons({ onSuccess, light = false }: OAuthButtonsProps) {
  const [loadingProvider, setLoadingProvider] = useState<OAuthProvider | null>(null);

  const handlePress = async (provider: OAuthProvider) => {
    haptic.light();
    setLoadingProvider(provider);
    try {
      const data = await signInWithProvider(provider);
      if (data?.session && data.user) {
        trackLogin(provider);
        onSuccess(data.user.id);
      } else {
        // signInWithProvider resolves null when the user closes the web session.
        track(AnalyticsEvent.AUTH_FAILED, { stage: 'oauth', method: provider, reason: 'cancelled' });
      }
    } catch (err: any) {
      track(AnalyticsEvent.AUTH_FAILED, {
        stage: 'oauth',
        method: provider,
        reason: errorReason(err),
      });
      Alert.alert('Sign-in failed', err?.message ?? 'Something went wrong.');
    } finally {
      setLoadingProvider(null);
    }
  };

  const iconColor = light ? colors.text.primary : '#fff';
  const spinnerColor = light ? colors.brand[600] : '#fff';

  return (
    <View style={styles.stack}>
      {PROVIDERS.map((p) => (
        <Pressable
          key={p.id}
          style={[
            light ? styles.btnLight : styles.btn,
            loadingProvider !== null && styles.btnDisabled,
          ]}
          onPress={() => handlePress(p.id)}
          disabled={loadingProvider !== null}
        >
          {loadingProvider === p.id ? (
            <ActivityIndicator color={spinnerColor} />
          ) : (
            <>
              <FontAwesome6 name={p.icon} size={18} color={iconColor} />
              <Text style={light ? styles.btnTextLight : styles.btnText}>{p.label}</Text>
            </>
          )}
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: spacing.sm },
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: 'rgba(255,255,255,0.14)',
    borderRadius: radius.lg,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.25)',
    paddingVertical: 14,
  },
  btnDisabled: { opacity: 0.6 },
  btnText: { color: '#fff', fontSize: 15, fontWeight: '700' },

  btnLight: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: '#fff',
    borderRadius: radius.lg,
    borderWidth: 1.5,
    borderColor: '#e5e7eb',
    borderBottomWidth: 3,
    borderBottomColor: '#d1d5db',
    paddingVertical: 14,
  },
  btnTextLight: { color: colors.text.primary, fontSize: 15, fontWeight: '700' },
});
