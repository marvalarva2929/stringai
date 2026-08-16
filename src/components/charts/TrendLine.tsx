import React from 'react';
import Svg, {
  Path, Line, Circle, Defs, LinearGradient, Stop, Text as SvgText,
} from 'react-native-svg';
import { chart } from './chartTheme';
import type { TrendPoint } from '../../lib/progressAnalytics';

interface TrendLineProps {
  /** Oldest-first. */
  points: TrendPoint[];
  width: number;
  height?: number;
  /** Score marked with a labelled reference line — the "good" threshold. */
  referenceValue?: number | null;
  referenceLabel?: string;
  /** Tapping a point opens that session. */
  onPointPress?: (point: TrendPoint, index: number) => void;
}

const PAD_L = 6;
const PAD_R = 40;   // room for the reference label
const PAD_T = 14;
const PAD_B = 20;

/** Never zoom tighter than this many score points — a 4-point wobble stretched
 *  across the full height would read as a dramatic swing. */
const MIN_SPAN = 30;

function formatDate(t: number): string {
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Score over time on a real date axis. Even-spaced session indices would
 * misrepresent a two-week gap as a single step, so x is genuine elapsed time.
 */
export function TrendLine({
  points,
  width,
  height = 168,
  referenceValue = 70,
  referenceLabel = 'good',
  onPointPress,
}: TrendLineProps) {
  if (points.length === 0) return null;

  const plotW = Math.max(1, width - PAD_L - PAD_R);
  const plotH = Math.max(1, height - PAD_T - PAD_B);

  const values = points.map((p) => p.value);
  const anchors = referenceValue == null ? values : [...values, referenceValue];
  let lo = Math.min(...anchors);
  let hi = Math.max(...anchors);
  if (hi - lo < MIN_SPAN) {
    const grow = (MIN_SPAN - (hi - lo)) / 2;
    lo -= grow;
    hi += grow;
  }
  lo = Math.max(0, lo - 4);
  hi = Math.min(100, hi + 4);
  const span = Math.max(1, hi - lo);

  const times = points.map((p) => p.t);
  const tMin = Math.min(...times);
  const tMax = Math.max(...times);
  const tSpan = tMax - tMin;

  // A single point has no time span to scale against — centre it.
  const x = (t: number) => (tSpan === 0 ? PAD_L + plotW / 2 : PAD_L + ((t - tMin) / tSpan) * plotW);
  const y = (v: number) => PAD_T + (1 - (v - lo) / span) * plotH;

  const coords = points.map((p) => ({ cx: x(p.t), cy: y(p.value), point: p }));
  const linePath = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.cx.toFixed(1)},${c.cy.toFixed(1)}`).join(' ');
  const areaPath = coords.length >= 2
    ? `${linePath} L${coords[coords.length - 1].cx.toFixed(1)},${(PAD_T + plotH).toFixed(1)} L${coords[0].cx.toFixed(1)},${(PAD_T + plotH).toFixed(1)} Z`
    : null;

  const refY = referenceValue == null ? null : y(referenceValue);
  const showRef = refY != null && refY > PAD_T && refY < PAD_T + plotH;

  return (
    <Svg width={width} height={height}>
      <Defs>
        <LinearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={chart.fill} stopOpacity={chart.fillTopOpacity} />
          <Stop offset="1" stopColor={chart.fill} stopOpacity={chart.fillBottomOpacity} />
        </LinearGradient>
      </Defs>

      {/* Reference threshold, labelled — the only place severity is named, and
          it is named in text rather than encoded in colour. */}
      {showRef && (
        <>
          <Line
            x1={PAD_L} y1={refY!} x2={PAD_L + plotW} y2={refY!}
            stroke={chart.reference} strokeWidth={1} strokeDasharray="3 4"
          />
          <SvgText
            x={PAD_L + plotW + 6} y={refY! + 3.5}
            fontSize={10} fill={chart.referenceText}
          >
            {referenceLabel}
          </SvgText>
        </>
      )}

      {areaPath && <Path d={areaPath} fill="url(#trendFill)" />}
      {coords.length >= 2 && (
        <Path
          d={linePath}
          stroke={chart.line}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      )}

      {coords.map((c, i) => (
        <React.Fragment key={i}>
          {/* 2px surface ring keeps overlapping markers legible. */}
          <Circle cx={c.cx} cy={c.cy} r={4.5} fill={chart.surface} />
          <Circle cx={c.cx} cy={c.cy} r={3} fill={chart.line} />
          {/* Touch target, generously larger than the mark itself. */}
          {onPointPress && (
            <Circle
              cx={c.cx} cy={c.cy} r={18}
              fill="transparent"
              onPress={() => onPointPress(c.point, i)}
            />
          )}
        </React.Fragment>
      ))}

      {/* Selective date labels — first and last only, never one per point. */}
      <SvgText x={PAD_L} y={height - 5} fontSize={10} fill={chart.referenceText}>
        {formatDate(tMin)}
      </SvgText>
      {tSpan > 0 && (
        <SvgText
          x={PAD_L + plotW} y={height - 5}
          fontSize={10} fill={chart.referenceText} textAnchor="end"
        >
          {formatDate(tMax)}
        </SvgText>
      )}
    </Svg>
  );
}
