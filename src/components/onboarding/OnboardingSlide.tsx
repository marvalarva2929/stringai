import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors, spacing } from '../../constants/theme';

export interface SlideData {
  emoji: string;
  title: string;
  subtitle: string;
  body: string;
}

interface OnboardingSlidePrpos {
  slide: SlideData;
}

export function OnboardingSlide({ slide }: OnboardingSlidePrpos) {
  return (
    <View style={styles.container}>
      <Text style={styles.emoji}>{slide.emoji}</Text>
      <Text style={styles.title}>{slide.title}</Text>
      <Text style={styles.subtitle}>{slide.subtitle}</Text>
      <Text style={styles.body}>{slide.body}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.xxl,
  },
  emoji: { fontSize: 72, marginBottom: spacing.lg },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: '#fff',
    textAlign: 'center',
    marginBottom: spacing.sm,
  },
  subtitle: {
    fontSize: 16,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.85)',
    textAlign: 'center',
    marginBottom: spacing.md,
  },
  body: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.7)',
    textAlign: 'center',
    lineHeight: 22,
  },
});
