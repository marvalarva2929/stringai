import React from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { DepthButton } from './DepthButton';
import { useTechniqueSkillStore } from '../../store/useTechniqueSkillStore';
import { colors, radius, spacing } from '../../constants/theme';

// ─────────────────────────────────────────────────────────────
// "Have you been taught to shift?"
//
// Asked once, before the first exercise that would leave first position, and
// never again. It matters because a student who has never been shown a shift
// will not decline the exercise — they will invent a fingering, practise it,
// and get measurably better at something wrong. The app cannot tell the
// difference from the audio, so it has to ask.
//
// "Not yet" is a real answer with a real consequence: every generated drill
// stays in first position until they say otherwise, which they can do from
// Settings.
// ─────────────────────────────────────────────────────────────

export function ThirdPositionGate({
  onAnswered,
  onDismiss,
}: {
  onAnswered: (canShift: boolean) => void;
  onDismiss: () => void;
}) {
  const setThirdPosition = useTechniqueSkillStore((st) => st.setThirdPosition);

  const answer = (canShift: boolean) => {
    setThirdPosition(canShift ? 'yes' : 'no');
    onAnswered(canShift);
  };

  return (
    <View style={s.wrap}>
      <ScrollView contentContainerStyle={s.content} showsVerticalScrollIndicator={false}>
        <View style={s.badge}>
          <Ionicons name="hand-left-outline" size={26} color={colors.brand[700]} />
        </View>

        <Text style={s.eyebrow}>One question first</Text>
        <Text style={s.title}>Have you learned to shift into 3rd position?</Text>

        <Text style={s.body}>
          This exercise moves your left hand up the string instead of staying where it starts.
          If that's new to you it's worth learning properly with a teacher first — practising a
          shift you're guessing at just makes the guess more permanent.
        </Text>

        <View style={s.explainer}>
          <Text style={s.explainerTitle}>What 3rd position means</Text>
          <Text style={s.explainerBody}>
            In first position your hand sits at the top of the fingerboard and your 1st finger
            plays the note a whole step above the open string. In third position the whole hand
            moves up so your 1st finger takes the note your 3rd finger used to play — on the D
            string, that's G.
          </Text>
        </View>

        <View style={s.actions}>
          <DepthButton label="Yes, I can shift" icon="checkmark" onPress={() => answer(true)} />
          <DepthButton
            label="Not yet — keep me in 1st position"
            icon="hand-left"
            variant="neutral"
            onPress={() => answer(false)}
          />
        </View>

        <Pressable style={s.skip} onPress={onDismiss}>
          <Text style={s.skipText}>Ask me later</Text>
        </Pressable>

        <Text style={s.footnote}>You can change this any time in Settings.</Text>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.background },
  content: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: spacing.lg,
    gap: spacing.md,
  },
  badge: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.brand[50],
  },
  eyebrow: {
    fontSize: 12,
    fontWeight: '900',
    color: colors.text.muted,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  title: { fontSize: 26, fontWeight: '900', color: colors.text.primary, lineHeight: 32 },
  body: { fontSize: 15, lineHeight: 22, color: colors.text.secondary },
  explainer: {
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    padding: spacing.md,
    gap: 6,
    borderWidth: 1.5,
    borderColor: '#eef2f7',
  },
  explainerTitle: { fontSize: 14, fontWeight: '900', color: colors.text.primary },
  explainerBody: { fontSize: 14, lineHeight: 21, color: colors.text.secondary },
  actions: { gap: spacing.sm, marginTop: spacing.xs },
  skip: { alignItems: 'center', paddingVertical: spacing.sm },
  skipText: { fontSize: 14, fontWeight: '700', color: colors.text.muted },
  footnote: { fontSize: 12, color: colors.text.muted, textAlign: 'center' },
});
