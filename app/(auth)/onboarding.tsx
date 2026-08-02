import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuthStore } from '../../src/store/useAuthStore';
import { useOnboardingStore } from '../../src/store/useOnboardingStore';
import { useReminderStore } from '../../src/store/useReminderStore';
import { WelcomeStep } from '../../src/components/onboarding/WelcomeStep';
import { OptionCards } from '../../src/components/onboarding/OptionCards';
import { PreferencesStep } from '../../src/components/onboarding/PreferencesStep';
import { PermissionsStep } from '../../src/components/onboarding/PermissionsStep';
import { ProStep } from '../../src/components/onboarding/ProStep';
import { AccountStep } from '../../src/components/onboarding/AccountStep';
import { BigButton } from '../../src/components/ui/BigButton';
import { haptic } from '../../src/lib/haptics';
import { colors, spacing } from '../../src/constants/theme';
import { updateProfileFields } from '../../src/services/auth';
import { GOAL_TIERS } from '../../src/lib/weeklyGoal';
import {
  STEP_COPY,
  LEARNING_GOALS,
  DAILY_TIME_OPTIONS,
  EXPERIENCE_LEVELS,
  VIOLIN_SIZES,
  ACCESSORIES,
} from '../../src/constants/onboardingContent';

// Step machine: an ordered list of step ids rendered via switch. Every step
// after the welcome intro carries a choice or an action (cards, a form, a
// permission/reminder toggle, a subscribe offer) — no text-only filler.
const STEPS = [
  'welcome',
  'goals',
  'time',
  'experience',
  'violin-size',
  'accessories',
  'preferences',
  'permissions',
  'pro',
  'account',
] as const;
type StepId = (typeof STEPS)[number];

export default function Onboarding() {
  const [stepIndex, setStepIndex] = useState(0);
  const step: StepId = STEPS[stepIndex];

  const { setOnboardingComplete, setPlayerCategory, setWeeklyGoal } = useAuthStore();
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

  const goNext = () => setStepIndex((i) => Math.min(i + 1, STEPS.length - 1));

  // accountUserId is passed in directly (rather than read from state) because
  // AccountStep's callback fires in the same tick as completion — a state
  // setter here wouldn't have flushed yet.
  const complete = async (accountUserId?: string) => {
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

    if (accountUserId) {
      updateProfileFields(accountUserId, {
        skill_level: experience?.skillLevel ?? 'beginner',
        ...(tier ? { weekly_goal_minutes: tier.minutes } : {}),
      }).catch(() => {});
    }

    setOnboardingComplete();
    router.replace('/(tabs)/home');
  };

  const advance = () => {
    haptic.light();
    goNext();
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
          <StepShell title={STEP_COPY.experience.title} subtitle={STEP_COPY.experience.subtitle}>
            <OptionCards
              options={EXPERIENCE_LEVELS}
              selectedIds={experienceId ? [experienceId] : []}
              onToggle={setExperienceId}
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

      case 'pro':
        return <ProStep onSkip={goNext} />;

      case 'account':
        return (
          <AccountStep
            onCreated={(userId) => complete(userId)}
            onSkip={() => complete()}
          />
        );
    }
  };

  // These steps drive their own navigation (their own CTA + skip), so the
  // shared footer CTA is hidden for them.
  const showFooterCta = step !== 'account' && step !== 'pro' && step !== 'welcome';

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
            <BigButton label="Continue" onPress={advance} disabled={!canAdvance} />
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
  children,
}: {
  title: string;
  subtitle: string;
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
  stepSubtitle: {
    fontSize: 14,
    color: colors.text.secondary,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: spacing.sm,
  },
});
