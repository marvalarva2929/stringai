import React from 'react';
import { Text, Pressable, ImageBackground, StyleSheet, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, {
  FadeInDown,
  useSharedValue,
  useAnimatedStyle,
  withTiming,
} from 'react-native-reanimated';
import { colors, spacing, radius } from '../../constants/theme';
import { STEP_COPY } from '../../constants/onboardingContent';
import { haptic } from '../../lib/haptics';

/**
 * TODO(welcome-video): swap the hero photo for a ~15s clip of the developer.
 *
 * The install is sold by organic video in the developer's own voice, and then
 * the app opens on stock-looking photography by someone the viewer has never
 * seen. Closing that gap costs nothing and is the one thing a competitor
 * cannot copy — continuity between the person who sold the install and the
 * first screen of the product.
 *
 * To land it:
 *   1. Drop the file at assets/onboarding/welcome-hero.mp4 and replace the
 *      ImageBackground below with it, keeping the photo as the poster frame so
 *      the first paint is never blank.
 *   2. `expo-av` is already a dependency — use <Video> with isMuted, isLooping,
 *      shouldPlay, resizeMode="cover". Autoplay must be muted or iOS silently
 *      refuses to start it; offer tap-to-unmute rather than opening with sound.
 *   3. Keep it bundled locally, not streamed — this is the first screen of a
 *      cold launch and must not wait on a network.
 *   4. Watch the binary. Fifteen seconds of 1080p H.264 at a sane bitrate is
 *      ~2-4MB; anything much past that is worth re-encoding.
 *
 * The scrims and text block below sit on top either way, so only the background
 * element changes.
 */

// The very first thing a new user sees: a full-bleed hero, the app name, and
// one button. Everything else about the app is sold across the steps that
// follow — this screen's only job is to feel good for two seconds.
export function WelcomeStep({ onNext }: { onNext: () => void }) {
  const insets = useSafeAreaInsets();

  return (
    <ImageBackground
      source={require('../../../assets/onboarding/welcome-hero.jpg')}
      style={styles.background}
      resizeMode="cover"
    >
      <LinearGradient
        colors={['rgba(4,12,26,0.6)', 'rgba(4,12,26,0)']}
        style={[styles.topScrim, { height: insets.top + 220 }]}
      />
      <LinearGradient
        colors={['rgba(4,12,26,0)', 'rgba(4,12,26,0.65)']}
        style={[styles.bottomScrim, { height: insets.bottom + 200 }]}
      />

      <Animated.View
        entering={FadeInDown.duration(520).delay(80)}
        style={[styles.textBlock, { paddingTop: insets.top + spacing.xl }]}
      >
        <Text style={styles.title}>{STEP_COPY.welcome.title}</Text>
        <Text style={styles.subtitle}>{STEP_COPY.welcome.subtitle}</Text>
      </Animated.View>

      <Animated.View
        entering={FadeInDown.duration(520).delay(280)}
        style={[styles.footer, { paddingBottom: insets.bottom + spacing.xl }]}
      >
        <NextButton label={STEP_COPY.welcome.cta} onPress={onNext} />
      </Animated.View>
    </ImageBackground>
  );
}

// Flat white pill with a soft neutral shadow and a light press-scale — no
// colored "depth" block behind it (that read muddy against the photo).
function NextButton({ label, onPress }: { label: string; onPress: () => void }) {
  const scale = useSharedValue(1);
  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  return (
    <Pressable
      onPressIn={() => {
        scale.value = withTiming(0.96, { duration: 80 });
        haptic.light();
      }}
      onPressOut={() => {
        scale.value = withTiming(1, { duration: 120 });
      }}
      onPress={onPress}
    >
      <Animated.View style={[styles.button, animatedStyle]}>
        <Text style={styles.buttonLabel}>{label}</Text>
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  background: { flex: 1, justifyContent: 'space-between' },
  topScrim: { position: 'absolute', top: 0, left: 0, right: 0 },
  bottomScrim: { position: 'absolute', bottom: 0, left: 0, right: 0 },
  textBlock: { paddingHorizontal: spacing.xl },
  title: {
    fontSize: 64,
    fontWeight: '800',
    color: '#fff',
    letterSpacing: -1,
    textShadowColor: 'rgba(0,0,0,0.3)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 10,
  },
  subtitle: {
    fontSize: 22,
    fontWeight: '500',
    color: 'rgba(255,255,255,0.92)',
    marginTop: 6,
    textShadowColor: 'rgba(0,0,0,0.3)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 8,
  },
  footer: { paddingHorizontal: spacing.xl },
  button: {
    height: 56,
    borderRadius: radius.full,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.2,
        shadowRadius: 14,
      },
      android: { elevation: 6 },
    }),
  },
  buttonLabel: {
    fontSize: 16,
    fontWeight: '800',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    color: colors.brand[600],
  },
});
