import React from 'react';
import Svg, { Path, Circle, Line } from 'react-native-svg';
import { chart } from './chartTheme';
import type { TrendPoint } from '../../lib/progressAnalytics';

interface SparklineProps {
  /** Oldest-first. */
  points: TrendPoint[];
  width?: number;
  height?: number;
  /** Renders a flat dashed placeholder — the category was never measured. */
  empty?: boolean;
}

const MIN_SPAN = 20;

/**
 * Inline shape-only trend for a category row. Deliberately unlabelled and
 * single-hued: the row's value text and direction chip carry the meaning, and
 * colouring seven sparklines by severity would lean on a palette that doesn't
 * survive a colour-vision check.
 */
export function Sparkline({ points, width = 64, height = 24, empty = false }: SparklineProps) {
  const PAD = 3;
  const plotW = width - PAD * 2;
  const plotH = height - PAD * 2;

  if (empty || points.length === 0) {
    return (
      <Svg width={width} height={height}>
        <Line
          x1={PAD} y1={height / 2} x2={width - PAD} y2={height / 2}
          stroke={chart.absent} strokeWidth={2} strokeDasharray="2 3" strokeLinecap="round"
        />
      </Svg>
    );
  }

  const values = points.map((p) => p.value);
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (hi - lo < MIN_SPAN) {
    const grow = (MIN_SPAN - (hi - lo)) / 2;
    lo -= grow;
    hi += grow;
  }
  const span = Math.max(1, hi - lo);

  const times = points.map((p) => p.t);
  const tMin = Math.min(...times);
  const tSpan = Math.max(1, Math.max(...times) - tMin);

  const coords = points.map((p) => ({
    cx: points.length === 1 ? width / 2 : PAD + ((p.t - tMin) / tSpan) * plotW,
    cy: PAD + (1 - (p.value - lo) / span) * plotH,
  }));

  const d = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.cx.toFixed(1)},${c.cy.toFixed(1)}`).join(' ');
  const last = coords[coords.length - 1];

  return (
    <Svg width={width} height={height}>
      {coords.length >= 2 && (
        <Path
          d={d}
          stroke={chart.line}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      )}
      {/* The latest value is the one being read — anchor the eye there. */}
      <Circle cx={last.cx} cy={last.cy} r={3.5} fill={chart.surface} />
      <Circle cx={last.cx} cy={last.cy} r={2.5} fill={chart.line} />
    </Svg>
  );
}
