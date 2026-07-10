import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, radius, spacing } from '../../constants/theme';

/**
 * Maestro coach speech bubble. `tone="dark"` for use over the brand-dark
 * training background, `tone="light"` for white panels. Replaces the
 * hand-rolled "M" avatar previously inlined in the practice screens.
 */
export function CoachBubble({ message, tone = 'dark' }: { message: string; tone?: 'dark' | 'light' }) {
  const dark = tone === 'dark';
  return (
    <View style={[s.bubble, dark ? s.bubbleDark : s.bubbleLight]}>
      <View style={s.mark}>
        <Ionicons name="musical-notes" size={18} color={colors.brand[600]} />
      </View>
      <Text style={[s.text, dark ? s.textDark : s.textLight]}>{message}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  bubble: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    borderRadius: radius.xl,
    padding: spacing.md,
    borderWidth: 1,
  },
  bubbleDark: {
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderColor: 'rgba(255,255,255,0.14)',
  },
  bubbleLight: {
    backgroundColor: colors.brand[50],
    borderColor: colors.brand[100],
  },
  mark: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
  },
  text: { flex: 1, fontSize: 13, lineHeight: 19, fontWeight: '600' },
  textDark: { color: 'rgba(255,255,255,0.84)' },
  textLight: { color: colors.text.secondary },
});
