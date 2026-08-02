import React from 'react';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';

export interface IconSpec {
  lib: 'ion' | 'mci';
  name: string;
}

interface OnboardingIconProps {
  icon: IconSpec;
  size?: number;
  color?: string;
}

// Subtle single-color line icons (Ionicons outline set + a couple of
// MaterialCommunityIcons glyphs Ionicons lacks, e.g. "violin") — deliberately
// not colorful/cartoony emoji.
export function OnboardingIcon({ icon, size = 26, color }: OnboardingIconProps) {
  if (icon.lib === 'mci') {
    return <MaterialCommunityIcons name={icon.name as any} size={size} color={color} />;
  }
  return <Ionicons name={icon.name as any} size={size} color={color} />;
}
