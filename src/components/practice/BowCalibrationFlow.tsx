import React, { useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import Svg, { Circle, G, Line, Path, Polygon, Rect, Text as SvgText } from 'react-native-svg';
import { computeCalibration, isCalibrationError } from '../../lib/calibrationCompute';
import type { BowCalibration } from '../../types/calibration';
import type { RawBowFrame } from '../../types/signals';
import { radius, spacing } from '../../constants/theme';
import { DepthButton } from './DepthButton';

export type CaptureBowClip = (durationMs: number) => Promise<RawBowFrame[]>;

type Phase = 'intro' | 'position1' | 'position2' | 'review';
type Stage = 'idle' | 'countdown' | 'capturing';

// Time to get into (or move between) position before each 5-second hold.
const COUNTDOWN_SECONDS = 5;
const CAPTURE_MS = 5000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Rendered inside the -90° rotated landscape container on both the Analyze
 * recording screen and /practice/calibrate, so the usable canvas is short
 * (~390pt tall). Layout is a row — visual on the left, copy + actions in a
 * panel on the right — and only the panel is tinted, leaving the camera
 * preview visible where the player needs to see themselves.
 */
export function BowCalibrationFlow({
  captureBowClip,
  onComplete,
  onCancel,
  onSkip,
  completeLabel = 'Done',
}: {
  captureBowClip: CaptureBowClip;
  onComplete: (calibration: BowCalibration) => void;
  onCancel?: () => void;
  /** Skip calibration entirely and continue without it. */
  onSkip?: () => void;
  completeLabel?: string;
}) {
  const [phase, setPhase] = useState<Phase>('intro');
  const [stage, setStage] = useState<Stage>('idle');
  const [countdown, setCountdown] = useState(COUNTDOWN_SECONDS);
  const [error, setError] = useState<string | null>(null);
  const [calibration, setCalibration] = useState<BowCalibration | null>(null);
  const clip1Ref = useRef<RawBowFrame[]>([]);
  const runningRef = useRef(false);

  const captureReference = async (nextPhase: Extract<Phase, 'position1' | 'position2'>) => {
    setPhase(nextPhase);
    setStage('countdown');

    for (let n = COUNTDOWN_SECONDS; n > 0; n -= 1) {
      setCountdown(n);
      await sleep(1000);
    }

    // Keep the countdown running through the hold itself so the screen always
    // shows one number: time to get in position, then time left to hold.
    setStage('capturing');
    const clip = captureBowClip(CAPTURE_MS);
    for (let n = CAPTURE_MS / 1000; n > 0; n -= 1) {
      setCountdown(n);
      await sleep(1000);
    }
    return clip;
  };

  const startCalibration = async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setError(null);
    setCalibration(null);

    const clip1 = await captureReference('position1');
    clip1Ref.current = clip1;
    const clip2 = await captureReference('position2');
    runningRef.current = false;

    const outcome = computeCalibration(clip1, clip2);
    if (isCalibrationError(outcome)) {
      clip1Ref.current = [];
      // Don't loop the player back through calibration — a failed attempt just
      // continues without it (bow metrics fall back to uncalibrated behaviour).
      if (onSkip) {
        onSkip();
        return;
      }
      setError(outcome.error);
      setPhase('intro');
      setStage('idle');
      return;
    }

    setCalibration(outcome);
    setPhase('review');
    setStage('idle');
  };

  if (phase === 'intro') {
    return (
      <Layout
        visual={<ViolinDiagram mode="bridge" />}
        panel={
          <>
            <View style={s.copy}>
              <Text style={s.kicker}>Before you play</Text>
              <Text style={s.title}>Calibration step</Text>
              <Text style={s.subtitle}>
                Teaches the camera where your bow meets the strings, so bow tracking is accurate.
                Two 5-second holds — that's it.
              </Text>
              {error && <Text style={s.error}>{error}</Text>}
            </View>
            <View style={s.actions}>
              <DepthButton label="Calibrate" icon="camera" onPress={startCalibration} />
              {onSkip ? (
                <Pressable style={s.secondaryBtn} onPress={onSkip}>
                  <Text style={s.secondaryText}>Skip</Text>
                </Pressable>
              ) : onCancel ? (
                <Pressable style={s.secondaryBtn} onPress={onCancel}>
                  <Text style={s.secondaryText}>Back</Text>
                </Pressable>
              ) : null}
            </View>
          </>
        }
      />
    );
  }

  if (phase === 'review' && calibration) {
    return (
      <Layout
        visual={
          <View style={s.badge}>
            <Ionicons name="checkmark" size={44} color="#166534" />
          </View>
        }
        panel={
          <>
            <View style={s.copy}>
              <Text style={s.kicker}>Done</Text>
              <Text style={s.title}>Calibration saved</Text>
              <Text style={s.subtitle}>Use the same camera position for this take.</Text>
            </View>
            <View style={s.actions}>
              <DepthButton label={completeLabel} icon="checkmark" onPress={() => onComplete(calibration)} />
            </View>
          </>
        }
      />
    );
  }

  // Capture screens are deliberately sparse: the big diagram, the position
  // name, and one countdown number over a light scrim — nothing to read
  // mid-hold. `stage` still runs the logic but doesn't change this layout.
  const isFirst = phase === 'position1';
  return (
    <View style={s.captureRoot} pointerEvents="none">
      <ViolinDiagram mode={isFirst ? 'bridge' : 'fingerboard'} width={480} />
      <View style={s.captureSide}>
        <Text style={s.captureLabel}>
          {isFirst ? 'Tip at the\nbridge' : 'Frog at the\nfingerboard'}
        </Text>
        <Text style={s.captureCountdown}>{countdown}</Text>
      </View>
    </View>
  );
}

/**
 * Landscape shell: visual on the left over the live camera, copy + actions in the right panel.
 *
 * A SafeAreaView cannot be used here — it reads portrait insets, so inside the
 * -90° container it pads the local top/bottom (the long, unobstructed edges).
 * After the rotation the notch sits on the local left, which is what we pad;
 * the host screen already pads the local right for the home indicator.
 */
function Layout({ visual, panel }: { visual: React.ReactNode; panel: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[s.row, { paddingLeft: insets.top }]}>
      <View style={s.visual}>{visual}</View>
      <View style={s.panel}>{panel}</View>
    </View>
  );
}

// ── Violin diagram ───────────────────────────────────────────────────────────
// Top-down view as the camera sees it: scroll left, body right, strings running
// the length of the instrument, bow crossing them at the contact point being
// calibrated.
//
// The outline is exactly symmetric about the y=80 centre line: the top edge is
// authored as cubics through upper bout (half-width 36) → C-bout corner → flat
// waist (23) → corner → lower bout (43) → end block, and the bottom edge is that
// same run mirrored. Hand-authoring both edges produces a lopsided body.
const BODY_PATH =
  'M138 68 C150 45 162 43 176 44 C186 45 192 48 198 53 C204 56 207 57 212 57 ' +
  'C217 57 221 55 226 52 C234 46 240 37 252 37 C274 38 293 53 297 71 ' +
  'C299 76 299 84 297 89 C293 107 274 122 252 123 C240 123 234 114 226 108 ' +
  'C221 105 217 103 212 103 C207 103 204 104 198 107 C192 112 186 115 176 116 ' +
  'C162 117 150 115 138 92 Z';

// Strings: nut (x=39, tightly spaced) → over the bridge → tailpiece (x=271, fanned).
const STRING_YS: [number, number][] = [
  [76.5, 74], [78.8, 78], [81.2, 82], [83.5, 86],
];

/** One f-hole with its upper and lower eyes; drawn twice, mirrored about y=80. */
function FHole() {
  const ink = 'rgba(255,255,255,0.6)';
  return (
    <>
      <Path d="M236 54 C230 60 228 68 231 76" fill="none" stroke={ink} strokeWidth={2.2} strokeLinecap="round" />
      <Circle cx={237} cy={52} r={2.3} fill={ink} />
      <Circle cx={230} cy={78} r={2.3} fill={ink} />
    </>
  );
}

function ViolinDiagram({ mode, width = 320 }: { mode: 'bridge' | 'fingerboard'; width?: number }) {
  // The bow is vertical — i.e. perpendicular to the strings — in both modes, so
  // the picture itself carries the "stay perpendicular" instruction, and the cyan
  // right-angle marker at the contact point names it.
  //
  // Only the end of the bow that's actually on the strings is drawn; the rest runs
  // off the canvas edge, since a real bow is far longer than this frame. Which end
  // that is, and where it lands, is the whole difference between the two prompts:
  //   bridge      → the TIP is on the strings by the bridge, stick trailing off the
  //                 bottom toward the hand.
  //   fingerboard → the FROG is on the strings by the fingerboard (hand right there),
  //                 stick running off the top.
  const isBridge = mode === 'bridge';
  const bowX = isBridge ? 235 : 172;
  const ink = 'rgba(255,255,255,0.6)';

  return (
    <View style={s.diagramWrap}>
      <Svg width={width} height={(width * 190) / 320} viewBox="0 0 320 190">
        <Path
          d={BODY_PATH}
          fill="rgba(255,255,255,0.14)"
          stroke="rgba(255,255,255,0.75)"
          strokeWidth={2.5}
          strokeLinejoin="round"
        />

        <FHole />
        <G transform="translate(0,160) scale(1,-1)">
          <FHole />
        </G>

        {/* Fingerboard, tapering toward the nut */}
        <Polygon points="56,74 148,69 148,91 56,86" fill="rgba(255,255,255,0.2)" stroke={ink} strokeWidth={2} strokeLinejoin="round" />

        {/* Pegbox + scroll */}
        <Polygon points="35,73 58,75 58,85 35,87" fill="rgba(255,255,255,0.18)" stroke={ink} strokeWidth={2} strokeLinejoin="round" />
        <Circle cx={25} cy={80} r={9.5} fill="rgba(255,255,255,0.14)" stroke="rgba(255,255,255,0.65)" strokeWidth={2} />
        <Circle cx={25} cy={80} r={3.5} fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth={1.5} />

        {/* Tailpiece */}
        <Polygon points="258,71 287,75 287,85 258,89" fill="rgba(255,255,255,0.2)" stroke={ink} strokeWidth={2} strokeLinejoin="round" />

        {/* Bridge — strings cross it here */}
        <Line x1={245} y1={65} x2={245} y2={95} stroke="rgba(255,255,255,0.85)" strokeWidth={4} strokeLinecap="round" />

        {STRING_YS.map(([yNut, yTail]) => (
          <Line key={yNut} x1={39} y1={yNut} x2={271} y2={yTail} stroke="rgba(255,255,255,0.85)" strokeWidth={1.5} />
        ))}

        {/* Right-angle marker: bow ⟂ strings at the contact point */}
        <Path
          d={`M${bowX - 14} 80 L${bowX - 14} 66 L${bowX} 66`}
          fill="none"
          stroke="#22d3ee"
          strokeWidth={1.6}
        />

        {isBridge ? (
          <>
            <Line x1={bowX} y1={56} x2={bowX} y2={190} stroke="#f59e0b" strokeWidth={6} strokeLinecap="round" />
            <Line x1={bowX + 4} y1={64} x2={bowX + 4} y2={190} stroke="#fde68a" strokeWidth={1.8} />
            <Polygon points={`${bowX - 5},68 ${bowX + 5},68 ${bowX},52`} fill="#fbbf24" />
            <SvgText x={bowX + 13} y={62} fill="#fde68a" fontSize={13} fontWeight="800">tip</SvgText>
          </>
        ) : (
          <>
            <Line x1={bowX} y1={0} x2={bowX} y2={104} stroke="#f59e0b" strokeWidth={6} strokeLinecap="round" />
            <Line x1={bowX + 4} y1={0} x2={bowX + 4} y2={96} stroke="#fde68a" strokeWidth={1.8} />
            <Rect x={bowX - 8} y={96} width={16} height={18} rx={3} fill="#fbbf24" stroke="#78350f" strokeWidth={1} />
            <SvgText x={bowX + 14} y={112} fill="#fde68a" fontSize={13} fontWeight="800">frog</SvgText>
          </>
        )}

        {/* Landmark labels. The bridge label shifts clear of the bow in bridge mode. */}
        <SvgText x={140} y={182} fill="rgba(255,255,255,0.8)" fontSize={13} fontWeight="700" textAnchor="middle">
          fingerboard
        </SvgText>
        <SvgText x={isBridge ? 272 : 252} y={182} fill="rgba(255,255,255,0.8)" fontSize={13} fontWeight="700" textAnchor="middle">
          bridge
        </SvgText>
      </Svg>
    </View>
  );
}

const PANEL_WIDTH = 320;

const s = StyleSheet.create({
  row: { flex: 1, flexDirection: 'row' },
  visual: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  panel: {
    width: PANEL_WIDTH,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
    justifyContent: 'space-between',
    backgroundColor: 'rgba(15,23,42,0.86)',
    borderLeftWidth: 1,
    borderLeftColor: 'rgba(255,255,255,0.12)',
  },
  copy: { gap: spacing.xs },
  actions: { gap: spacing.sm },
  kicker: {
    color: 'rgba(255,255,255,0.62)',
    fontSize: 13,
    fontWeight: '900',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  title: {
    color: '#fff',
    fontSize: 28,
    lineHeight: 33,
    fontWeight: '900',
  },
  subtitle: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 17,
    lineHeight: 23,
    fontWeight: '600',
    marginTop: spacing.xs,
  },
  error: {
    color: '#fca5a5',
    fontSize: 16,
    lineHeight: 21,
    fontWeight: '800',
    marginTop: spacing.sm,
  },
  captureRoot: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xl,
    backgroundColor: 'rgba(15,23,42,0.45)',
  },
  captureSide: {
    alignItems: 'center',
    gap: spacing.md,
  },
  captureLabel: {
    color: '#fff',
    fontSize: 26,
    lineHeight: 32,
    fontWeight: '900',
    textAlign: 'center',
  },
  captureCountdown: {
    color: '#fff',
    fontSize: 72,
    lineHeight: 78,
    fontWeight: '900',
    textAlign: 'center',
  },
  secondaryBtn: {
    height: 46,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
  },
  secondaryText: { color: '#fff', fontSize: 16, fontWeight: '900' },
  badge: {
    width: 88,
    height: 88,
    borderRadius: 44,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#dcfce7',
  },
  diagramWrap: { alignItems: 'center', justifyContent: 'center' },
});
