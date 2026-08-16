import React from 'react';
import { View, Pressable, StyleSheet, type ViewStyle, type StyleProp } from 'react-native';
import { spacing } from '../../constants/theme';
import { haptic } from '../../lib/haptics';

interface DepthCardProps {
  children: React.ReactNode;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
}

/**
 * The card treatment the home screen uses — a solid bottom border reading as
 * depth, rather than the older soft drop shadow. Extracted here so Progress and
 * piece detail stop looking like a different app to the tab beside them.
 */
export function DepthCard({ children, onPress, style }: DepthCardProps) {
  if (!onPress) {
    return <View style={[s.card, style]}>{children}</View>;
  }

  return (
    <Pressable
      style={({ pressed }) => [s.card, pressed && s.pressed, style]}
      onPress={() => { haptic.light(); onPress(); }}
    >
      {children}
    </Pressable>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: '#fff',
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: '#e5e7eb',
    borderBottomWidth: 4,
    borderBottomColor: '#d1d5db',
    padding: spacing.md,
    gap: spacing.sm,
  },
  pressed: { backgroundColor: '#f9fafb' },
});
