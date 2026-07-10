import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, SafeAreaView, ScrollView } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import Animated, {
  FadeIn,
  FadeInRight,
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

type Phase = 'intro' | 'reps' | 'take' | 'result';

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
          <Text style={s.emptyBtnText}>Back to path</Text>
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
  const steps = useMemo(() => buildRunnerSteps(block, coach), [block, coach]);
  const step = steps[stepIndex];

  // Coarse progress across the whole lesson for the top bar.
  const progress =
    phase === 'intro' ? 0.04
    : phase === 'reps' ? 0.1 + 0.6 * ((stepIndex + 1) / steps.length)
    : phase === 'take' ? 0.85
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

  const onPrimary = () => {
    haptic.light();
    if (phase === 'intro') {
      setPhase('reps');
      setStepIndex(0);
    } else if (phase === 'reps') {
      if (stepIndex < steps.length - 1) setStepIndex((i) => i + 1);
      else setPhase('take');
    }
  };

  const back = () => {
    haptic.light();
    if (phase === 'intro') { router.back(); return; }
    if (phase === 'reps' && stepIndex > 0) { setStepIndex((i) => i - 1); return; }
    if (phase === 'reps') { setPhase('intro'); return; }
    if (phase === 'take') { setPhase('reps'); setStepIndex(steps.length - 1); return; }
    if (phase === 'result') { setPhase('take'); return; }
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
          <Pressable style={s.roundBtn} onPress={() => router.replace('/(tabs)/train')}>
            <Ionicons name="close" size={20} color="#fff" />
          </Pressable>
        </View>

        {phase === 'intro' && (
          <IntroPhase block={block} coach={coach} insets={insets} onStart={onPrimary} />
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
          <TakePhase block={block} insets={insets} onDone={() => setPhase('result')} />
        )}
        {phase === 'result' && (
          <ResultPhase
            block={block}
            insets={insets}
            onPass={advanceToNext}
            onRetry={() => setPhase('take')}
          />
        )}
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
}: {
  block: PracticeBlock;
  coach: PracticeBlock['coachIntensity'];
  insets: ReturnType<typeof useSafeAreaInsets>;
  onStart: () => void;
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

        <SignalTiles signals={block.liveMode.signals} />
      </ScrollView>

      <View style={[s.bottomBar, { paddingBottom: Math.max(insets.bottom, spacing.sm) }]}>
        <DepthButton label="Start training" icon="arrow-forward" onPress={onStart} />
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

// ─── Take (Phase 1: lightweight capture + self check) ──────────────────────
function TakePhase({
  block,
  insets,
  onDone,
}: {
  block: PracticeBlock;
  insets: ReturnType<typeof useSafeAreaInsets>;
  onDone: () => void;
}) {
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const dot = useSharedValue(1);

  useEffect(() => {
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, []);

  const dotStyle = useAnimatedStyle(() => ({ opacity: dot.value }));

  const start = () => {
    haptic.medium();
    setRecording(true);
    setElapsed(0);
    dot.value = withRepeat(withSequence(withTiming(0.3, { duration: 500 }), withTiming(1, { duration: 500 })), -1, true);
    timerRef.current = setInterval(() => setElapsed((e) => e + 1), 1000);
  };

  const stop = () => {
    haptic.medium();
    if (timerRef.current) clearInterval(timerRef.current);
    setRecording(false);
    onDone();
  };

  const needsCamera = block.liveMode.requiresCamera;

  return (
    <View style={s.takeWrap}>
      <View style={s.takeBody}>
        <Text style={s.takeKicker}>Live take</Text>
        <Text style={s.takeTitle}>{block.title}</Text>
        <Text style={s.takeTarget}>{targetLine(block)}</Text>

        <Animated.View entering={FadeIn} style={s.takeCircle}>
          <Ionicons
            name={recording ? (needsCamera ? 'videocam' : 'mic') : needsCamera ? 'videocam-outline' : 'mic-outline'}
            size={64}
            color="#fff"
          />
        </Animated.View>

        {recording ? (
          <View style={s.recRow}>
            <Animated.View style={[s.recDot, dotStyle]} />
            <Text style={s.recText}>Recording · {elapsed}s</Text>
          </View>
        ) : (
          <Text style={s.takeHint}>
            {block.liveMode.status === 'unavailable' ? block.fallbackCriteria : `Pass condition: ${block.successCriteria.summary}`}
          </Text>
        )}
      </View>

      <View style={[s.bottomBar, { paddingBottom: Math.max(insets.bottom, spacing.sm) }]}>
        {recording ? (
          <DepthButton label="Stop take" icon="stop" onPress={stop} />
        ) : (
          <DepthButton label="Start take" icon="mic" onPress={start} />
        )}
      </View>
    </View>
  );
}

// ─── Result (Phase 1: self-report; Phase 2 swaps in evaluator scoring) ──────
function ResultPhase({
  block,
  insets,
  onPass,
  onRetry,
}: {
  block: PracticeBlock;
  insets: ReturnType<typeof useSafeAreaInsets>;
  onPass: () => void;
  onRetry: () => void;
}) {
  return (
    <View style={s.takeWrap}>
      <View style={s.takeBody}>
        <View style={s.resultBadge}>
          <Ionicons name="help" size={40} color={colors.brand[700]} />
        </View>
        <Text style={s.takeTitle}>How did that go?</Text>
        <Text style={s.takeHint}>Pass condition: {block.successCriteria.summary}</Text>
      </View>

      <View style={[s.bottomBar, s.resultBar, { paddingBottom: Math.max(insets.bottom, spacing.sm) }]}>
        <DepthButton label="Nailed it" icon="checkmark" onPress={onPass} />
        <DepthButton label="Try again" icon="refresh" variant="neutral" onPress={onRetry} />
      </View>
    </View>
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
  resultBar: { gap: spacing.sm },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md, backgroundColor: colors.background },
  emptyTitle: { fontSize: 20, fontWeight: '900', color: colors.text.primary },
  emptyBtn: { backgroundColor: colors.brand[600], borderRadius: radius.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  emptyBtnText: { color: '#fff', fontWeight: '900' },
});
