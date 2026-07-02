import React from 'react';
import { Pressable, Text, StyleSheet, ViewStyle } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle } from 'react-native-reanimated';
import { colors } from '../../constants/theme';
import { haptic } from '../../lib/haptics';

const BUTTON_H = 56;
const DEPTH = 4;

interface BigButtonProps {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary';
  disabled?: boolean;
  style?: ViewStyle;
}

export function BigButton({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  style,
}: BigButtonProps) {
  const offset = useSharedValue(0);

  const surfaceStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: offset.value }],
  }));

  const isPrimary = variant === 'primary';
  const mainBg = isPrimary ? colors.brand[600] : '#fff';
  const depthBg = isPrimary ? colors.brand[800] : colors.brand[300];
  const labelColor = isPrimary ? '#fff' : colors.brand[600];
  const borderStyle: ViewStyle = isPrimary ? {} : { borderWidth: 2, borderColor: colors.brand[400] };

  return (
    <Pressable
      onPressIn={() => {
        if (!disabled) {
          offset.value = DEPTH;
          haptic.light();
        }
      }}
      onPressOut={() => {
        offset.value = 0;
      }}
      onPress={onPress}
      disabled={disabled}
      style={[styles.outer, { backgroundColor: depthBg }, disabled && styles.disabled, style]}
    >
      <Animated.View style={[styles.surface, { backgroundColor: mainBg }, borderStyle, surfaceStyle]}>
        <Text style={[styles.label, { color: labelColor }]}>{label}</Text>
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  outer: {
    height: BUTTON_H + DEPTH,
    borderRadius: 16,
    overflow: 'hidden',
    alignSelf: 'stretch',
  },
  surface: {
    height: BUTTON_H,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    fontSize: 15,
    fontWeight: '800',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  disabled: {
    opacity: 0.4,
  },
});
