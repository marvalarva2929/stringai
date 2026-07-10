import React from 'react';
import { Pressable, Text, StyleSheet } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { haptic } from '../../lib/haptics';
import { radius, spacing } from '../../constants/theme';

/**
 * The tactile "press-down" primary button used across the practice flow.
 * Previously duplicated inline in tips.tsx and practice/[id].tsx.
 */
export function DepthButton({
  label,
  icon,
  onPress,
  variant = 'primary',
  disabled = false,
}: {
  label: string;
  icon: React.ComponentProps<typeof Ionicons>['name'];
  onPress: () => void;
  variant?: 'primary' | 'neutral';
  disabled?: boolean;
}) {
  const offset = useSharedValue(0);
  const style = useAnimatedStyle(() => ({ transform: [{ translateY: offset.value }] }));

  return (
    <Pressable
      style={[s.outer, disabled && s.outerDisabled]}
      disabled={disabled}
      onPressIn={() => { offset.value = withTiming(5, { duration: 60 }); haptic.light(); }}
      onPressOut={() => { offset.value = withTiming(0, { duration: 100 }); }}
      onPress={onPress}
    >
      <Animated.View style={[s.base, variant === 'neutral' && s.baseNeutral]} />
      <Animated.View style={[s.surface, variant === 'neutral' ? s.surfaceNeutral : s.surfacePrimary, style]}>
        <Ionicons name={icon} size={18} color="#fff" />
        <Text style={s.text}>{label}</Text>
      </Animated.View>
    </Pressable>
  );
}

const s = StyleSheet.create({
  outer: { height: 58 },
  outerDisabled: { opacity: 0.5 },
  base: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 54,
    borderRadius: radius.lg,
    backgroundColor: '#166534',
  },
  baseNeutral: { backgroundColor: '#1f2937' },
  surface: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    height: 54,
    borderRadius: radius.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  surfacePrimary: { backgroundColor: '#22c55e' },
  surfaceNeutral: { backgroundColor: '#374151' },
  text: { color: '#fff', fontSize: 16, fontWeight: '900' },
});
