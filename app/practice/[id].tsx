import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, SafeAreaView, ScrollView, ActivityIndicator } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import Animated, {
  FadeIn,
  FadeInRight,
  FadeOut,
  FadeOutLeft,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { Ionicons, FontAwesome6 } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { usePracticePlan } from '../../src/hooks/useDailyPracticePlan';
import { scopeFromParams, scopeToParams, type PlanScope } from '../../src/lib/practicePlan';
import type { PracticeBlock } from '../../src/lib/practiceBlocks';
import {
  usePracticeProgressStore,
  completedBlockIdsFor,
  nextIncompleteBlock,
} from '../../src/store/usePracticeProgressStore';
import { buildRunnerSteps, targetLine, coachHint } from '../../src/lib/practiceCopy';
import { DepthButton } from '../../src/components/practice/DepthButton';
import { PracticeGraphic } from '../../src/components/practice/PracticeGraphic';
import { SignalTiles } from '../../src/components/practice/SignalTiles';
import { CoachBubble } from '../../src/components/practice/CoachBubble';
import { haptic } from '../../src/lib/haptics';
import { colors, spacing, radius } from '../../src/constants/theme';
import { requestMicPermission, startTakeRecording, stopTakeRecording, type Recording } from '../../src/lib/audioCapture';
import { decodeWavFile } from '../../src/services/audioEngine';
import { runEvaluator, type CapturedTake } from '../../src/lib/runEvaluator';
import type { PracticeEvaluation } from '../../src/lib/practiceEvaluator';
import { useCalibrationStore } from '../../src/store/useCalibrationStore';
import { TakeCameraCapture } from '../../src/components/practice/TakeCameraCapture';
import { TuneNoteRow } from '../../src/components/practice/TuneNoteRow';
import { CentsGauge } from '../../src/components/practice/CentsGauge';
import { useMetronome } from '../../src/hooks/useMetronome';
import { useAttemptCompare } from '../../src/hooks/useAttemptCompare';
import { useTakeLiveFeedback } from '../../src/hooks/useTakeLiveFeedback';
import { isMicPitchAvailable, startMicPitch, stopMicPitch } from '../../src/services/micPitch';
import { scaleNoteSequence } from '../../src/lib/scaleSequence';
import { CALIBRATION_ENABLED } from '../../src/constants/featureFlags';

type Phase = 'intro' | 'reps' | 'take' | 'judging' | 'result';

export default function PracticeLessonScreen() {
  const params = useLocalSearchParams<{ id?: string; sessionId?: string; pieceId?: string }>();
  const scope = scopeFromParams(params);
  const plan = usePracticePlan(scope);
  const insets = useSafeAreaInsets();
  const block = useMemo(
    () => plan.blocks.find((candidate) => candidate.id === params.id) ?? plan.blocks[0],
    [plan.blocks, params.id],
  );

  if (!block) {
    return (
      <SafeAreaView style={s.empty}>
        <Text style={s.emptyTitle}>No exercise selected</Text>
        <Pressable style={s.emptyBtn} onPress={() => router.replace('/(tabs)/train')}>
          <Text style={s.emptyBtnText}>Back to warm-up</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  return <PracticeLessonContent key={block.id} block={block} scope={scope} insets={insets} />;
}

function PracticeLessonContent({
  block,
  scope,
  insets,
}: {
  block: PracticeBlock;
  scope: PlanScope;
  insets: ReturnType<typeof useSafeAreaInsets>;
}) {
  const plan = usePracticePlan(scope);
  const scopeParams = useMemo(() => scopeToParams(scope), [scope]);
  const coach = block.coachIntensity;
  const markBlockComplete = usePracticeProgressStore((st) => st.markBlockComplete);
  const completedByPlan = usePracticeProgressStore((st) => st.completedByPlan);
  const completedIds = useMemo(
    () => completedBlockIdsFor({ completedByPlan }, plan.id),
    [completedByPlan, plan.id],
  );

  const [phase, setPhase] = useState<Phase>('intro');
  const [stepIndex, setStepIndex] = useState(0);
  const [capturedTake, setCapturedTake] = useState<CapturedTake | null>(null);
  const [evaluation, setEvaluation] = useState<PracticeEvaluation | null>(null);
  const steps = useMemo(() => buildRunnerSteps(block, coach), [block, coach]);
  const step = steps[stepIndex];

  // Adaptive click-track tempo for rhythm blocks — climbs on a pass, eases back
  // on a miss. Lives here (not in TakePhase) so it survives a retake, since
  // TakePhase unmounts every time phase leaves 'take'.
  const rhythmParams = block.evaluator?.evaluatorId === 'rhythm' ? block.evaluator : null;
  const [rhythmBpm, setRhythmBpm] = useState(rhythmParams?.startBpm ?? 80);
  // Whether the tempo actually moved on the last judged take (it can be
  // clamped at the floor/ceiling), so the result screen's one-liner is exact
  // instead of just assuming pass→faster/fail→slower.
  const [rhythmTempoDirection, setRhythmTempoDirection] = useState<'up' | 'down' | 'same'>('same');
  const RHYTHM_BPM_STEP = 8;

  // Coarse progress across the whole lesson for the top bar.
  const progress =
    phase === 'intro' ? 0.04
    : phase === 'reps' ? 0.1 + 0.6 * ((stepIndex + 1) / steps.length)
    : phase === 'take' ? 0.85
    : phase === 'judging' ? 0.94
    : 1;

  const advanceToNext = () => {
    markBlockComplete(plan.id, block.id);
    const nextBlock = nextIncompleteBlock(plan, [...completedIds, block.id]);
    if (nextBlock) {
      router.replace({ pathname: '/practice/[id]', params: { id: nextBlock.id, ...scopeParams } });
    } else {
      router.replace({ pathname: '/practice/complete', params: scopeParams });
    }
  };

  // Calibration is stubbed out (see CALIBRATION_ENABLED) — bowGeometry blocks
  // run uncalibrated instead of detouring through /practice/calibrate.
  const needsCalibration = () =>
    CALIBRATION_ENABLED &&
    block.evaluator?.evaluatorId === 'bowGeometry' &&
    !useCalibrationStore.getState().calibration;

  const onPrimary = () => {
    haptic.light();
    if (phase === 'intro') {
      if (needsCalibration()) {
        router.push('/practice/calibrate');
        return;
      }
      setPhase('reps');
      setStepIndex(0);
    } else if (phase === 'reps') {
      if (stepIndex < steps.length - 1) setStepIndex((i) => i + 1);
      else setPhase('take');
    }
  };

  const skipToTake = () => {
    haptic.light();
    if (needsCalibration()) {
      router.push('/practice/calibrate');
      return;
    }
    setPhase('take');
  };

  const retake = () => {
    setCapturedTake(null);
    setEvaluation(null);
    setPhase('take');
  };

  const back = () => {
    haptic.light();
    if (phase === 'intro') { router.back(); return; }
    if (phase === 'reps' && stepIndex > 0) { setStepIndex((i) => i - 1); return; }
    if (phase === 'reps') { setPhase('intro'); return; }
    if (phase === 'take') { setPhase('reps'); setStepIndex(steps.length - 1); return; }
    if (phase === 'judging') { retake(); return; }
    if (phase === 'result') { retake(); return; }
  };

  return (
    <View style={s.root}>
      <SafeAreaView style={s.safe}>
        <View style={s.topBar}>
          <Pressable style={s.roundBtn} onPress={back}>
            <Ionicons name="chevron-back" size={21} color="#fff" />
          </Pressable>
          <View style={s.progressTrack}>
            <View style={[s.progressFill, { width: `${Math.max(progress * 100, 4)}%` }]} />
          </View>
          <Pressable
            style={s.roundBtn}
            onPress={() =>
              scope.kind === 'daily'
                ? router.replace('/(tabs)/train')
                : router.replace({ pathname: '/practice/plan', params: scopeParams })
            }
          >
            <Ionicons name="close" size={20} color="#fff" />
          </Pressable>
        </View>

        <Animated.View key={phase} entering={FadeIn.duration(240)} exiting={FadeOut.duration(140)} style={s.phaseWrap}>
          {phase === 'intro' && (
            <IntroPhase
              block={block}
              coach={coach}
              insets={insets}
              onStart={onPrimary}
              onSkipToTake={skipToTake}
            />
          )}
          {phase === 'reps' && (
            <RepsPhase
              block={block}
              coach={coach}
              step={step}
              stepIndex={stepIndex}
              stepCount={steps.length}
              insets={insets}
              onContinue={onPrimary}
            />
          )}
          {phase === 'take' && (
            <TakePhase
              block={block}
              insets={insets}
              rhythmBpm={rhythmBpm}
              onCaptured={(take) => {
                if (block.evaluator) {
                  setCapturedTake(take);
                  setPhase('judging');
                } else {
                  setEvaluation(null);
                  setPhase('result');
                }
              }}
            />
          )}
          {phase === 'judging' && (
            <JudgingPhase
              block={block}
              take={capturedTake}
              onJudged={(result) => {
                setEvaluation(result);
                if (rhythmParams) {
                  setRhythmBpm((bpm) => {
                    const raw = result?.passed ? bpm + RHYTHM_BPM_STEP : bpm - RHYTHM_BPM_STEP;
                    const next = Math.min(rhythmParams.maxBpm, Math.max(rhythmParams.minBpm, raw));
                    setRhythmTempoDirection(next === bpm ? 'same' : next > bpm ? 'up' : 'down');
                    return next;
                  });
                }
                setPhase('result');
              }}
            />
          )}
          {phase === 'result' && (
            <ResultPhase
              block={block}
              insets={insets}
              evaluation={evaluation}
              take={capturedTake}
              nextTempo={rhythmParams ? rhythmBpm : null}
              tempoDirection={rhythmParams ? rhythmTempoDirection : null}
              onPass={advanceToNext}
              onRetry={retake}
            />
          )}
        </Animated.View>
      </SafeAreaView>
    </View>
  );
}

// ─── Intro ────────────────────────────────────────────────────────────────
function IntroPhase({
  block,
  coach,
  insets,
  onStart,
  onSkipToTake,
}: {
  block: PracticeBlock;
  coach: PracticeBlock['coachIntensity'];
  insets: ReturnType<typeof useSafeAreaInsets>;
  onStart: () => void;
  onSkipToTake: () => void;
}) {
  return (
    <>
      <ScrollView style={s.scroll} contentContainerStyle={s.content} showsVerticalScrollIndicator={false}>
        <View style={s.overviewPanel}>
          <View style={s.overviewTop}>
            <View style={s.overviewBadge}>
              <FontAwesome6 name="bullseye" size={18} color={colors.brand[700]} />
            </View>
            <View style={s.overviewCopy}>
              <Text style={s.overviewTitle}>{block.title}</Text>
              <Text style={s.overviewMeta}>About {Math.max(3, block.estimatedMinutes)} min · {coach} coach</Text>
            </View>
          </View>
          <View style={s.overviewList}>
            <OverviewRow label="Why this drill" value={block.reason} />
            <OverviewRow label="Target" value={targetLine(block)} />
            <OverviewRow label="Pass condition" value={block.successCriteria.summary} />
          </View>
        </View>

        <CoachBubble
          tone="dark"
          message="Three things before you record: the exact target, the sound to listen for, and the pass condition. I'll guide the reps from there."
        />

        <TuneNoteRow block={block} />

        <SignalTiles signals={block.liveMode.signals} />
      </ScrollView>

      <View style={[s.bottomBar, s.resultBar, { paddingBottom: Math.max(insets.bottom, spacing.sm) }]}>
        <DepthButton label="Start" icon="arrow-forward" onPress={onStart} />
        {/* The walkthrough is worth reading once, not every time — someone on
            their fifth rep of this drill should be able to just play. */}
        <DepthButton label="Skip to the take" icon="mic" variant="neutral" onPress={onSkipToTake} />
      </View>
    </>
  );
}

// ─── Reps ─────────────────────────────────────────────────────────────────
function RepsPhase({
  block,
  coach,
  step,
  stepIndex,
  stepCount,
  insets,
  onContinue,
}: {
  block: PracticeBlock;
  coach: PracticeBlock['coachIntensity'];
  step: ReturnType<typeof buildRunnerSteps>[number];
  stepIndex: number;
  stepCount: number;
  insets: ReturnType<typeof useSafeAreaInsets>;
  onContinue: () => void;
}) {
  const isLast = stepIndex === stepCount - 1;
  return (
    <>
      <ScrollView style={s.scroll} contentContainerStyle={s.content} showsVerticalScrollIndicator={false}>
        <View style={s.lessonHeader}>
          <Text style={s.lessonKicker}>{block.subtitle}</Text>
          <Text style={s.lessonTitle}>{block.title}</Text>
          <Text style={s.lessonTarget}>{targetLine(block)}</Text>
          <Text style={s.lessonNote}>{block.successCriteria.summary}</Text>
        </View>

        <View style={s.stage}>
          <PracticeGraphic type={block.type} pulseKey={stepIndex} />
        </View>

        <Animated.View
          key={`${block.id}-${stepIndex}`}
          entering={FadeInRight.duration(220)}
          exiting={FadeOutLeft.duration(120)}
          style={s.stepPanel}
        >
          <View style={s.stepTop}>
            <View style={s.stepIcon}>
              <Ionicons name={step.icon as any} size={20} color={colors.brand[700]} />
            </View>
            <Text style={s.stepEyebrow}>{step.eyebrow}</Text>
          </View>
          <Text style={s.stepTitle}>{step.title}</Text>
          <Text style={s.stepBody}>{step.body}</Text>
          <View style={s.callout}>
            <FontAwesome6 name="bullseye" size={15} color="#166534" />
            <Text style={s.calloutText}>{step.callout}</Text>
          </View>
        </Animated.View>

        <CoachBubble tone="dark" message={coachHint(block, stepIndex, coach)} />
        <TuneNoteRow block={block} />
        <SignalTiles signals={block.liveMode.signals} />
      </ScrollView>

      <View style={[s.bottomBar, { paddingBottom: Math.max(insets.bottom, spacing.sm) }]}>
        <DepthButton
          label={isLast ? 'Do your take' : 'Continue'}
          icon={isLast ? 'mic' : 'arrow-forward'}
          onPress={onContinue}
        />
      </View>
    </>
  );
}

// Slow enough for a beginner to place each finger cleanly between clicks.
const SCALE_METRONOME_BPM = 60;
// "Get ready" count-in before a click-paced take's metronome/recording begins —
// enough beats to cover at least 4 seconds at tempo (a faster tempo needs more
// beats to still add up to 4s), computed per-bpm since rhythm takes run at an
// adaptive tempo instead of scale's fixed one.
const MIN_PREP_MS = 4000;
function beatMsFor(bpm: number): number {
  return Math.round(60000 / bpm);
}
function prepBeatsFor(bpm: number): number {
  return Math.max(1, Math.ceil(MIN_PREP_MS / beatMsFor(bpm)));
}
// "Get ready" count-in length for every other exercise (no metronome, so a
// plain numeric countdown instead of beats).
const PREP_SECONDS_DEFAULT = 3;
// Extra recording time past the hold's minimum, so auto-stop doesn't cut the
// note off right at the wire.
const HOLD_STOP_GRACE_S = 1;

// A take ends when the player stops playing, not when a timer runs out — nobody
// should have to sit through (or wait out) a recording. These govern that:
//
// Input above this counts as "playing" (violin at practice distance sits well
// above it; room tone sits well below).
const PLAYING_DBFS = -35;
// Quiet for this long after they've started playing = they're done.
const SILENCE_END_MS = 2000;
// How often the take checks the two conditions above.
const TAKE_CHECK_MS = 250;
// If the mic never hears anything at all, end early rather than record silence —
// the result screen's "couldn't judge that take" state explains it from there.
const NO_INPUT_TIMEOUT_S = 8;
// Pure safety net for a take that somehow never goes quiet (a noisy room, a
// player who never stops). Not the mechanism, just the backstop.
const MAX_TAKE_S = 30;
// A camera take has no mic level to read, so it keeps a fixed window — shown as
// a visible countdown so the player always knows how long they have.
const CAMERA_TAKE_S = 15;
// Fallback window for a block that has no live signal to end itself on at all
// (no mic tap, no camera, no click track) — still needs a visible, known end
// instead of falling through to the silence watcher's blind no-input timeout.
const SELF_REPORT_TAKE_S = 15;

/**
 * A take with a fixed, known length: a timed hold (the task *is* to sustain for
 * N seconds), a camera take (no mic level to end it on), or a self-report block
 * with no live signal at all. Everything else runs open-ended and ends on
 * silence. Scale takes are paced by the metronome.
 */
function fixedTakeSeconds(block: PracticeBlock, canRecordAudio: boolean, canRecordCamera: boolean): number | null {
  if (block.evaluator?.evaluatorId === 'hold') {
    return block.evaluator.minDurationSeconds + HOLD_STOP_GRACE_S;
  }
  if (canRecordCamera) return CAMERA_TAKE_S;
  // Nothing is actually tapping mic level here (no evaluator to feed and no
  // requiresMic), so there is no signal for the silence watcher to end on —
  // give it a fixed, visible window instead of a silent guess-timeout.
  if (!canRecordAudio) return SELF_REPORT_TAKE_S;
  return null;
}

// ─── Take (records a real mic clip whenever the block's live mode calls for
// one, so the "ends when you stop playing" silence watcher always has a real
// mic level to read — including self-report blocks with no evaluator) ──────
function TakePhase({
  block,
  insets,
  rhythmBpm,
  onCaptured,
}: {
  block: PracticeBlock;
  insets: ReturnType<typeof useSafeAreaInsets>;
  /** Current adaptive tempo for a rhythm block, owned by the parent (see
   *  PracticeLessonContent) so it survives a retake. */
  rhythmBpm?: number;
  onCaptured: (take: CapturedTake | null) => void;
}) {
  const canRecordAudio = block.liveMode.requiresMic && !block.liveMode.requiresCamera;
  const canRecordCamera = block.evaluator?.evaluatorId === 'bowGeometry';
  const scaleSequence = useMemo(
    () =>
      block.evaluator?.evaluatorId === 'scale'
        ? scaleNoteSequence(block.evaluator.scaleName, block.evaluator.rootMidiNote)
        : [],
    [block.evaluator],
  );
  const isScale = scaleSequence.length > 0;
  const rhythmParams = block.evaluator?.evaluatorId === 'rhythm' ? block.evaluator : null;
  const isRhythm = !!rhythmParams;
  // Both scale and rhythm takes are paced by a click track instead of ending
  // on silence or a fixed timer.
  const usesMetronome = isScale || isRhythm;
  const metronomeBpm = isScale ? SCALE_METRONOME_BPM : rhythmParams ? (rhythmBpm ?? rhythmParams.startBpm) : SCALE_METRONOME_BPM;
  const metronomeBeatCount = isScale ? scaleSequence.length : rhythmParams ? rhythmParams.beatCount : 0;
  const beatMs = beatMsFor(metronomeBpm);
  // Fixed-length takes (hold, camera, no-live-signal self-report) count down;
  // everything else is open-ended and ends when the player stops playing.
  const fixedSeconds = usesMetronome ? null : fixedTakeSeconds(block, canRecordAudio, canRecordCamera);
  const endsOnSilence = !usesMetronome && fixedSeconds == null;

  const beatTimestampsRef = useRef<number[]>([]);
  const recordingStartedAtRef = useRef(0);
  const metronome = useMetronome(metronomeBpm, metronomeBeatCount, () => {
    beatTimestampsRef.current.push((Date.now() - recordingStartedAtRef.current) / 1000);
  });

  const [recording, setRecording] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [heardPlaying, setHeardPlaying] = useState(false);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const checkRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordingRef = useRef<Recording | null>(null);
  // Silence tracking for an open-ended take.
  const heardPlayingRef = useRef(false);
  const lastSoundAtRef = useRef(0);
  const stoppedRef = useRef(false);
  const [liveActive, setLiveActive] = useState(false);
  const dot = useSharedValue(1);

  // Live pitch while recording, so the player can hear-and-see they're sharp
  // *during* the take instead of being told about it afterwards. Advisory only:
  // the verdict still comes from the recorded clip.
  const live = useTakeLiveFeedback(liveActive, block.target.midiNote);
  const showLive = liveActive && !usesMetronome && !canRecordCamera;

  const clearTimers = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (checkRef.current) clearInterval(checkRef.current);
    timerRef.current = null;
    checkRef.current = null;
  };

  useEffect(() => {
    return () => {
      clearTimers();
      stopMicPitch().catch(() => {});
      if (recordingRef.current) {
        recordingRef.current.stopAndUnloadAsync().catch(() => {});
        recordingRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dotStyle = useAnimatedStyle(() => ({ opacity: dot.value }));

  // The actual recording (+ metronome, for scale) kickoff — separated from
  // `start()` so a scale take can insert a "get ready" countdown first.
  const beginTake = async () => {
    stoppedRef.current = false;
    heardPlayingRef.current = false;
    setHeardPlaying(false);

    if (canRecordCamera) {
      setRecording(true);
      setElapsed(0);
      dot.value = withRepeat(withSequence(withTiming(0.3, { duration: 500 }), withTiming(1, { duration: 500 })), -1, true);
      timerRef.current = setInterval(() => setElapsed((e) => e + 1), 1000);
      return;
    }

    if (canRecordAudio) {
      const granted = await requestMicPermission();
      if (!granted) { setPermissionDenied(true); return; }
      try {
        recordingRef.current = await startTakeRecording((dbfs) => {
          if (dbfs < PLAYING_DBFS) return;
          lastSoundAtRef.current = Date.now();
          if (!heardPlayingRef.current) {
            heardPlayingRef.current = true;
            setHeardPlaying(true);
          }
        });
      } catch {
        setPermissionDenied(true);
        return;
      }
    }

    recordingStartedAtRef.current = Date.now();
    beatTimestampsRef.current = [];
    setRecording(true);
    setElapsed(0);
    dot.value = withRepeat(withSequence(withTiming(0.3, { duration: 500 }), withTiming(1, { duration: 500 })), -1, true);
    timerRef.current = setInterval(() => setElapsed((e) => e + 1), 1000);

    // Started *after* the recorder: the native tap reconfigures the shared audio
    // session, and doing that first can interrupt the clip we're grading on. If
    // it can't start (Android, Expo Go), the take runs fine with no live gauge.
    if (canRecordAudio && !usesMetronome && isMicPitchAvailable()) {
      try {
        await startMicPitch();
        setLiveActive(true);
      } catch {
        setLiveActive(false);
      }
    }

    // An open-ended take ends itself: once the player has started and then goes
    // quiet, they're done. No timer to wait out, no stop button to hunt for.
    if (endsOnSilence) {
      checkRef.current = setInterval(() => {
        const sinceStart = (Date.now() - recordingStartedAtRef.current) / 1000;
        const quietFor = Date.now() - lastSoundAtRef.current;
        const donePlaying = heardPlayingRef.current && quietFor >= SILENCE_END_MS;
        const neverPlayed = !heardPlayingRef.current && sinceStart >= NO_INPUT_TIMEOUT_S;
        if (donePlaying || neverPlayed || sinceStart >= MAX_TAKE_S) stop();
      }, TAKE_CHECK_MS);
    }

    if (usesMetronome) metronome.start();
  };

  const start = () => {
    haptic.medium();
    setPermissionDenied(false);
    setPreparing(true);

    if (usesMetronome) {
      setCountdown(prepBeatsFor(metronomeBpm));
      // Count-in click so the player hears the tempo right away, before the
      // graded take's own metronome starts.
      metronome.playClick();
      return;
    }

    setCountdown(PREP_SECONDS_DEFAULT);
  };

  useEffect(() => {
    if (!preparing) return;
    if (countdown <= 0) {
      setPreparing(false);
      beginTake();
      return;
    }
    const t = setTimeout(() => {
      const next = countdown - 1;
      setCountdown(next);
      // The final count-in beat is beginTake()'s own first click (beat 0) —
      // skip it here so the two don't double up.
      if (usesMetronome && next > 0) metronome.playClick();
    }, usesMetronome ? beatMs : 1000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preparing, countdown]);

  const stop = async () => {
    // The silence watcher, the fixed-length timer and the metronome can all
    // reach the finish line together — only the first one through ends the take.
    if (stoppedRef.current) return;
    stoppedRef.current = true;

    haptic.medium();
    clearTimers();
    if (usesMetronome) metronome.stop();
    setRecording(false);

    // Release the mic tap before touching the recorder: stopping it deactivates
    // the shared audio session, which would interrupt an in-flight recording.
    if (liveActive) {
      setLiveActive(false);
      await stopMicPitch();
    }

    if (canRecordCamera) return; // TakeCameraCapture fires onCaptured on the active→false edge

    if (canRecordAudio && recordingRef.current) {
      const rec = recordingRef.current;
      recordingRef.current = null;
      try {
        const uri = await stopTakeRecording(rec);
        const wav = uri ? await decodeWavFile(uri) : null;
        onCaptured(wav ? {
          samples: wav.samples,
          sampleRate: wav.sampleRate,
          beatTimestamps: usesMetronome ? beatTimestampsRef.current : undefined,
        } : null);
      } catch {
        onCaptured(null);
      }
      return;
    }

    onCaptured(null);
  };

  // The metronome auto-stops one beat after the last note (giving time to
  // play it) — when it does, end the take.
  const metronomeWasRunningRef = useRef(false);
  useEffect(() => {
    if (metronome.running) {
      metronomeWasRunningRef.current = true;
    } else if (metronomeWasRunningRef.current) {
      metronomeWasRunningRef.current = false;
      stop();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metronome.running]);

  // Fixed-length takes (a timed hold, a camera take) end on their own clock;
  // open-ended ones end on silence, in the watcher started by beginTake.
  useEffect(() => {
    if (recording && fixedSeconds && elapsed >= fixedSeconds) {
      stop();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elapsed]);

  const needsCamera = block.liveMode.requiresCamera;
  const currentNote = isScale && metronome.currentBeat >= 0 ? scaleSequence[metronome.currentBeat] : null;
  const nextNote = isScale && metronome.currentBeat >= 0 ? scaleSequence[metronome.currentBeat + 1] : null;

  // How many notes the pass condition is asking for, so the live counter can
  // show progress toward it rather than an unanchored tally.
  const targetReps = block.successCriteria.targetStreak ?? block.successCriteria.repetitions ?? null;

  // A recording take must always answer two questions on screen: what is it
  // doing, and what ends it?
  const remaining = fixedSeconds != null ? Math.max(0, fixedSeconds - elapsed) : 0;
  const recordingLabel = isScale
    ? 'Recording — follow the click'
    : isRhythm
      ? `Beat ${Math.max(0, metronome.currentBeat) + 1} of ${rhythmParams!.beatCount} — ${metronomeBpm} BPM`
      : fixedSeconds != null
        ? `${remaining}s left`
        : heardPlaying
          ? 'Recording'
          : 'Listening…';
  const recordingHint = isScale
    ? 'Play the note shown on each click.'
    : isRhythm
      ? 'Play one note right on every click.'
      : fixedSeconds != null
        ? needsCamera
          ? 'Keep bowing — the take ends on its own.'
          : block.evaluator?.evaluatorId === 'hold'
            ? 'Hold it — the take ends on its own.'
            : 'Play through the drill — the take ends on its own.'
        : heardPlaying
          ? 'Stop playing when you\'re done and the take ends itself.'
          : 'Start playing whenever you\'re ready.';

  if (preparing) {
    return (
      <View style={s.takeWrap}>
        <View style={s.takeBody}>
          <Text style={s.takeKicker}>Get ready</Text>
          <Text style={s.takeTitle}>{block.title}</Text>
          {isScale && scaleSequence[0] && <Text style={s.takeTarget}>First note: {scaleSequence[0]}</Text>}
          {isRhythm && <Text style={s.takeTarget}>Tempo: {metronomeBpm} BPM</Text>}
          <Animated.View entering={FadeIn} style={s.takeCircle}>
            <Text style={s.beatNote}>{countdown > 0 ? countdown : 'Go!'}</Text>
          </Animated.View>
          <Text style={s.takeHint}>Get your bow and hand in position — recording starts automatically.</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={s.takeWrap}>
      {canRecordCamera && (
        <View style={StyleSheet.absoluteFillObject}>
          <TakeCameraCapture
            active={recording}
            onCaptured={(result) => onCaptured({ rawBowFrames: result.bowFrames })}
          />
        </View>
      )}
      <View style={s.takeBody}>
        <Text style={s.takeKicker}>Live take</Text>
        <Text style={s.takeTitle}>{block.title}</Text>
        <Text style={s.takeTarget}>{targetLine(block)}</Text>

        {currentNote ? (
          <Animated.View entering={FadeIn} style={s.takeCircle}>
            <Text style={s.beatNote}>{currentNote}</Text>
            <Text style={s.beatCount}>Beat {metronome.currentBeat + 1} of {scaleSequence.length}</Text>
            {nextNote && <Text style={s.nextNote}>Next note: {nextNote}</Text>}
          </Animated.View>
        ) : isRhythm && recording && metronome.currentBeat >= 0 ? (
          <Animated.View key={metronome.currentBeat} entering={FadeIn.duration(120)} style={s.takeCircle}>
            <Ionicons name="musical-notes" size={48} color="#fff" />
            <Text style={s.beatCount}>Beat {metronome.currentBeat + 1} of {rhythmParams!.beatCount}</Text>
          </Animated.View>
        ) : showLive && recording ? (
          <Animated.View entering={FadeIn} style={s.takeCircle}>
            {live.voiced && live.noteName ? (
              <>
                <Text style={s.beatNote}>{live.noteName}</Text>
                {live.cents != null && (
                  <Text style={s.beatCount}>
                    {live.cents > 0 ? '+' : ''}{Math.round(live.cents)}¢
                  </Text>
                )}
              </>
            ) : (
              <Ionicons name="mic" size={64} color="#fff" />
            )}
          </Animated.View>
        ) : (
          <Animated.View entering={FadeIn} style={s.takeCircle}>
            <Ionicons
              name={recording ? (needsCamera ? 'videocam' : 'mic') : needsCamera ? 'videocam-outline' : 'mic-outline'}
              size={64}
              color="#fff"
            />
          </Animated.View>
        )}

        {showLive && recording && (
          <>
            <CentsGauge cents={live.cents ?? 0} active={live.voiced} />
            {targetReps != null && (
              <Text style={s.liveReps}>
                {Math.min(live.reps, targetReps)} of {targetReps} notes played
              </Text>
            )}
          </>
        )}

        {recording ? (
          <>
            <View style={s.recRow}>
              <Animated.View style={[s.recDot, dotStyle]} />
              <Text style={s.recText}>{recordingLabel}</Text>
            </View>
            <Text style={s.takeHint}>{recordingHint}</Text>
          </>
        ) : permissionDenied ? (
          <Text style={s.takeHint}>Microphone access is needed to judge this take. Enable it in Settings.</Text>
        ) : (
          <>
            <Text style={s.takeHint}>
              {block.liveMode.status === 'unavailable' ? block.fallbackCriteria : `Pass condition: ${block.successCriteria.summary}`}
            </Text>
            <TuneNoteRow block={block} />
          </>
        )}
      </View>

      {!recording && (
        <View style={[s.bottomBar, { paddingBottom: Math.max(insets.bottom, spacing.sm) }]}>
          <DepthButton label="Start take" icon="mic" onPress={start} />
        </View>
      )}
    </View>
  );
}

// ─── Judging (runs the block's evaluator against the captured take) ────────
function JudgingPhase({
  block,
  take,
  onJudged,
}: {
  block: PracticeBlock;
  take: CapturedTake | null;
  onJudged: (evaluation: PracticeEvaluation | null) => void;
}) {
  useEffect(() => {
    // A tick lets the spinner paint before the (synchronous) scoring work runs.
    const timer = setTimeout(() => onJudged(runEvaluator(block.evaluator, take)), 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View style={s.takeWrap}>
      <View style={s.takeBody}>
        <ActivityIndicator size="large" color="#fff" />
        <Text style={s.takeTitle}>Checking your take…</Text>
      </View>
    </View>
  );
}

// ─── Result: self-report fallback (no evaluator) or a real pass/fail verdict ─
function ResultPhase({
  block,
  insets,
  evaluation,
  take,
  nextTempo,
  tempoDirection,
  onPass,
  onRetry,
}: {
  block: PracticeBlock;
  insets: ReturnType<typeof useSafeAreaInsets>;
  evaluation: PracticeEvaluation | null;
  take: CapturedTake | null;
  /** Next attempt's click-track tempo for a rhythm block (already adjusted up
   *  on a pass / down on a miss), so the adaptive loop is visible on screen. */
  nextTempo?: number | null;
  /** Whether nextTempo actually moved, or held at the drill's floor/ceiling. */
  tempoDirection?: 'up' | 'down' | 'same' | null;
  onPass: () => void;
  onRetry: () => void;
}) {
  const bottomInset = Math.max(insets.bottom, spacing.sm);
  const isRhythm = block.evaluator?.evaluatorId === 'rhythm';

  // No evaluator on this block yet — rollout-safe self-report fallback.
  if (!block.evaluator) {
    return (
      <View style={s.takeWrap}>
        <View style={s.takeBody}>
          <View style={s.resultBadge}>
            <Ionicons name="help" size={40} color={colors.brand[700]} />
          </View>
          <Text style={s.takeTitle}>How did that go?</Text>
          <Text style={s.takeHint}>Pass condition: {block.successCriteria.summary}</Text>
        </View>
        <View style={[s.bottomBar, s.resultBar, { paddingBottom: bottomInset }]}>
          <DepthButton label="Nailed it" icon="checkmark" onPress={onPass} />
          <DepthButton label="Try again" icon="refresh" variant="neutral" onPress={onRetry} />
        </View>
      </View>
    );
  }

  const gaugeCents = lastCentsDeviation(evaluation);
  // Rhythm swaps the generic evaluator sentence for a one-line tempo call and
  // the note-name/cents chips for a plain-language early/late/missed list —
  // both are meaningless for a click-track drill.
  const feedbackLine = isRhythm && nextTempo != null
    ? rhythmHeadline(!!evaluation?.passed, tempoDirection ?? 'same', nextTempo)
    : evaluation?.feedback;
  const breakdown = isRhythm
    ? evaluation && <RhythmMissList evaluation={evaluation} />
    : <AttemptChips evaluation={evaluation} take={take} block={block} />;

  if (evaluation?.passed) {
    return (
      <View style={s.takeWrap}>
        <View style={s.takeBody}>
          <View style={[s.resultBadge, s.resultBadgePass]}>
            <Ionicons name="checkmark" size={40} color="#166534" />
          </View>
          <Text style={s.takeTitle}>Nice work</Text>
          <Text style={s.takeHint}>{feedbackLine}</Text>
          {gaugeCents != null && <CentsGauge cents={gaugeCents} active />}
          {breakdown}
        </View>
        <View style={[s.bottomBar, { paddingBottom: bottomInset }]}>
          <DepthButton label="Continue" icon="arrow-forward" onPress={onPass} />
        </View>
      </View>
    );
  }

  // Evaluator couldn't get a usable signal (e.g. mic/camera confidence too low)
  // rather than a genuine miss — point at fallbackCriteria instead of the
  // evaluator's cents/streak feedback, which would be misleading here.
  const couldNotJudge = evaluation != null && evaluation.attempts === 0;
  if (couldNotJudge) {
    return (
      <View style={s.takeWrap}>
        <View style={s.takeBody}>
          <View style={[s.resultBadge, s.resultBadgeWarn]}>
            <Ionicons name="mic-off" size={36} color="#92400e" />
          </View>
          <Text style={s.takeTitle}>Couldn't judge that take</Text>
          <Text style={s.takeHint}>{block.fallbackCriteria}</Text>
        </View>
        <View style={[s.bottomBar, { paddingBottom: bottomInset }]}>
          <DepthButton label="Try again" icon="refresh" onPress={onRetry} />
        </View>
      </View>
    );
  }

  return (
    <View style={s.takeWrap}>
      <View style={s.takeBody}>
        <View style={[s.resultBadge, s.resultBadgeFail]}>
          <Ionicons name="close" size={40} color="#991b1b" />
        </View>
        <Text style={s.takeTitle}>Not yet</Text>
        <Text style={s.takeHint}>{feedbackLine ?? 'Try again.'}</Text>
        {gaugeCents != null && <CentsGauge cents={gaugeCents} active />}
        {breakdown}
      </View>
      <View style={[s.bottomBar, { paddingBottom: bottomInset }]}>
        <DepthButton label="Try again" icon="refresh" onPress={onRetry} />
      </View>
    </View>
  );
}

function lastCentsDeviation(evaluation: PracticeEvaluation | null): number | null {
  const results = evaluation?.attemptResults;
  if (!results || results.length === 0) return null;
  return results[results.length - 1].centsDeviation ?? null;
}

// One sentence, always — the whole point of the adaptive click track is that
// the player never has to guess whether it's about to speed up or slow down.
function rhythmHeadline(passed: boolean, direction: 'up' | 'down' | 'same', nextBpm: number): string {
  if (direction === 'up') return `Nice — let's pick it up to ${nextBpm} BPM.`;
  if (direction === 'down') return `Let's try a slower tempo — ${nextBpm} BPM.`;
  return passed
    ? "Nice — that's the top of this drill's tempo range."
    : `Let's stay at ${nextBpm} BPM and try again.`;
}

function rhythmMissLabel(offsetMs: number | undefined): string {
  if (offsetMs == null) return 'missed — no clear attack heard';
  const dir = offsetMs < 0 ? 'early' : 'late';
  return `${Math.round(Math.abs(offsetMs))}ms ${dir}`;
}

// Plain-language breakdown of which clicks were off, and by how much —
// replaces AttemptChips' cents-chip UI for rhythm, where "+40¢"-style pills
// don't say anything a beginner can act on.
function RhythmMissList({ evaluation }: { evaluation: PracticeEvaluation }) {
  const results = evaluation.attemptResults;
  if (!results) return null;
  const misses = results
    .map((r, i) => ({ ...r, beatNum: i + 1 }))
    .filter((r) => !r.passed);
  if (misses.length === 0) return null;
  return (
    <View style={s.rhythmMissList}>
      {misses.map((r) => (
        <Text key={r.beatNum} style={s.rhythmMissRow}>
          Beat {r.beatNum} — {rhythmMissLabel(r.offsetMs)}
        </Text>
      ))}
    </View>
  );
}

// Per-attempt pass/fail chip row — a scale exercise labels each chip with its
// expected note; other pitch-based evaluators just number the attempts.
// Tapping a chip (when the take's audio + a known target note are both
// available) replays what the player actually played, then the reference
// pitch it was judged against, so they can hear the two back to back.
function AttemptChips({
  evaluation,
  take,
  block,
}: {
  evaluation: PracticeEvaluation | null;
  take: CapturedTake | null;
  block: PracticeBlock;
}) {
  const results = evaluation?.attemptResults;
  const { playingIndex, compare } = useAttemptCompare();
  if (!results || results.length < 2) return null;

  const samples = take?.samples;
  const sampleRate = take?.sampleRate;
  const fallbackLabel = block.target.noteName ?? block.target.pitchClass ?? null;
  const fallbackMidi = block.target.midiNote;
  const anyPlayable = !!samples && !!sampleRate && results.some((r) => r.startTimeSeconds != null && r.endTimeSeconds != null);

  return (
    <>
      <View style={s.chipRow}>
        {results.map((r, i) => {
          const label = r.label ?? fallbackLabel;
          const canPlay = !!samples && !!sampleRate && r.startTimeSeconds != null && r.endTimeSeconds != null;
          return (
            <Pressable
              key={i}
              disabled={!canPlay || playingIndex != null}
              onPress={() =>
                canPlay &&
                compare(
                  i,
                  samples!,
                  sampleRate!,
                  r.startTimeSeconds!,
                  r.endTimeSeconds!,
                  label,
                  r.label ? undefined : fallbackMidi,
                )
              }
              style={[
                s.attemptChip,
                r.passed ? s.attemptChipPass : s.attemptChipFail,
                playingIndex === i && s.attemptChipPlaying,
              ]}
            >
              <Text style={s.attemptChipLabel}>{r.label ?? `#${i + 1}`}</Text>
              {r.centsDeviation != null && (
                <Text style={s.attemptChipCents}>
                  {r.centsDeviation > 0 ? '+' : ''}{Math.round(r.centsDeviation)}¢
                </Text>
              )}
              {canPlay && (
                <Ionicons
                  name={playingIndex === i ? 'volume-high' : 'play'}
                  size={10}
                  color="rgba(255,255,255,0.75)"
                  style={s.attemptChipIcon}
                />
              )}
            </Pressable>
          );
        })}
      </View>
      {anyPlayable && <Text style={s.attemptChipsHint}>Tap a note to hear you vs. the target pitch</Text>}
    </>
  );
}

function OverviewRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={s.overviewRow}>
      <Text style={s.overviewLabel}>{label}</Text>
      <Text style={s.overviewValue}>{value}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.brand[900] },
  safe: { flex: 1 },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xs,
  },
  roundBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.14)',
  },
  progressTrack: {
    flex: 1,
    height: 12,
    borderRadius: 6,
    backgroundColor: 'rgba(255,255,255,0.18)',
    overflow: 'hidden',
  },
  progressFill: { height: '100%', borderRadius: 6, backgroundColor: '#22c55e' },
  phaseWrap: { flex: 1 },
  scroll: { flex: 1 },
  content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg, gap: spacing.md },
  overviewPanel: { backgroundColor: '#fff', borderRadius: radius.xl, padding: spacing.lg, gap: spacing.md },
  overviewTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  overviewBadge: {
    width: 42,
    height: 42,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.brand[50],
  },
  overviewCopy: { flex: 1 },
  overviewTitle: { fontSize: 18, fontWeight: '900', color: colors.text.primary },
  overviewMeta: { marginTop: 2, fontSize: 13, color: colors.text.secondary, fontWeight: '700' },
  overviewList: { gap: spacing.sm },
  overviewRow: { paddingVertical: spacing.sm, borderTopWidth: 1, borderTopColor: '#eef2f7' },
  overviewLabel: {
    fontSize: 11,
    fontWeight: '900',
    color: colors.text.muted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  overviewValue: { marginTop: 3, fontSize: 14, lineHeight: 20, color: colors.text.primary, fontWeight: '700' },
  lessonHeader: { gap: spacing.xs },
  lessonKicker: {
    color: 'rgba(255,255,255,0.58)',
    fontSize: 12,
    fontWeight: '900',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  lessonTitle: { color: '#fff', fontSize: 30, fontWeight: '900' },
  lessonTarget: { color: 'rgba(255,255,255,0.84)', fontSize: 14, lineHeight: 20, fontWeight: '700', marginTop: spacing.xs },
  lessonNote: { color: 'rgba(255,255,255,0.68)', fontSize: 13, lineHeight: 19 },
  stage: { minHeight: 232, alignItems: 'center', justifyContent: 'center' },
  stepPanel: { backgroundColor: '#fff', borderRadius: radius.xl, padding: spacing.lg, gap: spacing.md },
  stepTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  stepIcon: {
    width: 34,
    height: 34,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.brand[50],
  },
  stepEyebrow: { color: colors.brand[700], fontSize: 12, fontWeight: '900', textTransform: 'uppercase', letterSpacing: 0.5 },
  stepTitle: { color: colors.text.primary, fontSize: 24, fontWeight: '900' },
  stepBody: { color: colors.text.secondary, fontSize: 15, lineHeight: 22 },
  callout: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: '#f0fdf4',
    borderRadius: radius.md,
    padding: spacing.md,
  },
  calloutText: { flex: 1, color: '#166534', fontSize: 13, lineHeight: 19, fontWeight: '800' },
  bottomBar: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm, backgroundColor: colors.brand[900] },
  // Take / Result
  takeWrap: { flex: 1 },
  takeBody: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.lg, gap: spacing.sm },
  takeKicker: {
    color: 'rgba(255,255,255,0.58)',
    fontSize: 12,
    fontWeight: '900',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  takeTitle: { color: '#fff', fontSize: 26, fontWeight: '900', textAlign: 'center' },
  takeTarget: { color: 'rgba(255,255,255,0.84)', fontSize: 15, fontWeight: '700', textAlign: 'center' },
  takeCircle: {
    width: 168,
    height: 168,
    borderRadius: 84,
    marginVertical: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.22)',
  },
  takeHint: { color: 'rgba(255,255,255,0.7)', fontSize: 14, lineHeight: 20, textAlign: 'center' },
  beatNote: { color: '#fff', fontSize: 40, fontWeight: '900' },
  beatCount: { color: 'rgba(255,255,255,0.7)', fontSize: 12, fontWeight: '700', marginTop: 4 },
  nextNote: { color: 'rgba(255,255,255,0.6)', fontSize: 13, fontWeight: '600', marginTop: 8 },
  liveReps: { color: 'rgba(255,255,255,0.75)', fontSize: 14, fontWeight: '800', marginTop: spacing.xs },
  recRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  recDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: '#ef4444' },
  recText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  resultBadge: {
    width: 84,
    height: 84,
    borderRadius: 42,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
    marginBottom: spacing.md,
  },
  resultBadgePass: { backgroundColor: '#dcfce7' },
  resultBadgeWarn: { backgroundColor: '#fef3c7' },
  resultBadgeFail: { backgroundColor: '#fee2e2' },
  resultBar: { gap: spacing.sm },
  rhythmMissList: { marginTop: spacing.md, alignItems: 'center', gap: 2 },
  rhythmMissRow: { color: 'rgba(255,255,255,0.75)', fontSize: 13, fontWeight: '700' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: spacing.xs, marginTop: spacing.md },
  attemptChip: { alignItems: 'center', borderRadius: radius.md, paddingHorizontal: spacing.sm, paddingVertical: 6, minWidth: 44 },
  attemptChipPass: { backgroundColor: 'rgba(34,197,94,0.25)' },
  attemptChipFail: { backgroundColor: 'rgba(239,68,68,0.25)' },
  attemptChipPlaying: { borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.8)' },
  attemptChipLabel: { color: '#fff', fontWeight: '800', fontSize: 12 },
  attemptChipCents: { color: 'rgba(255,255,255,0.75)', fontSize: 10, marginTop: 1 },
  attemptChipIcon: { marginTop: 2 },
  attemptChipsHint: { color: 'rgba(255,255,255,0.55)', fontSize: 12, textAlign: 'center', marginTop: spacing.xs },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md, backgroundColor: colors.background },
  emptyTitle: { fontSize: 20, fontWeight: '900', color: colors.text.primary },
  emptyBtn: { backgroundColor: colors.brand[600], borderRadius: radius.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  emptyBtnText: { color: '#fff', fontWeight: '900' },
});
