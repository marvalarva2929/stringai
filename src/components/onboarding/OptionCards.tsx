import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle } from 'react-native-reanimated';
import { colors, spacing, radius } from '../../constants/theme';
import { haptic } from '../../lib/haptics';
import { OptionDef } from '../../constants/onboardingContent';
import { OnboardingIcon } from './OnboardingIcon';

interface RecommendedOption extends OptionDef {
  recommended?: boolean;
}

interface OptionCardsProps {
  options: RecommendedOption[];
  selectedIds: string[];
  multi?: boolean;
  onToggle: (id: string) => void;
}

const DEPTH = 4;

// Big icon + label tiles in a 2-column grid, with the same popout press
// depth as BigButton (light surface + colored shadow offset) — no description
// text, so a full set of options fits on screen without scrolling.
export function OptionCards({ options, selectedIds, multi = false, onToggle }: OptionCardsProps) {
  return (
    <View style={styles.grid}>
      {options.map((option) => (
        <GridTile
          key={option.id}
          option={option}
          isSelected={selectedIds.includes(option.id)}
          multi={multi}
          onPress={() => onToggle(option.id)}
        />
      ))}
    </View>
  );
}

function GridTile({
  option,
  isSelected,
  multi,
  onPress,
}: {
  option: RecommendedOption;
  isSelected: boolean;
  multi: boolean;
  onPress: () => void;
}) {
  const offset = useSharedValue(0);
  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ translateY: offset.value }] }));

  const depthColor = isSelected ? colors.brand[800] : colors.brand[300];
  const surfaceColor = isSelected ? colors.brand[600] : '#fff';
  const contentColor = isSelected ? '#fff' : colors.brand[600];
  const borderStyle = isSelected ? {} : { borderWidth: 2, borderColor: colors.brand[400] };

  return (
    <Pressable
      onPressIn={() => { offset.value = DEPTH; haptic.light(); }}
      onPressOut={() => { offset.value = 0; }}
      onPress={() => { haptic.medium(); onPress(); }}
      style={[styles.outer, { backgroundColor: depthColor }]}
    >
      <Animated.View style={[styles.surface, { backgroundColor: surfaceColor }, borderStyle, animatedStyle]}>
        {option.recommended && (
          <View style={styles.recommendedPill}>
            <Text style={styles.recommendedText}>BEST</Text>
          </View>
        )}
        <OnboardingIcon icon={option.icon} size={26} color={contentColor} />
        <Text style={[styles.title, { color: contentColor }]} numberOfLines={2}>
          {option.title}
        </Text>
        {/* Only where an option genuinely needs disambiguating — a hint on every
            tile turns the grid back into a wall of text. */}
        {option.hint && (
          <Text
            style={[styles.hint, { color: isSelected ? 'rgba(255,255,255,0.85)' : colors.text.muted }]}
            numberOfLines={2}
          >
            {option.hint}
          </Text>
        )}
        {isSelected && (
          <View style={[styles.checkShape, multi ? styles.checkboxShape : styles.radioShape]}>
            <Text style={styles.checkmark}>✓</Text>
          </View>
        )}
      </Animated.View>
    </Pressable>
  );
}

const TILE_WIDTH = '47%';

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, justifyContent: 'space-between' },
  outer: {
    width: TILE_WIDTH,
    aspectRatio: 1.05,
    borderRadius: radius.lg,
    overflow: 'hidden',
  },
  surface: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.lg,
    padding: spacing.sm,
  },
  hint: { fontSize: 10, lineHeight: 13, textAlign: 'center', marginTop: 2, paddingHorizontal: 2 },
  title: {
    fontSize: 14,
    fontWeight: '700',
    textAlign: 'center',
    marginTop: spacing.xs,
  },
  recommendedPill: {
    position: 'absolute',
    top: 8,
    right: 8,
    backgroundColor: '#fff',
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.brand[300],
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  recommendedText: {
    fontSize: 9,
    fontWeight: '800',
    color: colors.brand[600],
    letterSpacing: 0.5,
  },
  checkShape: {
    position: 'absolute',
    bottom: 8,
    right: 8,
    width: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
  },
  radioShape: { borderRadius: 10 },
  checkboxShape: { borderRadius: 5 },
  checkmark: {
    fontSize: 11,
    color: colors.brand[600],
    fontWeight: '800',
  },
});
