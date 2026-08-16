import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useActivationStore, ACTIVATION_FUNNEL } from '../../store/useActivationStore';
import { useReviewStore } from '../../store/useReviewStore';
import { useAnalysisStore } from '../../store/useAnalysisStore';
import { colors, spacing, radius } from '../../constants/theme';

/**
 * The activation funnel, for app/debug.tsx.
 *
 * There is no analytics SDK in this app, so `stepTimestamps` on the activation
 * store *is* the funnel. Rendering it here is the difference between being able
 * to see where a run stalled and guessing — and the reset buttons are the
 * difference between testing the flow and reinstalling the app between runs.
 */
export function ActivationDebugPanel() {
  const activation = useActivationStore();
  const review = useReviewStore();

  const stamps = activation.stepTimestamps;
  const startMs = activation.startedAt ? new Date(activation.startedAt).getTime() : null;

  const resetActivation = () => {
    activation.resetActivation();
    // A leftover demo result would put the next run straight onto the carousel.
    useAnalysisStore.getState().reset();
  };

  return (
    <View style={s.box}>
      <Text style={s.title}>Activation Funnel</Text>

      <Row label="Step" value={activation.step} />
      <Row label="Path" value={activation.usedDemo ? 'demo (no violin)' : 'recorded'} />

      <View style={s.divider} />

      {ACTIVATION_FUNNEL.map((step) => {
        const at = stamps[step];
        if (!at) return <Row key={step} label={step} value="—" muted />;
        const ms = new Date(at).getTime();
        const delta = startMs !== null ? `  (+${Math.round((ms - startMs) / 1000)}s)` : '';
        return (
          <Row
            key={step}
            label={step}
            value={new Date(at).toLocaleTimeString() + delta}
          />
        );
      })}

      {stamps.dismissed && (
        <Row label="dismissed" value={new Date(stamps.dismissed).toLocaleTimeString()} />
      )}

      <View style={s.divider} />

      <Text style={s.title}>Review Prompt</Text>
      <Row label="Prompts shown" value={String(review.promptCount)} />
      <Row label="Last prompted" value={review.lastPromptedAt ?? 'never'} />
      <Row label="Outcome" value={review.outcome} />

      <View style={s.actions}>
        <Pressable style={s.btn} onPress={resetActivation}>
          <Text style={s.btnText}>Reset activation</Text>
        </Pressable>
        <Pressable style={s.btn} onPress={review.resetReview}>
          <Text style={s.btnText}>Reset review prompt</Text>
        </Pressable>
      </View>
    </View>
  );
}

function Row({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <View style={s.row}>
      <Text style={[s.rowLabel, muted && s.rowMuted]}>{label}</Text>
      <Text style={[s.rowValue, muted && s.rowMuted]} numberOfLines={1}>{value}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  box: {
    backgroundColor: '#fff',
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    padding: spacing.md,
    gap: 2,
  },
  title: { fontSize: 14, fontWeight: '800', color: colors.text.primary, marginBottom: spacing.xs },
  divider: { height: 1, backgroundColor: '#f1f5f9', marginVertical: spacing.sm },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md, paddingVertical: 2 },
  rowLabel: { fontSize: 12, color: colors.text.secondary, fontWeight: '600' },
  rowValue: { fontSize: 12, color: colors.text.primary, flexShrink: 1, textAlign: 'right' },
  rowMuted: { color: colors.text.muted },
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  btn: {
    flex: 1,
    backgroundColor: colors.brand[50],
    borderRadius: radius.lg,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  btnText: { fontSize: 12, fontWeight: '800', color: colors.brand[600] },
});
