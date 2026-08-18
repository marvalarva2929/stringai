import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, Alert } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { colors, spacing, radius } from '../../constants/theme';
import { BigButton } from '../ui/BigButton';
import { haptic } from '../../lib/haptics';
import { useMetronome } from '../../hooks/useMetronome';
import { useTakeLiveFeedback } from '../../hooks/useTakeLiveFeedback';
import { scaleNoteSequence } from '../../lib/scaleSequence';
import {
  requestMicPermission,
  startTakeRecording,
  stopTakeRecording,
  type Recording,
} from '../../lib/audioCapture';
import { track } from '../../services/analytics';
import { AnalyticsEvent } from '../../constants/analyticsEvents';

/**
 * The first-run diagnostic: twenty seconds of the user's own playing, measured.
 *
 * This replaces a hand-authored sample analysis that every user used to be
 * walked through instead. The sample is well made, but it is somebody else's
 * playing — which is exactly what a screenshot or a video of the app can also
 * show. Hearing your own third finger come back flat is the one thing the
 * product can do that nothing else in the funnel can, and it belongs *before*
 * the paywall rather than after it.
 *
 * A D major scale specifically: first position on every string, no shifts, and
 * it is the scale a beginner is most likely to already know. The sequence is
 * metronome-paced so each note lands on a known beat, which is what lets the
 * evaluator compare a note against the degree it was *meant* to be rather than
 * rounding to whatever chromatic pitch it landed nearest.
 *
 * The take is audio-only on purpose. Bow and posture scoring is still
 * uncalibrated (see HIDDEN_SCORE_KEYS in src/lib/scoring.ts) and needs the
 * camera propped up, which is a much larger ask thirty seconds into a first
 * run. Intonation is the calibrated part of the stack and the part worth
 * betting the first impression on.
 */

/** One note per beat at 60bpm — slow enough to play in tune, not so slow it drags. */
const BPM = 60;
const SCALE_NAME = 'D major';
/** Beats of audible count-in before the first graded note. */
const LEAD_IN_BEATS = 4;
/** Recording tail after the final click, so the last note isn't clipped. */
const TAIL_MS = 1200;
/** Hard ceiling, in case the metronome callback never lands. */
const MAX_TAKE_MS = 45_000;

type Stage = 'intro' | 'recording' | 'analyzing';

interface DiagnosticTakeProps {
  /** Hands the recorded WAV to the normal analysis path. */
  onAnalyze: (uri: string, durationSeconds: number) => void;
  /** "I don't have my violin" — falls back to the sample analysis. */
  onUseDemo: () => void;
}

export function DiagnosticTake({ onAnalyze, onUseDemo }: DiagnosticTakeProps) {
  const insets = useSafeAreaInsets();
  const [stage, setStage] = useState<Stage>('intro');
  const notes = React.useMemo(() => scaleNoteSequence(SCALE_NAME), []);

  const recordingRef = useRef<Recording | null>(null);
  const startedAtRef = useRef(0);
  const finishingRef = useRef(false);

  const live = useTakeLiveFeedback(stage === 'recording');

  /** Stops the mic and hands the file over. Guarded — several paths race to it. */
  const finish = useCallback(async () => {
    if (finishingRef.current) return;
    finishingRef.current = true;
    const rec = recordingRef.current;
    recordingRef.current = null;
    if (!rec) return;

    setStage('analyzing');
    const durationSeconds = Math.max(1, (Date.now() - startedAtRef.current) / 1000);
    try {
      const uri = await stopTakeRecording(rec);
      if (!uri) throw new Error('no_uri');
      track(AnalyticsEvent.RECORDING_STOPPED, {
        source: 'diagnostic',
        duration_sec: Math.round(durationSeconds),
      });
      onAnalyze(uri, durationSeconds);
    } catch {
      track(AnalyticsEvent.RECORDING_FAILED, { source: 'diagnostic', reason: 'stop_failed' });
      Alert.alert(
        "That take didn't record",
        'Something went wrong with the microphone. You can try again, or look at a sample analysis instead.',
        [
          { text: 'Try again', onPress: () => { finishingRef.current = false; setStage('intro'); } },
          { text: 'See a sample', onPress: onUseDemo },
        ],
      );
    }
  }, [onAnalyze, onUseDemo]);

  // The metronome bounds the take: it stops itself after the last note, and the
  // tail below covers the note still ringing when that happens.
  const metronome = useMetronome(BPM, notes.length, undefined, { beatsPerBar: 4 });
  const { running, currentBeat, inLeadIn, leadInRemaining, start: startMetronome, stop: stopMetronome, preload } = metronome;

  useEffect(() => { preload(); }, [preload]);

  // `running` goes false when the metronome reaches the final beat. Waiting a
  // beat past that keeps the last note whole instead of cutting it mid-bow.
  useEffect(() => {
    if (stage !== 'recording' || running) return;
    const t = setTimeout(() => { void finish(); }, TAIL_MS);
    return () => clearTimeout(t);
  }, [stage, running, finish]);

  // Backstop. If the metronome clock is interrupted (a call, the app
  // backgrounded mid-take) nothing else would ever stop the recorder.
  useEffect(() => {
    if (stage !== 'recording') return;
    const t = setTimeout(() => { void finish(); }, MAX_TAKE_MS);
    return () => clearTimeout(t);
  }, [stage, finish]);

  useEffect(() => {
    return () => {
      stopMetronome();
      const rec = recordingRef.current;
      recordingRef.current = null;
      if (rec) stopTakeRecording(rec).catch(() => {});
    };
  }, [stopMetronome]);

  const begin = async () => {
    haptic.light();
    const granted = await requestMicPermission();
    if (!granted) {
      track(AnalyticsEvent.PERMISSION_RESULT, { permission: 'microphone', granted: false, context: 'diagnostic' });
      Alert.alert(
        'Microphone needed',
        "StringAI listens to your playing to measure it. You can enable the microphone in Settings, or look at a sample analysis for now.",
        [
          { text: 'Not now', style: 'cancel' },
          { text: 'See a sample', onPress: onUseDemo },
        ],
      );
      return;
    }

    try {
      finishingRef.current = false;
      recordingRef.current = (await startTakeRecording()).recording;
      startedAtRef.current = Date.now();
      setStage('recording');
      track(AnalyticsEvent.RECORDING_STARTED, { source: 'diagnostic' });
      // Recording is already open, so the count-in the player hears is also on
      // the tape — the evaluator keys notes to beats, and those beats have to
      // be the same clock the microphone heard.
      await startMetronome({ leadInBeats: LEAD_IN_BEATS });
    } catch {
      track(AnalyticsEvent.RECORDING_FAILED, { source: 'diagnostic', reason: 'start_failed' });
      Alert.alert('Could not start recording', 'Something went wrong with the microphone.');
      setStage('intro');
    }
  };

  if (stage === 'analyzing') {
    return (
      <View style={[styles.root, styles.centered]}>
        <Animated.View entering={FadeIn.duration(200)} style={styles.centered}>
          <Text style={styles.analyzingTitle}>Listening back…</Text>
          <Text style={styles.analyzingSub}>Measuring every note you just played.</Text>
        </Animated.View>
      </View>
    );
  }

  if (stage === 'recording') {
    return (
      <View style={[styles.root, { paddingTop: insets.top + spacing.xl }]}>
        {inLeadIn ? (
          <View style={styles.centered}>
            <Text style={styles.countIn}>{leadInRemaining}</Text>
            <Text style={styles.countInSub}>Get ready…</Text>
          </View>
        ) : (
          <View style={styles.centered}>
            <Text style={styles.nowPlayingLabel}>Play</Text>
            <Text style={styles.nowPlayingNote}>{notes[currentBeat] ?? '—'}</Text>
            <CentsNeedle cents={live.cents} noteName={live.noteName} voiced={live.voiced} />
            <View style={styles.beadRow}>
              {notes.map((n, i) => (
                <View
                  key={`${n}-${i}`}
                  style={[
                    styles.bead,
                    i === currentBeat && styles.beadActive,
                    i < currentBeat && styles.beadDone,
                  ]}
                />
              ))}
            </View>
          </View>
        )}
      </View>
    );
  }

  return (
    <View style={[styles.root, { paddingTop: insets.top + spacing.xl }]}>
      <View style={styles.introBody}>
        <Text style={styles.title}>Let's hear you play</Text>
        <Text style={styles.subtitle}>
          Play a {SCALE_NAME} scale, one note per click — up and back down. About twenty seconds.
        </Text>

        <View style={styles.scaleCard}>
          <Text style={styles.scaleCardLabel}>The notes</Text>
          <Text style={styles.scaleCardNotes}>{notes.slice(0, 8).join('  ')}</Text>
          <Text style={styles.scaleCardHint}>…then back down again.</Text>
        </View>

        <Text style={styles.reassure}>
          Play it exactly as it comes out — this is a measurement, not a test. Whatever it finds
          becomes the first thing your practice plan works on.
        </Text>
      </View>

      <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.xl }]}>
        <BigButton label="I'm ready" onPress={begin} />
        <Pressable onPress={onUseDemo} style={styles.skipBtn}>
          <Text style={styles.skipText}>I don't have my violin right now</Text>
        </Pressable>
      </View>
    </View>
  );
}

/**
 * Live cents readout. Deliberately shows the direction and a coarse magnitude
 * rather than a precise number — the detector biases toward equal temperament
 * on real audio (see docs/practice-consolidation-plan.md), so a confident
 * two-decimal figure would be claiming more precision than it has.
 */
function CentsNeedle({ cents, noteName, voiced }: { cents: number | null; noteName: string | null; voiced: boolean }) {
  if (!voiced || cents == null || !noteName) {
    return (
      <Animated.Text entering={FadeIn} exiting={FadeOut} style={styles.needleIdle}>
        listening…
      </Animated.Text>
    );
  }
  const flat = cents < -8;
  const sharp = cents > 8;
  const label = flat ? 'a little flat' : sharp ? 'a little sharp' : 'in tune';
  const tone = flat || sharp ? colors.brand[600] : '#16a34a';
  return (
    <Animated.View entering={FadeIn.duration(120)} style={styles.needleWrap}>
      <Text style={styles.needleNote}>{noteName}</Text>
      <Text style={[styles.needleLabel, { color: tone }]}>{label}</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background, paddingHorizontal: spacing.xl },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm },

  introBody: { flex: 1, gap: spacing.md, paddingTop: spacing.lg },
  title: { fontSize: 28, fontWeight: '800', color: colors.text.primary, textAlign: 'center' },
  subtitle: {
    fontSize: 15,
    color: colors.text.secondary,
    textAlign: 'center',
    lineHeight: 22,
  },
  scaleCard: {
    backgroundColor: '#fff',
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    padding: spacing.lg,
    gap: 6,
    marginTop: spacing.md,
  },
  scaleCardLabel: { fontSize: 12, fontWeight: '700', color: colors.text.muted, letterSpacing: 0.6 },
  scaleCardNotes: { fontSize: 18, fontWeight: '700', color: colors.text.primary },
  scaleCardHint: { fontSize: 13, color: colors.text.secondary },
  reassure: {
    fontSize: 13,
    color: colors.text.muted,
    textAlign: 'center',
    lineHeight: 19,
    marginTop: spacing.md,
  },

  footer: { gap: spacing.sm },
  skipBtn: { paddingVertical: spacing.sm, alignItems: 'center' },
  skipText: { fontSize: 14, color: colors.text.muted, fontWeight: '600' },

  analyzingTitle: { fontSize: 24, fontWeight: '800', color: colors.text.primary },
  analyzingSub: { fontSize: 15, color: colors.text.secondary, textAlign: 'center' },

  countIn: { fontSize: 88, fontWeight: '900', color: colors.brand[600] },
  countInSub: { fontSize: 16, color: colors.text.secondary },

  nowPlayingLabel: { fontSize: 13, fontWeight: '700', color: colors.text.muted, letterSpacing: 1 },
  nowPlayingNote: { fontSize: 72, fontWeight: '900', color: colors.text.primary },

  needleWrap: { alignItems: 'center', gap: 2, height: 52 },
  needleNote: { fontSize: 20, fontWeight: '800', color: colors.text.secondary },
  needleLabel: { fontSize: 15, fontWeight: '700' },
  needleIdle: { fontSize: 15, color: colors.text.muted, height: 52 },

  beadRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 6,
    marginTop: spacing.xl,
    paddingHorizontal: spacing.lg,
  },
  bead: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#e5e7eb' },
  beadActive: { backgroundColor: colors.brand[600], transform: [{ scale: 1.3 }] },
  beadDone: { backgroundColor: colors.brand[300] },
});
