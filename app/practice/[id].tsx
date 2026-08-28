import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, SafeAreaView, ScrollView, ActivityIndicator, Dimensions } from 'react-native';
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
import type { PracticeBlock, SequenceStep } from '../../src/lib/practiceBlocks';
import {
  usePracticeProgressStore,
  completedBlockIdsFor,
  nextIncompleteBlock,
} from '../../src/store/usePracticeProgressStore';
import { buildRunnerSteps, targetLine, toneCue } from '../../src/lib/practiceCopy';
import { EvidencePanel } from '../../src/components/practice/EvidencePanel';
import { ThirdPositionGate } from '../../src/components/practice/ThirdPositionGate';
import { useTechniqueSkillStore } from '../../src/store/useTechniqueSkillStore';
import { needsShifting } from '../../src/lib/exercises/types';
import { usePracticeAttemptStore, scoreHistoryFor, type ScoreHistory } from '../../src/store/usePracticeAttemptStore';
import { useAnalysisStore } from '../../src/store/useAnalysisStore';
import { DepthButton } from '../../src/components/practice/DepthButton';
import { PracticeGraphic } from '../../src/components/practice/PracticeGraphic';
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
import { CentsGauge, noteColor } from '../../src/components/practice/CentsGauge';
import { scoreBand, type SequenceScore } from '../../src/lib/sequenceScore';
import { useMetronome } from '../../src/hooks/useMetronome';
import { useMetronomeStore } from '../../src/store/useMetronomeStore';
import { useSequencePreview } from '../../src/hooks/useSequencePreview';
import { useAttemptCompare } from '../../src/hooks/useAttemptCompare';
import { useTakeLiveFeedback } from '../../src/hooks/useTakeLiveFeedback';
import { isMicPitchAvailable, startMicPitch, stopMicPitch } from '../../src/services/micPitch';
import { sequenceStepsFor, sequenceBpmFor, DEFAULT_SEQUENCE_BPM, clampSequenceBpm } from '../../src/lib/sequenceSteps';
import { noteNameToMidi } from '../../src/lib/pitchNaming';
import { CALIBRATION_ENABLED } from '../../src/constants/featureFlags';
import { track } from '../../src/services/analytics';
import { AnalyticsEvent } from '../../src/constants/analyticsEvents';
import { createStopwatch } from '../../src/lib/analyticsTiming';

type Phase = 'intro' | 'reps' | 'take' | 'judging' | 'result';

/**
 * TODO(exercise-sfx): sound effects for the drill loop.
 *
 * The loop currently gives haptics and colour but is silent, and the moments
 * that would carry a sound are already well defined: a note landing clean in
 * the repair drill (app/practice/repair.tsx), a note cleared, a take passing,
 * and the tempo ladder stepping up. Duolingo-ish, and this loop has the same
 * shape — short, repeated, pass/fail.
 *
 * Worth doing as its own pass rather than incrementally: it needs one small set
 * of samples voiced consistently, a mute setting that respects the silent
 * switch, and care not to collide with the metronome click or the reference
 * tone, both of which are already playing during a take.
 */

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

  const addAttempt = usePracticeAttemptStore((st) => st.addAttempt);
  const sessionCache = useAnalysisStore((st) => st.sessionResultCache);
  const metricHistory = useAnalysisStore((st) => st.metricHistory);

  // Which piece this work counts toward. A piece-scoped plan says so directly;
  // a session plan has to trace back through the session it came from. Falls
  // back to metricHistory because sessionResultCache is in-memory only, and
  // progress that vanishes on relaunch is worse than no progress at all.
  const pieceId = useMemo(() => {
    if (scope.kind === 'piece') return scope.pieceId;
    const sessionId = scope.kind === 'session'
      ? scope.sessionId
      : block.evidenceRefs[0]?.sourceSessionId;
    if (!sessionId) return undefined;
    return sessionCache?.[sessionId]?.piece?.id
      ?? metricHistory.find((entry) => entry.sessionId === sessionId)?.pieceId;
  }, [scope, block.evidenceRefs, sessionCache, metricHistory]);

  // A drill that leaves first position must not be handed to someone who has
  // never been taught to shift — they'd invent a fingering and drill it in.
  const thirdPosition = useTechniqueSkillStore((st) => st.thirdPosition);
  const stepsForBlock = useMemo(() => sequenceStepsFor(block.evaluator), [block.evaluator]);
  const blockNeedsShifting = useMemo(
    () => needsShifting(
      stepsForBlock.map((step) => noteNameToMidi(step.note)).filter((m): m is number => m != null),
      block.target.string as never,
    ),
    [stepsForBlock, block.target.string],
  );
  const [gateDismissed, setGateDismissed] = useState(false);
  const showGate = blockNeedsShifting && thirdPosition === 'unknown' && !gateDismissed;

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

  // Manual tempo offset for sequence drills, owned here so it survives a
  // retake — the whole point is that someone who missed at tempo can drop it
  // and go again without losing the setting.
  // Read BEFORE this take is recorded, so the comparison is against past
  // attempts rather than including the one just played.
  const attemptLog = usePracticeAttemptStore((st) => st.attempts);
  const scoreHistory = useMemo(
    () => scoreHistoryFor(attemptLog, block.id),
    [attemptLog, block.id],
  );

  const [bpmOffset, setBpmOffset] = useState(0);
  const baseSequenceBpm = sequenceBpmFor(block.evaluator);
  const sequenceBpm = clampSequenceBpm(baseSequenceBpm + bpmOffset);
  const previewSteps = useMemo(() => sequenceStepsFor(block.evaluator), [block.evaluator]);
  const canAdjustTempo = previewSteps.length > 0;
  const nudgeTempo = (delta: number) => {
    haptic.light();
    setBpmOffset((current) =>
      clampSequenceBpm(baseSequenceBpm + current + delta) - baseSequenceBpm);
  };

  // Coarse progress across the whole lesson for the top bar.
  const progress =
    phase === 'intro' ? 0.04
    : phase === 'reps' ? 0.1 + 0.6 * ((stepIndex + 1) / steps.length)
    : phase === 'take' ? 0.85
    : phase === 'judging' ? 0.94
    : 1;

  // Time-on-block and retake count are the difficulty signal: a drill everyone
  // retakes three times is a drill that needs rewriting.
  const blockWatch = useRef(createStopwatch());
  const retakeCount = useRef(0);

  useEffect(() => {
    blockWatch.current = createStopwatch();
    retakeCount.current = 0;
  }, [block.id]);

  const advanceToNext = () => {
    track(AnalyticsEvent.PRACTICE_BLOCK_COMPLETE, {
      scope: scope.kind,
      block_id: block.id,
      block_type: block.type,
      index: plan.blocks.findIndex((b) => b.id === block.id),
      ms: blockWatch.current.elapsed(),
      retakes: retakeCount.current,
    });
    markBlockComplete(plan.id, block.id);
    // The join between "I did the drill" and "the issue improved". Without this
    // the app can watch a problem get better but can never say its advice had
    // anything to do with it — which is the whole of the piece-progress story.
    addAttempt({
      at: new Date().toISOString(),
      planId: plan.id,
      blockId: block.id,
      blockType: block.type,
      blockTitle: block.title,
      issueIds: block.evidenceRefs.map((ref) => ref.evidenceId),
      pieceId,
      passed: evaluation?.passed,
      successCount: evaluation?.successCount,
      attempts: evaluation?.attempts,
      score: evaluation?.score?.score,
    });
    const nextBlock = nextIncompleteBlock(plan, [...completedIds, block.id]);
    if (nextBlock) {
      router.replace({ pathname: '/practice/[id]', params: { id: nextBlock.id, ...scopeParams } });
    } else {
      router.replace({ pathname: '/practice/complete', params: scopeParams });
    }
  };

  /**
   * Whether to detour a bowGeometry block through /practice/calibrate.
   *
   * `calibrationOffered` is what stops this being a loop. Calibration can now
   * finish without producing a calibration — a capture the camera couldn't
   * read cleanly continues uncalibrated rather than stopping the player (see
   * BowCalibrationFlow) — and so can the Skip button. Both return here with
   * the store still empty, and without this latch the next press of Start
   * would send them straight back to calibrate, forever.
   *
   * One offer per block. Decline it, or have it come back empty, and the drill
   * runs uncalibrated.
   */
  const calibrationOffered = useRef(false);
  useEffect(() => { calibrationOffered.current = false; }, [block.id]);

  const needsCalibration = () =>
    CALIBRATION_ENABLED &&
    !calibrationOffered.current &&
    block.evaluator?.evaluatorId === 'bowGeometry' &&
    !useCalibrationStore.getState().calibration;

  const goCalibrate = () => {
    calibrationOffered.current = true;
    router.push('/practice/calibrate');
  };

  const onPrimary = () => {
    haptic.light();
    if (phase === 'intro') {
      if (needsCalibration()) {
        goCalibrate();
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
    track(AnalyticsEvent.PRACTICE_BLOCK_SKIP_TAKE, { block_id: block.id, block_type: block.type });
    if (needsCalibration()) {
      goCalibrate();
      return;
    }
    setPhase('take');
  };

  /**
   * Leave this drill and move on without passing it.
   *
   * Beta feedback: the exercise loop had no way out of a drill you could not
   * pass. "Not yet" offered try-again and nothing else, and "Couldn't judge
   * that take" offered only try-again — so a player whose mic, camera or
   * playing wasn't landing could retake forever and never reach the next block.
   *
   * The block is deliberately NOT marked complete and no attempt is logged: a
   * skipped drill is unfinished work, and counting it as done would poison the
   * did-the-drill-help join that advanceToNext exists to record. Excluding it
   * from the nextIncompleteBlock search by id is what stops the plan handing
   * the same block straight back.
   */
  const skipBlock = () => {
    haptic.light();
    track(AnalyticsEvent.PRACTICE_BLOCK_SKIP, {
      scope: scope.kind,
      block_id: block.id,
      block_type: block.type,
      ms: blockWatch.current.elapsed(),
      retakes: retakeCount.current,
    });
    const nextBlock = nextIncompleteBlock(plan, [...completedIds, block.id]);
    if (nextBlock) {
      router.replace({ pathname: '/practice/[id]', params: { id: nextBlock.id, ...scopeParams } });
    } else {
      router.replace({ pathname: '/practice/plan', params: scopeParams });
    }
  };

  /** Out of the practice flow entirely, from any phase. */
  const exitPractice = () => {
    haptic.light();
    if (scope.kind === 'daily') router.replace('/(tabs)/train');
    else router.replace({ pathname: '/practice/plan', params: scopeParams });
  };

  const retake = () => {
    retakeCount.current += 1;
    track(AnalyticsEvent.PRACTICE_BLOCK_RETAKE, {
      block_id: block.id,
      block_type: block.type,
      attempt: retakeCount.current,
    });
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

  if (showGate) {
    return (
      <SafeAreaView style={s.safe}>
        <ThirdPositionGate
          onAnswered={() => setGateDismissed(true)}
          onDismiss={() => { setGateDismissed(true); router.back(); }}
        />
      </SafeAreaView>
    );
  }

  return (
    <View style={s.root}>
      <SafeAreaView style={s.safe}>
        <View style={s.topBar}>
          <Pressable style={s.roundBtn} onPress={back} hitSlop={12} accessibilityLabel="Back">
            <Ionicons name="chevron-back" size={21} color="#fff" />
          </Pressable>
          <View style={s.progressTrack}>
            <View style={[s.progressFill, { width: `${Math.max(progress * 100, 4)}%` }]} />
          </View>
          {/* The way out, from every phase including mid-take. hitSlop because
              a 40pt circle in the corner is the control people reach for when
              a drill has them stuck, and missing it is how a screen earns a
              reputation for being hard to leave. */}
          <Pressable style={s.roundBtn} onPress={exitPractice} hitSlop={12} accessibilityLabel="Exit practice">
            <Ionicons name="close" size={20} color="#fff" />
          </Pressable>
        </View>

        <Animated.View key={phase} entering={FadeIn.duration(240)} exiting={FadeOut.duration(140)} style={s.phaseWrap}>
          {phase === 'intro' && (
            <IntroPhase
              block={block}
              coach={coach}
              insets={insets}
              previewSteps={previewSteps}
              tempo={canAdjustTempo ? sequenceBpm : null}
              onTempoChange={nudgeTempo}
              onStart={onPrimary}
              onSkipToTake={skipToTake}
            />
          )}
          {phase === 'reps' && (
            <RepsPhase
              block={block}
              coach={coach}
              previewSteps={previewSteps}
              previewBpm={canAdjustTempo ? sequenceBpm : DEFAULT_SEQUENCE_BPM}
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
              bpmOffset={bpmOffset}
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
              scoreHistory={scoreHistory}
              slowerTempo={canAdjustTempo ? clampSequenceBpm(sequenceBpm - BPM_STEP) : null}
              onSlower={() => { nudgeTempo(-BPM_STEP); retake(); }}
              onPass={advanceToNext}
              onRetry={retake}
              onSkip={skipBlock}
              onRepair={(targets) =>
                router.push({
                  pathname: '/practice/repair',
                  params: {
                    notes: targets.map((t) => t.note).join(','),
                    // Positional: blank where the miss was the first note played.
                    from: targets.map((t) => t.from ?? '').join(','),
                    // Only some evaluators grade pitch; the repair screen falls
                    // back to its own default when this is absent.
                    cents: String(
                      block.evaluator && 'centsThreshold' in block.evaluator
                        ? block.evaluator.centsThreshold
                        : '',
                    ),
                    // Block ids contain a colon (slug:evidenceId), so the way
                    // back is params on the [id] route — never a built path.
                    blockId: block.id,
                    ...scopeParams,
                  },
                })
              }
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
  previewSteps,
  tempo,
  onTempoChange,
  onStart,
  onSkipToTake,
}: {
  block: PracticeBlock;
  coach: PracticeBlock['coachIntensity'];
  insets: ReturnType<typeof useSafeAreaInsets>;
  /** The exercise's notes, so it can be played back before the take. */
  previewSteps: SequenceStep[];
  /** Current click tempo for a paced drill; null when the drill isn't paced. */
  tempo: number | null;
  onTempoChange: (delta: number) => void;
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
        </View>

        {/* First thing on the screen, deliberately: hearing the exercise is the
            most useful thing you can do before playing it, and buried under the
            evidence panel it sat below the fold and went unseen. */}
        {previewSteps.length > 0 && (
          <PreviewRow steps={previewSteps} bpm={tempo ?? DEFAULT_SEQUENCE_BPM} />
        )}

        {tempo != null && <TempoRow tempo={tempo} onChange={onTempoChange} />}

        {/* The case for this drill: the clip, the finding, the comparison, and
            the bridge to what you're about to play. */}
        <EvidencePanel block={block} />

        <CoachBubble
          tone="dark"
          message={`Listen for ${toneCue(block)}, then record — I'll grade every note.`}
        />

        <TuneNoteRow block={block} />
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
/**
 * "Hear the exercise" — the whole sequence, in order, at tempo.
 *
 * Reading a column of note names and imagining how they go is a separate skill
 * from the one the drill is training. Hearing it once is how anyone learns a
 * passage from a teacher.
 */
function PreviewRow({ steps, bpm }: { steps: SequenceStep[]; bpm: number }) {
  const preview = useSequencePreview(steps, bpm);
  return (
    <Pressable
      style={({ pressed }) => [s.previewRow, pressed && s.previewRowPressed]}
      onPress={preview.toggle}
      disabled={preview.loading}
    >
      <View style={s.previewIcon}>
        {preview.loading
          ? <ActivityIndicator color={colors.brand[700]} />
          : <Ionicons name={preview.playing ? 'stop' : 'play'} size={20} color={colors.brand[700]} />}
      </View>
      <View style={s.previewCopy}>
        <Text style={s.previewLabel}>
          {preview.playing ? 'Playing the exercise…' : 'Hear the exercise'}
        </Text>
        <Text style={s.previewHint}>
          All {steps.length} notes in order at {bpm} BPM — how it should sound.
        </Text>
      </View>
    </Pressable>
  );
}

/**
 * Tempo control for a click-paced drill.
 *
 * Prescribing a tempo and offering no way to change it makes the drill a test
 * rather than practice — the player who can't keep up has nothing to do but
 * fail it repeatedly. Slowing down until it's clean is the actual method.
 */
function TempoRow({ tempo, onChange }: { tempo: number; onChange: (delta: number) => void }) {
  return (
    <View style={s.tempoRow}>
      <View style={s.tempoCopy}>
        <Text style={s.tempoLabel}>Tempo</Text>
        <Text style={s.tempoHint}>Slow it down until every note lands, then build back up.</Text>
      </View>
      <Pressable
        style={({ pressed }) => [s.tempoBtn, pressed && s.tempoBtnPressed]}
        onPress={() => onChange(-BPM_STEP)}
        hitSlop={6}
        accessibilityLabel="Slower"
      >
        <Ionicons name="remove" size={20} color={colors.brand[700]} />
      </Pressable>
      <View style={s.tempoValue}>
        <Text style={s.tempoNumber}>{tempo}</Text>
        <Text style={s.tempoUnit}>BPM</Text>
      </View>
      <Pressable
        style={({ pressed }) => [s.tempoBtn, pressed && s.tempoBtnPressed]}
        onPress={() => onChange(BPM_STEP)}
        hitSlop={6}
        accessibilityLabel="Faster"
      >
        <Ionicons name="add" size={20} color={colors.brand[700]} />
      </Pressable>
    </View>
  );
}

function RepsPhase({
  block,
  coach,
  step,
  stepIndex,
  stepCount,
  previewSteps,
  previewBpm,
  insets,
  onContinue,
}: {
  block: PracticeBlock;
  coach: PracticeBlock['coachIntensity'];
  /** The exercise's notes, so it can be played back before the take. */
  previewSteps: SequenceStep[];
  previewBpm: number;
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
        {/* Everything here has to earn its place: this is the screen standing
            between the player and playing, and it should not scroll. What was
            removed and why — a 260px graphic that said nothing the title didn't,
            a coach bubble of generic advice ("keep it slow"), a row of pills
            naming the signals the block listens to (not actionable, not
            interactive), and a callout that restated the instructions. */}
        <View style={s.lessonHeader}>
          <Text style={s.lessonTitle}>{block.title}</Text>
          <Text style={s.lessonTarget}>{targetLine(block)}</Text>
        </View>

        <View style={s.stage}>
          <PracticeGraphic type={block.type} size={140} pulseKey={stepIndex} />
        </View>

        <Animated.View
          key={`${block.id}-${stepIndex}`}
          entering={FadeInRight.duration(220)}
          exiting={FadeOutLeft.duration(120)}
          style={s.stepPanel}
        >
          {step.bodyLines.map((line, i) => (
            <View key={i} style={s.stepLine}>
              <Text style={s.stepBullet}>{i + 1}</Text>
              <Text style={s.stepBody}>{line}</Text>
            </View>
          ))}
        </Animated.View>

        <Text style={s.lessonNote}>{block.successCriteria.summary}</Text>

        {/* Last chance to hear the exercise, and to tune, before the take. */}
        {previewSteps.length > 0 && (
          <PreviewRow steps={previewSteps} bpm={previewBpm} />
        )}
        <TuneNoteRow block={block} />
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

// "Get ready" count-in before a click-paced take's metronome/recording begins —
// enough beats to cover at least 4 seconds at tempo (a faster tempo needs more
// beats to still add up to 4s), computed per-bpm since rhythm and acceleration
// takes run at tempos the drill chooses.
const MIN_PREP_MS = 4000;

/** How far one tap moves a sequence drill's tempo. */
const BPM_STEP = 6;

function beatMsFor(bpm: number): number {
  return Math.round(60000 / bpm);
}
function prepBeatsFor(bpm: number): number {
  return Math.max(1, Math.ceil(MIN_PREP_MS / beatMsFor(bpm)));
}
// "Get ready" count-in length for every other exercise (no metronome, so a
// plain numeric countdown instead of beats).
const PREP_SECONDS_DEFAULT = 3;

// The note circle scales with the screen. takeBody centres its children and
// does not scroll, so a fixed size that looks generous on a Pro Max pushes the
// counters off the bottom of an SE.
const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');
const NOTE_CIRCLE = Math.round(
  Math.max(150, Math.min(220, Math.min(SCREEN_W * 0.55, SCREEN_H * 0.26))),
);

/** The gauge reads ±50¢; past that a number is a wrong note, not a needle. */
const GAUGE_RANGE_CENTS = 50;
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
// How long to wait for TakeCameraCapture to hand back the frames after a camera
// take ends before giving up and delivering an empty one. Generous: this is a
// backstop against the module never answering, not a deadline for normal work.
const CAMERA_HANDOFF_TIMEOUT_MS = 5000;
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
  bpmOffset = 0,
  onCaptured,
}: {
  block: PracticeBlock;
  insets: ReturnType<typeof useSafeAreaInsets>;
  /** Current adaptive tempo for a rhythm block, owned by the parent (see
   *  PracticeLessonContent) so it survives a retake. */
  rhythmBpm?: number;
  /** Player's manual tempo adjustment for a sequence drill, in BPM. */
  bpmOffset?: number;
  onCaptured: (take: CapturedTake | null) => void;
}) {
  const canRecordAudio = block.liveMode.requiresMic && !block.liveMode.requiresCamera;
  const canRecordCamera = block.evaluator?.evaluatorId === 'bowGeometry';
  // The note-per-click list this take will show and be graded against — one
  // source, shared with runEvaluator, so the screen can never disagree with
  // the verdict about which note beat i was.
  const steps = useMemo(() => sequenceStepsFor(block.evaluator), [block.evaluator]);
  const isSequence = steps.length > 0;
  const rhythmParams = block.evaluator?.evaluatorId === 'rhythm' ? block.evaluator : null;
  const isRhythm = !!rhythmParams;
  // Both sequence and rhythm takes are paced by a click track instead of ending
  // on silence or a fixed timer.
  const usesMetronome = isSequence || isRhythm;
  // A sequence drill's tempo is the player's to lower. Struggling at the
  // prescribed tempo is the normal case, not a failure state, and a drill you
  // can only attempt at one speed is a drill most people abandon.
  const baseBpm = isSequence
    ? sequenceBpmFor(block.evaluator)
    : rhythmParams
      ? (rhythmBpm ?? rhythmParams.startBpm)
      : DEFAULT_SEQUENCE_BPM;
  // Rhythm blocks run their own adaptive tempo ladder, so manual override only
  // applies to sequence drills.
  const metronomeBpm = isSequence ? clampSequenceBpm(baseBpm + bpmOffset) : baseBpm;
  const metronomeBeatCount = isSequence ? steps.length : rhythmParams ? rhythmParams.beatCount : 0;
  // Fixed-length takes (hold, camera, no-live-signal self-report) count down;
  // everything else is open-ended and ends when the player stops playing.
  const fixedSeconds = usesMetronome ? null : fixedTakeSeconds(block, canRecordAudio, canRecordCamera);
  const endsOnSilence = !usesMetronome && fixedSeconds == null;

  const beatTimestampsRef = useRef<number[]>([]);
  const recordingStartedAtRef = useRef(0);
  // Only `sound` is read, not `enabled`: a drill that grades against beat timestamps
  // needs the metronome running regardless: the setting governs whether the player
  // HEARS it, and the beat callbacks still drive the on-screen pulse when muted.
  const metronomeSoundOn = useMetronomeStore((s) => s.sound);
  const metronome = useMetronome(metronomeBpm, metronomeBeatCount, () => {
    beatTimestampsRef.current.push((Date.now() - recordingStartedAtRef.current) / 1000);
  }, { muted: !metronomeSoundOn });

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

  // The note the player is being asked for right now, on a paced take.
  const currentStep = isSequence && metronome.currentBeat >= 0 ? steps[metronome.currentBeat] : null;
  const nextStep = isSequence && metronome.currentBeat >= 0 ? steps[metronome.currentBeat + 1] : null;

  // Live pitch while recording, so the player can hear-and-see they're sharp
  // *during* the take instead of being told about it afterwards. Advisory only:
  // the verdict still comes from the recorded clip.
  //
  // On a paced take the target changes every click, so the gauge follows the
  // note currently on screen rather than the block's single overall target —
  // otherwise it would read every note but one as wildly out of tune.
  const liveTargetMidi = isSequence
    ? (currentStep ? noteNameToMidi(currentStep.note) ?? undefined : undefined)
    : block.target.midiNote;
  const live = useTakeLiveFeedback(liveActive, liveTargetMidi);
  // Sequence takes get the gauge too: hearing that you're 20¢ flat while the
  // note is still sounding is the whole point of a tuning exercise, and waiting
  // until the take is graded to find out is far too late to fix it.
  const showLive = liveActive && !isRhythm && !canRecordCamera;

  // A take is handed to the parent exactly once. The camera path can be
  // answered by either TakeCameraCapture or the watchdog below, and a take
  // delivered twice would judge, then re-judge, and land the player back on a
  // spinner they had already left.
  const deliveredRef = useRef(false);
  const cameraWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deliver = (take: CapturedTake | null) => {
    if (deliveredRef.current) return;
    deliveredRef.current = true;
    if (cameraWatchdogRef.current) clearTimeout(cameraWatchdogRef.current);
    cameraWatchdogRef.current = null;
    onCaptured(take);
  };

  const clearTimers = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (checkRef.current) clearInterval(checkRef.current);
    if (cameraWatchdogRef.current) clearTimeout(cameraWatchdogRef.current);
    timerRef.current = null;
    checkRef.current = null;
    cameraWatchdogRef.current = null;
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
    deliveredRef.current = false;
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
        const started = await startTakeRecording((dbfs) => {
          if (dbfs < PLAYING_DBFS) return;
          lastSoundAtRef.current = Date.now();
          if (!heardPlayingRef.current) {
            heardPlayingRef.current = true;
            setHeardPlaying(true);
          }
        });
        recordingRef.current = started.recording;
        // The recorder's own start instant, not "whenever this resolved" — beat
        // times below are expressed relative to it, so any slack here would land
        // on the player's timing score as lateness. See StartedTake.startedAtMs.
        recordingStartedAtRef.current = started.startedAtMs;
      } catch {
        setPermissionDenied(true);
        return;
      }
    } else {
      recordingStartedAtRef.current = Date.now();
    }

    beatTimestampsRef.current = [];
    setRecording(true);
    setElapsed(0);
    dot.value = withRepeat(withSequence(withTiming(0.3, { duration: 500 }), withTiming(1, { duration: 500 })), -1, true);
    timerRef.current = setInterval(() => setElapsed((e) => e + 1), 1000);

    // Started *after* the recorder: the native tap reconfigures the shared audio
    // session, and doing that first can interrupt the clip we're grading on. If
    // it can't start (Android, Expo Go), the take runs fine with no live gauge.
    if (canRecordAudio && !isRhythm && isMicPitchAvailable()) {
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

    // The metronome runs the count-in and the graded beats on one clock, so
    // the recorder's async startup above lands entirely before the first click
    // rather than in the gap between two of them.
    if (usesMetronome) {
      setPreparing(false);
      metronome.start({ leadInBeats: prepBeatsFor(metronomeBpm) });
    }
  };

  const start = () => {
    haptic.medium();
    setPermissionDenied(false);
    setPreparing(true);

    // A click-paced take opens the mic first and counts in from the metronome
    // itself; only the un-paced takes need the screen's own countdown.
    if (usesMetronome) {
      beginTake();
      return;
    }

    setCountdown(PREP_SECONDS_DEFAULT);
  };

  useEffect(() => {
    if (!preparing || usesMetronome) return;
    if (countdown <= 0) {
      setPreparing(false);
      beginTake();
      return;
    }
    const t = setTimeout(() => setCountdown(countdown - 1), 1000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preparing, countdown, usesMetronome]);

  const stop = async () => {
    // The silence watcher, the fixed-length timer and the metronome can all
    // reach the finish line together — only the first one through ends the take.
    if (stoppedRef.current) return;
    stoppedRef.current = true;

    haptic.medium();
    clearTimers();
    if (usesMetronome) metronome.stop();
    setRecording(false);

    // Releasing the mic tap deactivates the shared AVAudioSession
    // (MicPitchModule.stopEngine ends with setActive(false)), so it has to happen
    // *after* the recorder has been stopped and its file finalized. The previous
    // order released the tap first — which is the very hazard the comment here
    // used to warn about — and could truncate the tail of the WAV the evaluators
    // then graded.
    const releaseLiveTap = async () => {
      if (!liveActive) return;
      setLiveActive(false);
      await stopMicPitch();
    };

    if (canRecordCamera) {
      // TakeCameraCapture fires onCaptured on the active→false edge — which is
      // the only thing that ends a camera take. If the native module never
      // answers (module missing, capture already torn down), the screen would
      // sit here with the take over, no spinner, and nothing to press. Hand up
      // an empty take instead: the result screen says it couldn't judge it and
      // offers a retake or a skip, both of which are ways forward.
      await releaseLiveTap();
      cameraWatchdogRef.current = setTimeout(() => deliver(null), CAMERA_HANDOFF_TIMEOUT_MS);
      return;
    }

    if (canRecordAudio && recordingRef.current) {
      const rec = recordingRef.current;
      recordingRef.current = null;
      let uri: string | null = null;
      try {
        uri = await stopTakeRecording(rec);
      } finally {
        await releaseLiveTap();
      }
      try {
        const wav = uri ? await decodeWavFile(uri) : null;
        deliver(wav ? {
          samples: wav.samples,
          sampleRate: wav.sampleRate,
          beatTimestamps: usesMetronome ? beatTimestampsRef.current : undefined,
        } : null);
      } catch {
        deliver(null);
      }
      return;
    }

    await releaseLiveTap();
    deliver(null);
  };

  /**
   * Abandon a take that is counting in or already running and go back to the
   * idle "Start take" screen.
   *
   * Beta feedback: every recording state was a state with no visible way out —
   * the bottom bar only existed when `recording` was false, so a paced take,
   * a count-in, or a silence watcher that never fired left the player with
   * nothing to press.
   */
  const cancelTake = async () => {
    stoppedRef.current = true;
    deliveredRef.current = true;   // nothing from this take reaches the evaluator
    clearTimers();
    if (usesMetronome) metronome.stop();
    setPreparing(false);
    setCountdown(0);
    setRecording(false);
    // Same ordering rule as stop(): finalize the recorder before releasing the
    // mic tap, which deactivates the shared audio session.
    const rec = recordingRef.current;
    recordingRef.current = null;
    if (rec) await stopTakeRecording(rec).catch(() => {});
    if (liveActive) {
      setLiveActive(false);
      await stopMicPitch().catch(() => {});
    }
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
  // How many notes the pass condition is asking for, so the live counter can
  // show progress toward it rather than an unanchored tally.
  const targetReps = block.successCriteria.targetStreak ?? block.successCriteria.repetitions ?? null;

  // A recording take must always answer two questions on screen: what is it
  // doing, and what ends it?
  const remaining = fixedSeconds != null ? Math.max(0, fixedSeconds - elapsed) : 0;
  const recordingLabel = isSequence
    ? `Note ${Math.max(0, metronome.currentBeat) + 1} of ${steps.length} — follow the ${metronomeSoundOn ? 'click' : 'beat'}`
    : isRhythm
      ? `Beat ${Math.max(0, metronome.currentBeat) + 1} of ${rhythmParams!.beatCount} — ${metronomeBpm} BPM`
      : fixedSeconds != null
        ? `${remaining}s left`
        : heardPlaying
          ? 'Recording'
          : 'Listening…';
  const recordingHint = isSequence
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

  // A click-paced take counts in on the metronome's own clock (the mic is
  // already open by then), so its "get ready" is driven by leadInRemaining
  // rather than by the screen's separate countdown.
  const countingIn = metronome.inLeadIn;
  // A click-paced take opens the mic before it counts in, so there is a beat
  // of dead time first. Showing the countdown's "Go!" there would tell the
  // player to start playing while nothing is listening yet.
  const openingMic = preparing && usesMetronome;
  if (preparing || countingIn) {
    const remaining = countingIn ? metronome.leadInRemaining : countdown;
    return (
      <View style={s.takeWrap}>
        <View style={s.takeBody}>
          <Text style={s.takeKicker}>Get ready</Text>
          <Text style={s.takeTitle}>{block.title}</Text>
          {isSequence && steps[0] && (
            <Text style={s.takeTarget}>
              First note: {steps[0].note}{steps[0].annotation ? ` · ${steps[0].annotation}` : ''}
            </Text>
          )}
          {isRhythm && <Text style={s.takeTarget}>Tempo: {metronomeBpm} BPM</Text>}
          <Animated.View entering={FadeIn} style={s.takeCircle}>
            {openingMic ? (
              <ActivityIndicator color="#fff" size="large" />
            ) : (
              <Text style={s.beatNote}>{remaining > 0 ? remaining : 'Go!'}</Text>
            )}
          </Animated.View>
          <Text style={s.takeHint}>
            {openingMic
              ? 'Opening the mic — the count-in starts in a moment.'
              : countingIn
                ? 'Counting you in — play on the next click after this.'
                : 'Get your bow and hand in position — recording starts automatically.'}
          </Text>
        </View>
        <View style={[s.bottomBar, { paddingBottom: Math.max(insets.bottom, spacing.sm) }]}>
          <DepthButton label="Cancel" icon="close" variant="neutral" onPress={() => { void cancelTake(); }} />
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
            onCaptured={(result) => deliver({ rawBowFrames: result.bowFrames })}
          />
        </View>
      )}
      <View style={s.takeBody}>
        <Text style={s.takeKicker}>Live take</Text>
        <Text style={s.takeTitle}>{block.title}</Text>
        <Text style={s.takeTarget}>{targetLine(block)}</Text>

        {currentStep ? (
          /* A circle is a poor container for four stacked lines — it squeezes
             every one of them to fit its narrowest point. Only the note lives
             inside it; the instruction and the counters sit below, where they
             have the full width of the screen. */
          <Animated.View entering={FadeIn} style={s.noteStack}>
            <View style={[s.takeCircle, live.voiced && { borderColor: noteColor(live.cents ?? 0) }]}>
              <Text style={s.beatNote}>{currentStep.note}</Text>
              {/* How far off you are, right now, while the note is still
                  sounding — which is the only moment you can still fix it. */}
              {showLive && live.voiced && live.cents != null && (
                <Text style={[s.liveCents, { color: noteColor(live.cents) }]}>
                  {live.cents > 0 ? '+' : ''}{Math.round(live.cents)}¢
                </Text>
              )}
            </View>
            {/* The annotation is what turns a note name into an instruction —
                "cross to A", "shift to 3rd". Without it a generated sequence is
                just a list of pitches and the player has to infer the point. */}
            {showLive && <CentsGauge cents={live.cents ?? 0} active={live.voiced} />}
            {currentStep.annotation && (
              <Text style={s.beatAnnotation}>{currentStep.annotation}</Text>
            )}
            <Text style={s.beatCount}>Note {metronome.currentBeat + 1} of {steps.length}</Text>
            {nextStep && (
              <Text style={s.nextNote}>
                Next: {nextStep.note}{nextStep.annotation ? ` · ${nextStep.annotation}` : ''}
              </Text>
            )}
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

        {showLive && recording && !isSequence && (
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

      {/* Always a bar, in both states. A recording take used to render none at
          all: an open-ended take ended on silence, a paced one on the click,
          and when neither fired the screen had no control on it whatsoever.
          "Stop take" ends it early and still submits what was played; the
          cancel above throws the take away. */}
      <View style={[s.bottomBar, { paddingBottom: Math.max(insets.bottom, spacing.sm) }]}>
        {recording ? (
          <DepthButton label="Stop take" icon="stop" variant="neutral" onPress={() => { void stop(); }} />
        ) : (
          <DepthButton label="Start take" icon="mic" onPress={start} />
        )}
      </View>
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
    const timer = setTimeout(() => {
      try {
        onJudged(runEvaluator(block.evaluator, take));
      } catch {
        // An evaluator that throws used to leave this spinner up for good:
        // the error escaped the timer callback, onJudged never ran, and the
        // phase never moved off 'judging'. Report it as an unjudgeable take —
        // that screen offers a retake and a skip, both of which lead somewhere.
        onJudged({
          passed: false,
          attempts: 0,
          successCount: 0,
          bestStreak: 0,
          feedback: 'Something went wrong while scoring that take.',
        });
      }
    }, 250);
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
/**
 * The take's score, its breakdown, and how it compares with previous attempts
 * at the same drill.
 *
 * A score rather than a verdict is the point: "82, up from 71 two weeks ago"
 * tells a player something "failed, failed, passed" never could.
 */
function ScoreCard({ score, history }: { score: SequenceScore; history: ScoreHistory | null }) {
  const band = scoreBand(score.score);
  const color = colors.score[band];
  const priorBest = history && history.scores.length > 1
    ? Math.max(...history.scores.slice(0, -1))
    : null;
  const isBest = priorBest != null && score.score > priorBest;

  return (
    <View style={s.scoreCard}>
      <View style={s.scoreTop}>
        <Text style={[s.scoreValue, { color }]}>{score.score}</Text>
        <View style={s.scoreOf}>
          <Text style={s.scoreOfText}>out of 100</Text>
          {/* The score is the gradient; the gate is every note in tune. Showing
              "65 to pass" beside a score of 80 that did not pass reads as a bug. */}
          <Text style={s.scoreBar}>{score.cleanCount}/{score.expectedCount} in tune</Text>
        </View>
      </View>

      <View style={s.scoreParts}>
        <ScorePart label="Pitch" value={score.intonation} />
        {score.timing != null && <ScorePart label="Timing" value={score.timing} />}
        <ScorePart label="Notes" value={score.completeness} />
      </View>

      {isBest ? (
        <Text style={s.scoreTrend}>Your best yet on this drill — up from {priorBest}.</Text>
      ) : history && history.improvement != null && history.scores.length > 1 ? (
        <Text style={s.scoreTrend}>
          {history.improvement > 0
            ? `Up ${history.improvement} since you first tried this (best ${history.best}).`
            : `First try scored ${history.scores[0]}; best so far ${history.best}.`}
        </Text>
      ) : null}
    </View>
  );
}

function ScorePart({ label, value }: { label: string; value: number }) {
  return (
    <View style={s.scorePart}>
      <View style={s.scorePartTrack}>
        <View style={[s.scorePartFill, { width: `${Math.max(2, value)}%` }]} />
      </View>
      <Text style={s.scorePartLabel}>{label}</Text>
      <Text style={s.scorePartValue}>{value}</Text>
    </View>
  );
}

function ResultPhase({
  block,
  insets,
  evaluation,
  take,
  nextTempo,
  tempoDirection,
  slowerTempo,
  onSlower,
  scoreHistory,
  onPass,
  onRetry,
  onSkip,
  onRepair,
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
  /** Tempo a "try it slower" retake would run at; null when not adjustable. */
  slowerTempo?: number | null;
  onSlower?: () => void;
  /** Previous scores for this same drill, for the improvement line. */
  scoreHistory?: ScoreHistory | null;
  onPass: () => void;
  onRetry: () => void;
  /** Moves on without passing. Every dead-end verdict must offer this. */
  onSkip: () => void;
  /** Opens the per-note repair drill. Absent when the block isn't note-graded. */
  onRepair?: (targets: RepairTarget[]) => void;
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

  const gaugeCents = highlightCents(evaluation);
  const misses = onRepair ? repairableNotes(evaluation) : [];
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
          {evaluation.score && <ScoreCard score={evaluation.score} history={scoreHistory ?? null} />}
          <Text style={s.takeHint}>{feedbackLine}</Text>
          {gaugeCents != null && <CentsGauge cents={gaugeCents} active />}
          {breakdown}
        </View>
        <View style={[s.bottomBar, { paddingBottom: bottomInset }]}>
          {/* An adaptive tempo ladder that raises the tempo and then moves to a
              different exercise never lets the player play the tempo it just
              earned them — and the headline above has already said "let's pick
              it up to N BPM", so leaving is the one thing that reads as a bug.
              Climbing is the default; moving on stays one tap away. */}
          {isRhythm && tempoDirection === 'up' && nextTempo != null ? (
            <>
              <DepthButton label={`Again at ${nextTempo} BPM`} icon="play" onPress={onRetry} />
              <DepthButton label="Continue" icon="arrow-forward" variant="neutral" onPress={onPass} />
            </>
          ) : (
            <DepthButton label="Continue" icon="arrow-forward" onPress={onPass} />
          )}
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
        <View style={[s.bottomBar, s.resultBar, { paddingBottom: bottomInset }]}>
          <DepthButton label="Try again" icon="refresh" onPress={onRetry} />
          {/* This verdict means the app failed to hear or see the take, not
              that the player failed it — so retake-forever must never be the
              only door. */}
          <DepthButton label="Skip this one" icon="play-forward" variant="neutral" onPress={onSkip} />
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
        {evaluation?.score && <ScoreCard score={evaluation.score} history={scoreHistory ?? null} />}
        <Text style={s.takeHint}>{feedbackLine ?? 'Try again.'}</Text>
        {gaugeCents != null && <CentsGauge cents={gaugeCents} active />}
        {breakdown}
      </View>
      <View style={[s.bottomBar, s.resultBar, { paddingBottom: bottomInset }]}>
        {/* Repair comes first when we know exactly which notes missed. Passing
            needs every note in tune, so "try again" alone would mean replaying
            the notes that were already fine to get back to the two that weren't. */}
        {misses.length > 0 && (
          <DepthButton
            label={misses.length === 1 ? `Fix ${misses[0].note}` : `Fix ${misses.length} notes`}
            icon="build"
            onPress={() => onRepair?.(misses)}
          />
        )}
        <DepthButton
          label="Try again"
          icon="refresh"
          variant={misses.length > 0 ? 'neutral' : 'primary'}
          onPress={onRetry}
        />
        {/* The moment a slower tempo is actually wanted. Offering it only in
            the intro means the player has to fail, back out, and come back. */}
        {slowerTempo != null && onSlower && (
          <DepthButton
            label={`Try it slower — ${slowerTempo} BPM`}
            icon="play-back"
            variant="neutral"
            onPress={onSlower}
          />
        )}
        {/* Last, and quiet: a drill you can't pass today shouldn't hold the
            whole plan hostage. A text link rather than a fourth 58pt button —
            this bar can already carry three, and on a small screen a fourth
            pushes the score off the top. It stays unfinished — see skipBlock. */}
        <Pressable onPress={onSkip} hitSlop={10} style={s.skipLink}>
          <Text style={s.skipLinkText}>Skip this one for now</Text>
        </Pressable>
      </View>
    </View>
  );
}

/**
 * Notes the take missed, in the order they were played.
 *
 * Only meaningful for per-note drills: a scale knows which degree was flat, a
 * bow-camera block does not. Undetected notes are excluded — there is nothing to
 * drill against when the mic never heard the note at all, and sending someone to
 * repair a note the app failed to record would blame them for its own gap.
 */
interface RepairTarget {
  note: string;
  /**
   * The note played immediately before it in the sequence, if any.
   *
   * Carried through so the repair drill can drill the *interval* and not just
   * the note: in the passage the player never arrives at this pitch from
   * silence, they arrive from here.
   */
  from: string | null;
}

function repairableNotes(evaluation: PracticeEvaluation | null): RepairTarget[] {
  const notes = evaluation?.score?.notes;
  if (!notes) return [];
  return notes
    .map((n, i) => ({ n, from: i > 0 ? notes[i - 1].label : null }))
    .filter(({ n }) => !n.clean && n.centsDeviation != null && n.label)
    .map(({ n, from }) => ({ note: n.label, from: from || null }));
}

/**
 * The note the gauge should point at: the one the feedback sentence is about.
 *
 * This used to return the LAST attempt while the feedback described the FIRST
 * miss, so the text could say "sharp by 1180¢" beside a needle reading 20¢
 * flat — two different notes, presented as if they were one.
 *
 * Returns null when the deviation is beyond what a ±50¢ gauge can honestly
 * show. A wrong note or an octave detection error is not a needle position, and
 * pinning the needle to the end of the scale would assert a precision that
 * isn't there; the sentence explains it instead.
 */
function highlightCents(evaluation: PracticeEvaluation | null): number | null {
  const results = evaluation?.attemptResults;
  if (!results || results.length === 0) return null;
  const focus = results.find((r) => !r.passed && r.centsDeviation != null)
    ?? results[results.length - 1];
  const cents = focus.centsDeviation;
  if (cents == null || Math.abs(cents) > GAUGE_RANGE_CENTS) return null;
  return cents;
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
  stage: { alignItems: 'center', justifyContent: 'center', paddingVertical: spacing.sm },
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
  stepLine: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' },
  stepBullet: {
    fontSize: 12,
    fontWeight: '900',
    color: colors.brand[700],
    backgroundColor: colors.brand[50],
    width: 20,
    height: 20,
    borderRadius: 10,
    textAlign: 'center',
    lineHeight: 20,
    overflow: 'hidden',
  },
  stepTitle: { color: colors.text.primary, fontSize: 24, fontWeight: '900' },
  stepBody: { flex: 1, color: colors.text.secondary, fontSize: 15, lineHeight: 22 },
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
  takeBody: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
  },
  takeKicker: {
    color: 'rgba(255,255,255,0.58)',
    fontSize: 12,
    fontWeight: '900',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  takeTitle: { color: '#fff', fontSize: 28, fontWeight: '900', textAlign: 'center', lineHeight: 34 },
  takeTarget: { color: 'rgba(255,255,255,0.84)', fontSize: 16, fontWeight: '700', textAlign: 'center', lineHeight: 22 },
  takeCircle: {
    width: NOTE_CIRCLE,
    height: NOTE_CIRCLE,
    borderRadius: NOTE_CIRCLE / 2,
    marginVertical: spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.22)',
  },
  /** Circle plus the lines beneath it, which get the full screen width. */
  noteStack: { alignItems: 'center', alignSelf: 'stretch', gap: spacing.sm },
  takeHint: { color: 'rgba(255,255,255,0.72)', fontSize: 16, lineHeight: 23, textAlign: 'center' },
  beatNote: { color: '#fff', fontSize: Math.round(NOTE_CIRCLE * 0.32), fontWeight: '900' },
  previewRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.brand[50],
    borderRadius: radius.xl,
    padding: spacing.md,
    borderWidth: 1.5,
    borderColor: colors.brand[100],
  },
  previewRowPressed: { backgroundColor: colors.brand[100] },
  previewIcon: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
  },
  previewCopy: { flex: 1, gap: 2 },
  previewLabel: { fontSize: 15, fontWeight: '900', color: colors.brand[800] },
  previewHint: { fontSize: 12, lineHeight: 17, color: colors.text.secondary },
  tempoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    padding: spacing.md,
    borderWidth: 1.5,
    borderColor: '#eef2f7',
  },
  tempoCopy: { flex: 1, gap: 1 },
  tempoLabel: { fontSize: 14, fontWeight: '900', color: colors.text.primary },
  tempoHint: { fontSize: 12, lineHeight: 16, color: colors.text.muted },
  tempoBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.brand[50],
  },
  tempoBtnPressed: { backgroundColor: colors.brand[100] },
  tempoValue: { alignItems: 'center', minWidth: 46 },
  tempoNumber: { fontSize: 19, fontWeight: '900', color: colors.text.primary },
  tempoUnit: { fontSize: 10, fontWeight: '800', color: colors.text.muted, letterSpacing: 0.4 },
  scoreCard: {
    alignSelf: 'stretch',
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    padding: spacing.md,
    gap: spacing.sm,
  },
  scoreTop: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm },
  scoreValue: { fontSize: 56, fontWeight: '900', lineHeight: 62 },
  scoreOf: { flex: 1 },
  scoreOfText: { color: 'rgba(255,255,255,0.85)', fontSize: 15, fontWeight: '700' },
  scoreBar: { color: 'rgba(255,255,255,0.6)', fontSize: 13, fontWeight: '600' },
  scoreParts: { gap: spacing.xs },
  scorePart: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  scorePartTrack: {
    flex: 1,
    height: 8,
    borderRadius: 4,
    backgroundColor: 'rgba(255,255,255,0.18)',
    overflow: 'hidden',
  },
  scorePartFill: { height: '100%', borderRadius: 4, backgroundColor: '#fff' },
  scorePartLabel: { color: 'rgba(255,255,255,0.8)', fontSize: 13, fontWeight: '700', width: 56 },
  scorePartValue: { color: '#fff', fontSize: 14, fontWeight: '800', width: 30, textAlign: 'right' },
  scoreTrend: { color: 'rgba(255,255,255,0.82)', fontSize: 14, fontWeight: '700', lineHeight: 20 },
  beatAnnotation: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '800',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.full,
    backgroundColor: 'rgba(255,255,255,0.22)',
    overflow: 'hidden',
    textAlign: 'center',
    lineHeight: 24,
  },
  liveCents: { fontSize: 20, fontWeight: '900', marginTop: 2 },
  beatCount: { color: 'rgba(255,255,255,0.72)', fontSize: 15, fontWeight: '700' },
  nextNote: { color: 'rgba(255,255,255,0.62)', fontSize: 15, fontWeight: '600', textAlign: 'center' },
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
  skipLink: { alignSelf: 'center', paddingVertical: spacing.xs },
  skipLinkText: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 14,
    fontWeight: '700',
    textDecorationLine: 'underline',
  },
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
