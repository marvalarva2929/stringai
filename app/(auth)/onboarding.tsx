import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuthStore } from '../../src/store/useAuthStore';
import { useActivationStore } from '../../src/store/useActivationStore';
import { useOnboardingStore } from '../../src/store/useOnboardingStore';
import { useReminderStore } from '../../src/store/useReminderStore';
import { WelcomeStep } from '../../src/components/onboarding/WelcomeStep';
import { OptionCards } from '../../src/components/onboarding/OptionCards';
import { PreferencesStep } from '../../src/components/onboarding/PreferencesStep';
import { PermissionsStep } from '../../src/components/onboarding/PermissionsStep';
import { BigButton } from '../../src/components/ui/BigButton';
import { haptic } from '../../src/lib/haptics';
import { colors, spacing } from '../../src/constants/theme';
import { track } from '../../src/services/analytics';
import { AnalyticsEvent } from '../../src/constants/analyticsEvents';
import { GOAL_TIERS } from '../../src/lib/weeklyGoal';
import {
  STEP_COPY,
  LEARNING_GOALS,
  DAILY_TIME_OPTIONS,
  EXPERIENCE_LEVELS,
  VIOLIN_SIZES,
  ACCESSORIES,
} from '../../src/constants/onboardingContent';
import { useTechniqueSkillStore } from '../../src/store/useTechniqueSkillStore';

// Step machine: an ordered list of step ids rendered via switch. Every step
// after the welcome intro carries a choice or an action (cards, a
// permission/reminder toggle) — no text-only filler.
//
// Account creation used to be the terminal step. It now runs after the
// purchase instead (see AccountGate) — a signup form in front of the value
// moment is the most expensive place in the funnel to put one, and the
// confirmation email it depends on is the least reliable part of the stack.
const STEPS = [
  'welcome',
  'goals',
  'time',
  'experience',
  'violin-size',
  'accessories',
  'preferences',
  'permissions',
] as const;
type StepId = (typeof STEPS)[number];

export default function Onboarding() {
  const [stepIndex, setStepIndex] = useState(0);
  const step: StepId = STEPS[stepIndex];

  const { setOnboardingComplete, setPlayerCategory, setWeeklyGoal } = useAuthStore();
  // Set from the experience answer, so the first practice plan is already in
  // positions the player can actually finger. See useTechniqueSkillStore.
  const setThirdPosition = useTechniqueSkillStore((st) => st.setThirdPosition);
  const {
    learningGoals,
    toggleLearningGoal,
    dailyTimeId,
    setDailyTimeId,
    experienceId,
    setExperienceId,
    violinSize,
    setViolinSize,
    accessories,
    toggleAccessory,
  } = useOnboardingStore();

  // Reminder choice is held locally and only committed (scheduled + persisted)
  // on completion, so nothing is scheduled if the user abandons onboarding.
  const [reminderEnabled, setReminderEnabled] = useState(false);
  const [reminderHour, setReminderHour] = useState(18);
  const [reminderMinute, setReminderMinute] = useState(0);

  const canAdvance =
    (step !== 'goals' || learningGoals.length > 0) &&
    (step !== 'time' || dailyTimeId !== null) &&
    (step !== 'experience' || experienceId !== null);

  // What the user picked on the step they are leaving. Kept short and
  // low-cardinality — it is the answer, not a full dump of the store.
  const selectionFor = (id: StepId): string | undefined => {
    switch (id) {
      case 'goals': return learningGoals.join(',') || undefined;
      case 'time': return dailyTimeId ?? undefined;
      case 'experience': return experienceId ?? undefined;
      case 'violin-size': return violinSize ?? undefined;
      case 'accessories': return accessories.join(',') || undefined;
      default: return undefined;
    }
  };

  const startedAt = useRef(Date.now());
  const stepEnteredAt = useRef(Date.now());

  useEffect(() => {
    track(AnalyticsEvent.ONBOARDING_START);
  }, []);

  // Per-step impressions. Paired with onboarding_step_complete below, these give
  // the view→complete drop-off for each of the ten steps and how long each took.
  useEffect(() => {
    stepEnteredAt.current = Date.now();
    track(AnalyticsEvent.ONBOARDING_STEP_VIEW, { step_id: step, step_index: stepIndex });
  }, [step, stepIndex]);

  // Every forward transition funnels through here — the footer CTA and the
  // welcome CTA — so one emit covers every step. The last step's transition is
  // into completion rather than another step, and carries onboarding_complete
  // alongside it.
  const goNext = () => {
    track(AnalyticsEvent.ONBOARDING_STEP_COMPLETE, {
      step_id: step,
      step_index: stepIndex,
      ms_on_step: Date.now() - stepEnteredAt.current,
      selection: selectionFor(step),
    });
    setStepIndex((i) => Math.min(i + 1, STEPS.length - 1));
  };

  // Everything collected here stays local. There is no account yet to write it
  // to — syncOnboardingAnswersToProfile flushes it once one exists.
  const complete = async () => {
    haptic.light();
    const experience = EXPERIENCE_LEVELS.find((e) => e.id === experienceId);
    const dailyTime = DAILY_TIME_OPTIONS.find((t) => t.id === dailyTimeId);
    const tier = dailyTime ? GOAL_TIERS.find((t) => t.id === dailyTime.weeklyTierId) : null;

    if (experience) await setPlayerCategory(experience.playerCategory);
    if (tier) await setWeeklyGoal(tier.minutes);

    if (reminderEnabled) {
      try {
        await useReminderStore.getState().enable(reminderHour, reminderMinute);
      } catch {}
    }

    // The top of every downstream funnel — a Key Event in GA4, and the
    // denominator for activation and conversion rates.
    track(AnalyticsEvent.ONBOARDING_COMPLETE, {
      goals_count: learningGoals.length,
      daily_time: dailyTimeId ?? undefined,
      experience: experienceId ?? undefined,
      violin_size: violinSize ?? undefined,
      accessories_count: accessories.length,
      reminder_enabled: reminderEnabled,
      ms_total: Date.now() - startedAt.current,
    });

    setOnboardingComplete();
    // Land on the real home screen, with activation armed — the walkthrough
    // points at the actual buttons there rather than describing them first.
    useActivationStore.getState().begin();
    router.replace('/(tabs)/home');
  };

  const isLastStep = stepIndex === STEPS.length - 1;

  const advance = () => {
    haptic.light();
    goNext();
    // `permissions` is terminal now that the account step has moved out, so the
    // shared footer CTA has to finish the flow rather than walk off the end of
    // the array.
    if (isLastStep) void complete();
  };

  // Dev-only escape hatch. Doesn't persist completion, so onboarding still
  // shows on the next cold start — it can't get "stuck off" again.
  const debugSkip = () => {
    router.replace('/(tabs)/home');
  };

  const renderStep = () => {
    switch (step) {
      case 'welcome':
        return <WelcomeStep onNext={advance} />;

      case 'goals':
        return (
          <StepShell title={STEP_COPY.goals.title} subtitle={STEP_COPY.goals.subtitle}>
            <OptionCards options={LEARNING_GOALS} selectedIds={learningGoals} multi onToggle={toggleLearningGoal} />
          </StepShell>
        );

      case 'time':
        return (
          <StepShell title={STEP_COPY.time.title} subtitle={STEP_COPY.time.subtitle}>
            <OptionCards
              options={DAILY_TIME_OPTIONS}
              selectedIds={dailyTimeId ? [dailyTimeId] : []}
              onToggle={setDailyTimeId}
            />
          </StepShell>
        );

      case 'experience':
        return (
          <StepShell
            title={STEP_COPY.experience.title}
            subtitle={STEP_COPY.experience.subtitle}
            footnote={STEP_COPY.experience.footnote}
          >
            <OptionCards
              options={EXPERIENCE_LEVELS}
              selectedIds={experienceId ? [experienceId] : []}
              onToggle={(id) => {
                setExperienceId(id);
                // Whether drills may leave first position rides on this answer
                // rather than a question of its own — see EXPERIENCE_LEVELS.
                const level = EXPERIENCE_LEVELS.find((l) => l.id === id);
                if (level) setThirdPosition(level.canShift ? 'yes' : 'no');
              }}
            />
          </StepShell>
        );

      case 'violin-size':
        return (
          <StepShell title={STEP_COPY.violinSize.title} subtitle={STEP_COPY.violinSize.subtitle}>
            <OptionCards
              options={VIOLIN_SIZES}
              selectedIds={violinSize ? [violinSize] : []}
              onToggle={setViolinSize}
            />
          </StepShell>
        );

      case 'accessories':
        return (
          <StepShell title={STEP_COPY.accessories.title} subtitle={STEP_COPY.accessories.subtitle}>
            <OptionCards options={ACCESSORIES} selectedIds={accessories} multi onToggle={toggleAccessory} />
          </StepShell>
        );

      case 'preferences':
        return <PreferencesStep />;

      case 'permissions':
        return (
          <PermissionsStep
            reminderEnabled={reminderEnabled}
            onReminderEnabledChange={setReminderEnabled}
            reminderHour={reminderHour}
            reminderMinute={reminderMinute}
            onReminderTimeChange={(h, m) => { setReminderHour(h); setReminderMinute(m); }}
          />
        );

    }
  };

  // The welcome hero drives its own navigation, so the shared footer CTA is
  // hidden for it.
  const showFooterCta = step !== 'welcome';

  return (
    <View style={styles.container}>
      {/* Debug skip — dev builds only; production users complete the full flow */}
      {__DEV__ && (
        <Pressable onPress={debugSkip} style={styles.skipBtnFixed}>
          <Text style={styles.skipText}>Skip (dev)</Text>
        </Pressable>
      )}

      <Animated.View
        key={step}
        entering={FadeIn.duration(220)}
        exiting={FadeOut.duration(120)}
        style={styles.stepArea}
      >
        {renderStep()}
      </Animated.View>

      {step !== 'welcome' && (
        <View style={styles.footer}>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${((stepIndex + 1) / STEPS.length) * 100}%` }]} />
          </View>
          <Text style={styles.stepCounter}>{stepIndex + 1} of {STEPS.length}</Text>

          {showFooterCta && (
            <BigButton
              label={isLastStep ? "Let's play" : 'Continue'}
              onPress={advance}
              disabled={!canAdvance}
            />
          )}
        </View>
      )}
    </View>
  );
}

// Shared title/subtitle header for option-picker steps.
function StepShell({
  title,
  subtitle,
  footnote,
  children,
}: {
  title: string;
  subtitle: string;
  /** Small line under the options explaining what the answer is used for. */
  footnote?: string;
  children: React.ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      style={styles.stepShellFlex}
      contentContainerStyle={[styles.stepShell, { paddingTop: insets.top + spacing.xl }]}
      showsVerticalScrollIndicator={false}
    >
      <Text style={styles.stepTitle}>{title}</Text>
      <Text style={styles.stepSubtitle}>{subtitle}</Text>
      {children}
      {footnote && <Text style={styles.stepFootnote}>{footnote}</Text>}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  stepArea: { flex: 1 },
  footer: {
    paddingHorizontal: spacing.xl,
    paddingBottom: 48,
    paddingTop: spacing.md,
    backgroundColor: colors.background,
  },
  progressTrack: {
    height: 4,
    borderRadius: 2,
    backgroundColor: '#e5e7eb',
    marginBottom: spacing.sm,
    overflow: 'hidden',
  },
  progressFill: {
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.brand[600],
  },
  skipBtnFixed: { position: 'absolute', top: 56, right: 20, zIndex: 10, padding: 8 },
  skipText: { color: colors.text.muted, fontSize: 13 },
  stepCounter: { textAlign: 'center', fontSize: 11, color: colors.text.muted, marginBottom: spacing.md },

  stepShellFlex: { flex: 1 },
  stepShell: {
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.xl,
    gap: spacing.md,
  },
  stepTitle: {
    fontSize: 26,
    fontWeight: '700',
    color: colors.text.primary,
    textAlign: 'center',
    marginBottom: 4,
  },
  stepFootnote: {
    fontSize: 13,
    color: colors.text.muted,
    textAlign: 'center',
    marginTop: spacing.lg,
    paddingHorizontal: spacing.md,
    lineHeight: 18,
  },
  stepSubtitle: {
    fontSize: 14,
    color: colors.text.secondary,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: spacing.sm,
  },
});
