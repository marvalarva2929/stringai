import React, { useEffect, useRef, useState } from 'react';
import {
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ImageSourcePropType,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import Svg, { Circle } from 'react-native-svg';
import { computeCalibration, isCalibrationError } from '../../lib/calibrationCompute';
import type { BowCalibration } from '../../types/calibration';
import type { RawBowFrame } from '../../types/signals';
import { colors, radius, spacing } from '../../constants/theme';
import {
  CALIBRATION_COPY,
  CALIBRATION_POSITIONS,
  type CalibrationPosition,
} from '../../constants/calibrationContent';
import { DepthButton } from './DepthButton';

export type CaptureBowClip = (durationMs: number) => Promise<RawBowFrame[]>;

/** Which card is on screen. */
type Step = 'intro' | 'capture' | 'handoff' | 'review' | 'failed';
/** Within a capture: moving into place, then holding for the clip. */
type Stage = 'prep' | 'hold';

// Time to get into (or move between) position before each hold.
const PREP_MS = 5000;
const CAPTURE_MS = 5000;
// A beat between the two positions. Without it position 1's "1" is followed
// straight by position 2's "5" and the two countdowns read as one.
const HANDOFF_MS = 2200;

const HOLD_COLOR = colors.score.excellent;

/**
 * Rendered inside the -90° rotated landscape container on both the Analyze
 * recording screen and /practice/calibrate, so the usable canvas is short
 * (~390pt tall). Layout is a row — visual on the left, copy + actions in a
 * panel on the right — and only the panel is tinted, leaving the camera
 * preview visible where the player needs to see themselves.
 *
 * The guiding constraint is that by the time the holds run the player is a
 * couple of metres away and cannot touch the phone. So the intro (read in
 * hand) carries the explanation, and each capture screen carries exactly one
 * readable-at-distance instruction: whether to *move* or to *freeze*.
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
  const [step, setStep] = useState<Step>('intro');
  const [stage, setStage] = useState<Stage>('prep');
  const [activeIndex, setActiveIndex] = useState<0 | 1>(0);
  const [remaining, setRemaining] = useState(PREP_MS / 1000);
  const [error, setError] = useState<string | null>(null);
  const [calibration, setCalibration] = useState<BowCalibration | null>(null);
  const runningRef = useRef(false);

  // The sequence is a chain of awaited timers, so it has to be interruptible
  // from outside: if the screen unmounts mid-hold the chain must stop rather
  // than keep calling setState.
  const cancelledRef = useRef(false);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    return () => {
      cancelledRef.current = true;
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, []);

  /**
   * Counts `durationMs` down against a wall-clock deadline. The old version
   * chained `await sleep(1000)`, which drifted by a tick's worth of render
   * time per second and could not be cancelled.
   */
  const runTimer = (durationMs: number) =>
    new Promise<void>((resolve) => {
      const endsAt = Date.now() + durationMs;
      const finish = () => {
        if (tickRef.current) clearInterval(tickRef.current);
        tickRef.current = null;
        resolve();
      };
      const tick = () => {
        if (cancelledRef.current) return finish();
        const left = Math.max(0, endsAt - Date.now());
        setRemaining(left / 1000);
        if (left <= 0) finish();
      };
      tickRef.current = setInterval(tick, 100);
      tick();
    });

  const captureReference = async (position: CalibrationPosition) => {
    setActiveIndex((position.index - 1) as 0 | 1);
    setStep('capture');

    setStage('prep');
    await runTimer(PREP_MS);
    if (cancelledRef.current) return [];

    setStage('hold');
    const clip = captureBowClip(CAPTURE_MS);
    await runTimer(CAPTURE_MS);
    return clip;
  };

  const startCalibration = async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setError(null);
    setCalibration(null);

    const clip1 = await captureReference(CALIBRATION_POSITIONS[0]);
    if (cancelledRef.current) return;

    setStep('handoff');
    await runTimer(HANDOFF_MS);
    if (cancelledRef.current) return;

    const clip2 = await captureReference(CALIBRATION_POSITIONS[1]);
    runningRef.current = false;
    if (cancelledRef.current) return;

    const outcome = computeCalibration(clip1, clip2);
    if (isCalibrationError(outcome)) {
      // Don't silently drop the player into recording — say what went wrong and
      // let them choose. Continuing is still fine: bow metrics just fall back
      // to their uncalibrated behaviour.
      setError(outcome.error);
      setStep('failed');
      return;
    }

    setCalibration(outcome);
    setStep('review');
  };

  if (step === 'intro') {
    const { intro } = CALIBRATION_COPY;
    return (
      <Layout
        visual={<PositionPair showHints />}
        panel={
          <>
            <View style={s.copy}>
              <Text style={s.kicker}>{intro.kicker}</Text>
              <Text style={s.title}>{intro.title}</Text>
              <Text style={s.subtitle}>{intro.body}</Text>
            </View>
            <View style={s.actions}>
              <DepthButton label={intro.cta} icon="camera" onPress={startCalibration} />
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

  if (step === 'handoff') {
    const { handoff } = CALIBRATION_COPY;
    const next = CALIBRATION_POSITIONS[1];
    return (
      <Layout
        visual={<PositionPair activeIndex={1} />}
        panel={
          <View style={s.copy}>
            <Text style={[s.kicker, { color: HOLD_COLOR }]}>{handoff.kicker}</Text>
            <Text style={s.title}>{handoff.title}</Text>
            <Text style={[s.subtitle, { color: next.accent }]}>{next.name}</Text>
          </View>
        }
      />
    );
  }

  if (step === 'failed') {
    const { failure } = CALIBRATION_COPY;
    const continueAnyway = onSkip ?? onCancel;
    return (
      <Layout
        visual={
          <View style={[s.badge, s.badgeWarn]}>
            <Ionicons name="alert" size={44} color="#7c2d12" />
          </View>
        }
        panel={
          <>
            <View style={s.copy}>
              <Text style={s.kicker}>{failure.kicker}</Text>
              <Text style={s.title}>{failure.title}</Text>
              {error && <Text style={s.error}>{error}</Text>}
            </View>
            <View style={s.actions}>
              <DepthButton label={failure.retry} icon="refresh" onPress={startCalibration} />
              {continueAnyway ? (
                <Pressable style={s.secondaryBtn} onPress={continueAnyway}>
                  <Text style={s.secondaryText}>{failure.skip}</Text>
                </Pressable>
              ) : null}
            </View>
          </>
        }
      />
    );
  }

  if (step === 'review' && calibration) {
    const { review } = CALIBRATION_COPY;
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
              <Text style={s.kicker}>{review.kicker}</Text>
              <Text style={s.title}>{review.title}</Text>
              <Text style={s.subtitle}>{review.body}</Text>
            </View>
            <View style={s.actions}>
              <DepthButton label={completeLabel} icon="checkmark" onPress={() => onComplete(calibration)} />
            </View>
          </>
        }
      />
    );
  }

  // ── Capture ────────────────────────────────────────────────────────────────
  // Two stages, and the whole point of this screen is that they cannot be
  // confused: "Get into position" on a draining white ring, then "HOLD STILL"
  // on a filling green one. Previously both stages showed the same bare digit,
  // so the player never knew when the clip had actually started.
  const position = CALIBRATION_POSITIONS[activeIndex];
  const isHold = stage === 'hold';
  const total = (isHold ? CAPTURE_MS : PREP_MS) / 1000;
  const fraction = Math.min(1, Math.max(0, remaining / total));
  const progress = isHold ? 1 - fraction : fraction;
  const ringColor = isHold ? HOLD_COLOR : '#fff';

  return (
    <View style={[s.captureRoot, isHold && s.captureRootHold]} pointerEvents="none">
      <View style={s.captureVisual}>
        <PositionArt mode={position.mode} style={s.captureArt} />
      </View>
      <View style={s.captureSide}>
        <Text style={[s.captureKicker, { color: position.accent }]}>
          Position {position.index} of {CALIBRATION_POSITIONS.length}
        </Text>
        <Text style={[s.captureHeadline, isHold && s.captureHeadlineHold]}>
          {isHold ? CALIBRATION_COPY.hold.headline : CALIBRATION_COPY.prep.headline}
        </Text>
        {/* Constant across both stages — the headline says what to do, this says
            which position, and the diagram beside it says the rest. */}
        <Text style={s.captureSub}>{position.name}</Text>
        <CountdownRing
          seconds={Math.max(1, Math.ceil(remaining))}
          progress={progress}
          color={ringColor}
          label={isHold ? CALIBRATION_COPY.hold.numberLabel : CALIBRATION_COPY.prep.numberLabel}
        />
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

/**
 * Both positions side by side, numbered and captioned. Used on the intro so the
 * player sees the whole task before anything starts, and on the handoff with
 * the position they're moving to highlighted.
 *
 * `showHints` is for the intro only, where the phone is still in hand. On the
 * handoff the player is across the room and won't read them.
 */
function PositionPair({ activeIndex, showHints }: { activeIndex?: 0 | 1; showHints?: boolean }) {
  return (
    <View style={s.pair}>
      {CALIBRATION_POSITIONS.map((position, i) => {
        const dimmed = activeIndex !== undefined && activeIndex !== i;
        return (
          <View key={position.index} style={[s.pairCol, dimmed && s.pairColDim]}>
            <View style={s.pairHeading}>
              <View style={[s.chip, { backgroundColor: position.accent }]}>
                <Text style={s.chipText}>{position.index}</Text>
              </View>
              <Text style={s.pairName} numberOfLines={1}>{position.name}</Text>
            </View>
            <PositionArt mode={position.mode} />
            {showHints && <Text style={s.pairHint}>{position.hint}</Text>}
          </View>
        );
      })}
    </View>
  );
}

/**
 * The countdown digit inside a progress ring, always with a word under it
 * saying what it counts. The ring runs the opposite way in each stage —
 * draining while the player moves, filling while the clip records — so the two
 * back-to-back 5-second counts are distinguishable at a glance from across the
 * room, before any of the text is legible.
 */
function CountdownRing({
  seconds,
  progress,
  color,
  label,
}: {
  seconds: number;
  progress: number;
  color: string;
  label: string;
}) {
  const SIZE = 124;
  const STROKE = 7;
  const r = (SIZE - STROKE) / 2;
  const circumference = 2 * Math.PI * r;
  return (
    <View style={s.ringWrap}>
      <View style={{ width: SIZE, height: SIZE }}>
        <Svg width={SIZE} height={SIZE}>
          <Circle
            cx={SIZE / 2} cy={SIZE / 2} r={r}
            stroke="rgba(255,255,255,0.18)" strokeWidth={STROKE} fill="none"
          />
          <Circle
            cx={SIZE / 2} cy={SIZE / 2} r={r}
            stroke={color} strokeWidth={STROKE} fill="none"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - progress)}
            transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
          />
        </Svg>
        <View style={s.ringCentre}>
          <Text style={[s.ringNumber, { color }]}>{seconds}</Text>
        </View>
      </View>
      <Text style={s.ringLabel}>{label}</Text>
    </View>
  );
}

// ── Position artwork ─────────────────────────────────────────────────────────
// Replaces the schematic violin diagram this flow used to draw in SVG. Those
// two drawings differed only by where a stick crossed the strings, which read
// as the same picture at a glance; these show the whole posture — bow angle,
// where the hand sits, how far along the stick the contact is — so the player
// can copy the pose rather than decode a diagram.
//
// The art is cut out against transparency, so it sits over the live camera
// preview without a card behind it.
const POSITION_ART: Record<'bridge' | 'fingerboard', ImageSourcePropType> = {
  bridge: require('../../../assets/calibration/tip-bridge.png'),
  fingerboard: require('../../../assets/calibration/frog-fingerboard.png'),
};

function PositionArt({
  mode,
  style,
}: {
  mode: 'bridge' | 'fingerboard';
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[s.artWrap, style]}>
      <Image source={POSITION_ART[mode]} style={s.art} resizeMode="contain" />
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
    paddingHorizontal: spacing.md,
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

  // ── Position pair (intro + handoff) ────────────────────────────────────────
  pair: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'center',
    gap: spacing.md,
    width: '100%',
  },
  pairCol: { flex: 1, maxWidth: 230, gap: spacing.xs },
  pairColDim: { opacity: 0.3 },
  pairHeading: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  chip: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipText: { color: '#0f172a', fontSize: 13, fontWeight: '900' },
  pairName: { flex: 1, color: '#fff', fontSize: 15, fontWeight: '900' },
  pairHint: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '600',
  },

  // ── Capture ────────────────────────────────────────────────────────────────
  captureRoot: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.lg,
    paddingHorizontal: spacing.lg,
    backgroundColor: 'rgba(15,23,42,0.45)',
  },
  /** The hold is the one moment the player must not move — tint the whole frame. */
  captureRootHold: { backgroundColor: 'rgba(5,46,22,0.55)' },
  captureVisual: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  captureArt: { maxWidth: 440 },
  captureSide: {
    width: 300,
    flexShrink: 0,
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  captureKicker: {
    fontSize: 15,
    fontWeight: '900',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  captureHeadline: {
    color: '#fff',
    fontSize: 32,
    lineHeight: 37,
    fontWeight: '900',
  },
  /** The single thing that has to read from two metres away. */
  captureHeadlineHold: {
    color: HOLD_COLOR,
    fontSize: 46,
    lineHeight: 50,
    letterSpacing: 1,
  },
  captureSub: {
    color: 'rgba(255,255,255,0.88)',
    fontSize: 18,
    lineHeight: 24,
    fontWeight: '700',
  },

  // ── Countdown ring ─────────────────────────────────────────────────────────
  ringWrap: { alignItems: 'center', alignSelf: 'stretch', gap: spacing.xs },
  ringCentre: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ringNumber: { fontSize: 56, lineHeight: 62, fontWeight: '900' },
  ringLabel: {
    color: 'rgba(255,255,255,0.75)',
    fontSize: 13,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
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
  badgeWarn: { backgroundColor: '#fed7aa' },
  artWrap: { width: '100%', aspectRatio: 1280 / 853 },
  art: { width: '100%', height: '100%' },
});
