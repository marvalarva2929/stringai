import React from 'react';
import { Pressable, Text, ActivityIndicator, StyleSheet, View } from 'react-native';
import { colors, radius, spacing } from '../../constants/theme';

type Variant = 'primary' | 'secondary' | 'outline' | 'ghost';
type Size = 'sm' | 'md' | 'lg';

interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  disabled?: boolean;
  fullWidth?: boolean;
  leftIcon?: React.ReactNode;
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled = false,
  fullWidth = false,
  leftIcon,
}: ButtonProps) {
  const isDisabled = disabled || loading;

  return (
    <Pressable
      onPress={onPress}
      disabled={isDisabled}
      style={({ pressed }) => [
        styles.base,
        styles[variant],
        styles[`size_${size}`],
        fullWidth && styles.fullWidth,
        isDisabled && styles.disabled,
        pressed && !isDisabled && styles.pressed,
      ]}
    >
      {loading ? (
        <ActivityIndicator
          color={variant === 'primary' ? '#fff' : colors.brand[600]}
          size="small"
        />
      ) : (
        <View style={styles.inner}>
          {leftIcon && <View style={styles.iconLeft}>{leftIcon}</View>}
          <Text style={[styles.label, styles[`label_${variant}`], styles[`labelSize_${size}`]]}>
            {label}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
  },
  fullWidth: { width: '100%' },
  inner: { flexDirection: 'row', alignItems: 'center' },
  iconLeft: { marginRight: spacing.sm },
  pressed: { opacity: 0.82 },
  disabled: { opacity: 0.45 },

  primary: { backgroundColor: colors.brand[600] },
  secondary: { backgroundColor: colors.brand[100] },
  outline: { backgroundColor: 'transparent', borderWidth: 1.5, borderColor: colors.brand[600] },
  ghost: { backgroundColor: 'transparent' },

  size_sm: { paddingVertical: 8, paddingHorizontal: 14, minHeight: 36 },
  size_md: { paddingVertical: 13, paddingHorizontal: 20, minHeight: 48 },
  size_lg: { paddingVertical: 16, paddingHorizontal: 28, minHeight: 56 },

  label: { fontWeight: '600', textAlign: 'center' },
  label_primary: { color: '#fff' },
  label_secondary: { color: colors.brand[700] },
  label_outline: { color: colors.brand[600] },
  label_ghost: { color: colors.brand[600] },

  labelSize_sm: { fontSize: 13 },
  labelSize_md: { fontSize: 15 },
  labelSize_lg: { fontSize: 17 },
});
