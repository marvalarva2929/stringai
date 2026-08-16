import { colors } from '../../constants/theme';
import type { TrendDirection } from '../../lib/progressAnalytics';

// ─────────────────────────────────────────────────────────────
// Chart semantics
//
// The app's four-band severity palette (colors.score) is a status scale, not a
// categorical encoder: validated for colour-vision separation it fails badly —
// amber↔lime sit ΔE 1.5 apart under deuteranopia, and green↔lime only ΔE 8 even
// with full colour vision. So severity never carries meaning on its own in a
// chart here. It appears only as a labelled reference threshold.
//
// The direction pair below (brand blue ↔ red) passes every check: ΔE 19.4 under
// protanopia, 33.4 normal, both above 3:1 against white. "Steady" is deliberately
// the desaturated neutral — it is the absence of a direction, and it is
// distinguished by its dash glyph as much as by its colour.
//
// Every use of these is accompanied by a text label and a glyph, so colour is
// never the only thing carrying the meaning.
// ─────────────────────────────────────────────────────────────

export const chart = {
  /** Single-series line/sparkline hue. */
  line: colors.brand[600],
  // Gradient stops carry their alpha separately — react-native-svg does not
  // read an alpha channel out of an rgba() stopColor, it renders it opaque.
  fill: colors.brand[600],
  fillTopOpacity: 0.18,
  fillBottomOpacity: 0.02,

  /** Recessive furniture. */
  axis: '#e5e7eb',
  grid: '#f1f5f9',
  reference: 'rgba(107,114,128,0.35)',
  referenceText: colors.text.muted,

  /** Surface colour, used for the 2px gap that separates adjacent marks. */
  surface: colors.surface,

  /** Diverging poles — better vs worse. */
  positive: colors.brand[600],
  negative: '#ef4444',
  neutral: colors.text.muted,

  /** Sequential ramp for the practice heatmap: one hue, light → dark. */
  heat: ['#eef2f6', '#e0f2fe', '#bae6fd', '#7dd3fc', '#38bdf8', '#0284c7'],

  /** Recurrence strip: filled vs hollow is the primary encoding. */
  present: '#ef4444',
  absent: '#e5e7eb',
} as const;

export interface DirectionStyle {
  color: string;
  glyph: string;
  label: string;
}

export const DIRECTION_STYLE: Record<TrendDirection, DirectionStyle> = {
  improving: { color: chart.positive, glyph: '▲', label: 'improving' },
  steady:    { color: chart.neutral,  glyph: '–', label: 'steady' },
  slipping:  { color: chart.negative, glyph: '▼', label: 'slipping' },
  unknown:   { color: chart.neutral,  glyph: '',  label: 'not enough data' },
};

/** Bucket a 0–1 intensity onto the sequential ramp. */
export function heatColor(intensity: number): string {
  if (intensity <= 0) return chart.heat[0];
  const steps = chart.heat.length - 1;
  const index = Math.min(steps, Math.max(1, Math.ceil(intensity * steps)));
  return chart.heat[index];
}
