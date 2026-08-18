import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, SafeAreaView, Pressable } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Audio } from 'expo-av';
import { CentsGauge, noteColor } from '../../src/components/practice/CentsGauge';
import { DepthButton } from '../../src/components/practice/DepthButton';
import { useLiveNoteLanding } from '../../src/hooks/useLiveNoteLanding';
import { startMicPitch, stopMicPitch, isMicPitchAvailable } from '../../src/services/micPitch';
import { requestMicPermission } from '../../src/lib/audioCapture';
import { getReferenceNoteUri } from '../../src/lib/referenceNote';
import { noteNameToMidi, midiToFreq } from '../../src/lib/pitchNaming';
import { haptic } from '../../src/lib/haptics';
import { colors, spacing, radius } from '../../src/constants/theme';
import { buildStages, REQUIRED_ALONE } from '../../src/lib/repairLadder';

/**
 * Note repair: drill the notes a take actually missed, one at a time.
 *
 * Passing a tuning drill means every note landed in tune (see sequenceScore).
 * That bar is only fair if a miss is cheap to fix — otherwise one note 30¢ sharp
 * costs a repeat of the whole scale, and the player is mostly replaying the
 * notes they already had. So the misses come here instead, and the scale is
 * retried once they're clean.
 *
 * Live, not recorded. Intonation is fixed inside the note — sound it, hear that
 * it's flat, move until it locks — which a verdict delivered after the take
 * cannot support. See useLiveNoteLanding.
 */

export default function RepairScreen() {
  const params = useLocalSearchParams<{
    notes?: string;
    /** Predecessor for each entry in `notes`, positionally. Blank where none. */
    from?: string;
    cents?: string;
    /** Drill to return to. Passed as params, not a path — block ids contain ':'. */
    blockId?: string;
    sessionId?: string;
    pieceId?: string;
  }>();

  const stages = useMemo(() => {
    const notes = (params.notes ?? '').split(',').map((n) => n.trim()).filter(Boolean);
    const froms = (params.from ?? '').split(',').map((n) => n.trim());
    return buildStages(notes, froms);
  }, [params.notes, params.from]);
  const toleranceCents = Number(params.cents) > 0 ? Number(params.cents) : 20;

  const [index, setIndex] = useState(0);
  const [micReady, setMicReady] = useState(false);
  const [denied, setDenied] = useState(false);

  const stage = stages[index];
  const currentName = stage?.note;
  const targetMidi = currentName ? noteNameToMidi(currentName) : null;
  const targetHz = targetMidi != null ? midiToFreq(targetMidi) : 440;
  const approachMidi = stage?.from ? noteNameToMidi(stage.from) : null;
  const approachHz = approachMidi != null ? midiToFreq(approachMidi) : null;

  const landing = useLiveNoteLanding(
    micReady && targetMidi != null,
    targetHz,
    toleranceCents,
    approachHz,
  );
  const { reset: resetLanding } = landing;

  // ── Mic lifecycle ──────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!isMicPitchAvailable()) return;
      const granted = await requestMicPermission();
      if (cancelled) return;
      if (!granted) { setDenied(true); return; }
      try {
        await startMicPitch();
        if (!cancelled) setMicReady(true);
      } catch {
        if (!cancelled) setDenied(true);
      }
    })();
    return () => {
      cancelled = true;
      void stopMicPitch();
    };
  }, []);

  // ── Reference tone ─────────────────────────────────────────────
  const soundRef = useRef<Audio.Sound | null>(null);
  useEffect(() => () => { soundRef.current?.unloadAsync().catch(() => {}); }, []);

  const playTone = useCallback(async (name: string, midi: number) => {
    await soundRef.current?.unloadAsync();
    const uri = await getReferenceNoteUri(name.replace(/-?\d+$/, ''), midi);
    const { sound } = await Audio.Sound.createAsync({ uri }, { shouldPlay: true });
    soundRef.current = sound;
    await new Promise<void>((resolve) => {
      sound.setOnPlaybackStatusUpdate((st) => {
        if (st.isLoaded && st.didJustFinish) resolve();
      });
    });
  }, []);

  const playReference = useCallback(async () => {
    if (targetMidi == null || !currentName) return;
    haptic.light();
    try {
      // On the interval rung, play the journey rather than the arrival: the
      // distance between the two notes is the thing being learned, and it is
      // not audible in the target note on its own.
      if (stage?.from && approachMidi != null) await playTone(stage.from, approachMidi);
      await playTone(currentName, targetMidi);
    } catch {
      // A missing reference tone is not worth blocking the drill over — the
      // gauge is the feedback that matters.
    }
  }, [targetMidi, currentName, stage?.from, approachMidi, playTone]);

  // Replays per stage, not per note: the isolated and interval rungs share a
  // target, and the interval rung needs to be heard as an interval.
  useEffect(() => {
    if (currentName) void playReference();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  const required = stage?.required ?? REQUIRED_ALONE;
  const cleared = landing.landed >= required;
  const isLast = index >= stages.length - 1;

  useEffect(() => {
    if (cleared) haptic.medium();
  }, [cleared]);

  const goNext = () => {
    resetLanding();
    if (isLast) {
      finish();
      return;
    }
    setIndex((i) => i + 1);
  };

  const finish = () => {
    void stopMicPitch();
    // Back to the drill that sent us here, ready for another attempt.
    if (params.blockId) {
      router.replace({
        pathname: '/practice/[id]',
        params: {
          id: params.blockId,
          ...(params.sessionId ? { sessionId: params.sessionId } : {}),
          ...(params.pieceId ? { pieceId: params.pieceId } : {}),
        },
      });
      return;
    }
    router.back();
  };

  if (stages.length === 0) {
    return (
      <SafeAreaView style={s.safe}>
        <View style={s.body}>
          <Text style={s.title}>Nothing to fix</Text>
        </View>
        <View style={s.bottom}>
          <DepthButton label="Back" icon="arrow-back" onPress={() => router.back()} />
        </View>
      </SafeAreaView>
    );
  }

  const cents = landing.cents;
  const awaitingApproach = !!stage?.from && !landing.approached && !cleared;
  const ringColor = cleared
    ? colors.score.excellent
    : awaitingApproach
      ? '#e5e7eb'
      : landing.voiced && cents != null
        ? noteColor(cents, toleranceCents)
        : '#e5e7eb';

  return (
    <SafeAreaView style={s.safe}>
      <View style={s.header}>
        <Pressable onPress={finish} hitSlop={12} style={s.back}>
          <Ionicons name="close" size={26} color={colors.text.secondary} />
        </Pressable>
        <View style={s.dots}>
          {stages.map((st, i) => (
            <View
              key={`${st.note}-${st.from ?? 'alone'}-${i}`}
              style={[s.dot, i < index && s.dotDone, i === index && s.dotActive]}
            />
          ))}
        </View>
      </View>

      <View style={s.body}>
        <Text style={s.kicker}>
          {cleared ? 'Clean' : `${landing.landed} of ${required}`}
        </Text>

        {/* The interval rung names where the hand is coming from, and dims it
            once it has been heard — so the screen shows which half of the
            journey is still outstanding. */}
        {stage?.from && (
          <View style={s.approachRow}>
            <Text style={[s.approachNote, landing.approached && s.approachDone]}>{stage.from}</Text>
            <Ionicons
              name="arrow-forward"
              size={16}
              color={landing.approached ? colors.score.excellent : colors.text.muted}
            />
            <Text style={s.approachTarget}>{stage.note}</Text>
          </View>
        )}

        <View style={[s.ring, { borderColor: ringColor }]}>
          <Text style={s.note}>{currentName}</Text>
          {landing.voiced && cents != null && !cleared && !awaitingApproach && (
            <Text style={[s.cents, { color: noteColor(cents, toleranceCents) }]}>
              {cents > 0 ? '+' : ''}{Math.round(cents)}¢
            </Text>
          )}
          {cleared && <Ionicons name="checkmark" size={34} color={colors.score.excellent} />}
        </View>

        <CentsGauge
          cents={cents ?? 0}
          active={landing.voiced}
          toleranceCents={toleranceCents}
        />

        {denied ? (
          <Text style={s.hint}>Microphone access is needed to hear the note.</Text>
        ) : !isMicPitchAvailable() ? (
          <Text style={s.hint}>Live tuning needs the iOS build.</Text>
        ) : cleared ? (
          <Text style={s.hint}>Nailed it {required} times.</Text>
        ) : stage?.from ? (
          <Text style={s.hint}>
            Play {stage.from}, then {stage.note} — hold the second one steady.
          </Text>
        ) : (
          // One line, and only the part that isn't obvious from the screen: that
          // it listens by itself, and that holding the note is what counts.
          <Text style={s.hint}>
            Play it after the tone — hold it steady and we&apos;ll tell you when it&apos;s in tune.
          </Text>
        )}
      </View>

      <View style={s.bottom}>
        {cleared ? (
          <DepthButton
            label={isLast ? 'Done — try it again' : stages[index + 1]?.note === stage?.note ? 'Now from the note before' : 'Next note'}
            icon="arrow-forward"
            onPress={goNext}
          />
        ) : (
          <DepthButton label="Hear it" icon="volume-high" variant="neutral" onPress={playReference} />
        )}
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  back: { marginLeft: -spacing.xs },
  dots: { flexDirection: 'row', gap: spacing.xs, flex: 1 },
  dot: { flex: 1, height: 4, borderRadius: 2, backgroundColor: '#e5e7eb' },
  dotDone: { backgroundColor: colors.score.excellent },
  dotActive: { backgroundColor: colors.brand[600] },
  body: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.lg },
  approachRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  approachNote: { fontSize: 22, fontWeight: '800', color: colors.text.secondary },
  approachDone: { color: colors.score.excellent },
  approachTarget: { fontSize: 22, fontWeight: '900', color: colors.text.primary },
  kicker: {
    fontSize: 13,
    fontWeight: '800',
    color: colors.text.muted,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  ring: {
    width: 200,
    height: 200,
    borderRadius: radius.full,
    borderWidth: 6,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    backgroundColor: '#fff',
  },
  title: { fontSize: 24, fontWeight: '800', color: colors.text.primary },
  note: { fontSize: 56, fontWeight: '900', color: colors.text.primary },
  cents: { fontSize: 20, fontWeight: '800' },
  hint: { fontSize: 13, color: colors.text.muted, textAlign: 'center', paddingHorizontal: spacing.xl },
  bottom: { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg, gap: spacing.sm },
});
