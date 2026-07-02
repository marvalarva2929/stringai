import React, { useEffect } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withSequence,
  withTiming,
  withRepeat,
  withDelay,
} from 'react-native-reanimated';
import { colors, spacing, radius } from '../../constants/theme';

const SIZES = {
  sm: { container: 52, emoji: 26, platformW: 44, platformH: 8 },
  md: { container: 80, emoji: 42, platformW: 64, platformH: 11 },
  lg: { container: 110, emoji: 58, platformW: 90, platformH: 14 },
};

interface MaestroAvatarProps {
  message?: string;
  size?: 'sm' | 'md' | 'lg';
  bounce?: boolean;
  bubblePosition?: 'above' | 'below';
}

export function MaestroAvatar({
  message,
  size = 'md',
  bounce = false,
  bubblePosition = 'above',
}: MaestroAvatarProps) {
  const sz = SIZES[size];

  const translateY = useSharedValue(28);
  const opacity = useSharedValue(0);
  const bubbleOpacity = useSharedValue(0);
  const bobY = useSharedValue(0);

  useEffect(() => {
    translateY.value = withSpring(0, { damping: 12, stiffness: 180 });
    opacity.value = withTiming(1, { duration: 220 });

    if (message) {
      bubbleOpacity.value = withDelay(380, withTiming(1, { duration: 280 }));
    }

    if (bounce) {
      bobY.value = withDelay(
        500,
        withRepeat(
          withSequence(
            withTiming(-7, { duration: 900 }),
            withTiming(0, { duration: 900 }),
          ),
          -1,
          true,
        ),
      );
    }
  }, []);

  const avatarStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value + bobY.value }],
    opacity: opacity.value,
  }));

  const bubbleAnimStyle = useAnimatedStyle(() => ({
    opacity: bubbleOpacity.value,
  }));

  const bubble = message ? (
    <Animated.View style={[styles.bubble, bubbleAnimStyle]}>
      <Text style={styles.bubbleText}>{message}</Text>
      <View style={bubblePosition === 'above' ? styles.tailDown : styles.tailUp} />
    </Animated.View>
  ) : null;

  return (
    <View style={styles.wrap}>
      {bubblePosition === 'above' && bubble}
      <Animated.View style={[styles.avatarWrap, avatarStyle]}>
        <View
          style={[
            styles.circle,
            { width: sz.container, height: sz.container, borderRadius: sz.container / 2 },
          ]}
        >
          <Ionicons name="musical-notes" size={sz.emoji} color={colors.brand[600]} />
        </View>
        <View
          style={[
            styles.platform,
            { width: sz.platformW, height: sz.platformH, borderRadius: sz.platformH / 2 },
          ]}
        />
      </Animated.View>
      {bubblePosition === 'below' && bubble}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', gap: spacing.sm },
  avatarWrap: { alignItems: 'center' },

  circle: {
    backgroundColor: colors.brand[100],
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: colors.brand[600],
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.22,
    shadowRadius: 14,
    elevation: 8,
  },

  platform: {
    backgroundColor: 'rgba(0,0,0,0.10)',
    marginTop: 5,
  },

  bubble: {
    backgroundColor: '#fff',
    borderRadius: radius.xl,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    maxWidth: 280,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.10,
    shadowRadius: 8,
    elevation: 4,
    alignItems: 'center',
  },
  bubbleText: {
    fontSize: 15,
    color: colors.text.primary,
    fontWeight: '500',
    textAlign: 'center',
    lineHeight: 21,
  },

  // Triangle pointing down (bubble above avatar)
  tailDown: {
    width: 0,
    height: 0,
    borderLeftWidth: 8,
    borderRightWidth: 8,
    borderTopWidth: 9,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderTopColor: '#fff',
    position: 'absolute',
    bottom: -9,
    alignSelf: 'center',
  },

  // Triangle pointing up (bubble below avatar)
  tailUp: {
    width: 0,
    height: 0,
    borderLeftWidth: 8,
    borderRightWidth: 8,
    borderBottomWidth: 9,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderBottomColor: '#fff',
    position: 'absolute',
    top: -9,
    alignSelf: 'center',
  },
});
