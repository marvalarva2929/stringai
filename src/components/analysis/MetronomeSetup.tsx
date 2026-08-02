import React, { useEffect, useRef } from 'react';
import { View, Text, Pressable, Switch, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useMetronome } from '../../hooks/useMetronome';
import { useMetronomeStore, BPM_STEP, MIN_BPM, MAX_BPM } from '../../store/useMetronomeStore';
import { Slider } from '../ui/Slider';
import { haptic } from '../../lib/haptics';
import { colors, radius, spacing } from '../../constants/theme';

/**
 * Metronome setup, shown on the "Position yourself" screen before a take.
 *
 * It is deliberately placed here rather than on the recording screen: the player
 * is holding the phone at this point, and once recording starts they're two
 * metres away and can't change anything.
 *
 * Mounting pre-writes the click WAV to cache (preload) so the first beat isn't
 * delayed by file I/O — but it does NOT touch the audio session. The camera
 * preview is already running on this screen, and reconfiguring the shared
 * AVAudioSession would interrupt that capture stream (freezing the pose/bow
 * feed the calibration step and live coach rely on). The session is set up
 * lazily, only when a click actually plays (preview "Try it", or the take).
 */
export function MetronomeSetup() {
  const { enabled, bpm, sound, setEnabled, setBpm, setSound } = useMetronomeStore();
  const preview = useMetronome(bpm, Number.POSITIVE_INFINITY, undefined, { muted: !sound });
  const { preload, start, stop, running } = preview;
  const runningRef = useRef(running);
  runningRef.current = running;
  // True while the slider is being dragged — the restart-on-tempo-change effect
  // below stands down so the preview doesn't stop/start on every beat swept
  // past. It restarts once, on release (onSlidingComplete).
  const draggingRef = useRef(false);

  useEffect(() => {
    void preload();
  }, [preload]);

  // Stop the preview on unmount — otherwise it would click through the take.
  useEffect(() => () => stop(), [stop]);

  // The interval length is fixed when the metronome starts, so a tempo change
  // mid-preview only takes effect after a restart.
  useEffect(() => {
    if (!runningRef.current || draggingRef.current) return;
    stop();
    void start();
  }, [bpm, sound, start, stop]);

  const step = (delta: number) => {
    haptic.light();
    setBpm(bpm + delta);
  };

  const togglePreview = () => {
    haptic.light();
    if (running) stop();
    else void start();
  };

  return (
    <View style={s.card}>
      <View style={s.headerRow}>
        <Ionicons name="timer-outline" size={20} color={colors.brand[600]} />
        <Text style={s.title}>Metronome</Text>
        <Switch
          value={enabled}
          onValueChange={(next) => {
            haptic.light();
            setEnabled(next);
            if (!next && running) stop();
          }}
          trackColor={{ true: colors.brand[500], false: '#d1d5db' }}
        />
      </View>

      {enabled && (
        <>
          <View style={s.bpmRow}>
            <View style={s.bpmValue}>
              <Text style={s.bpmNumber}>{bpm}</Text>
              <Text style={s.bpmLabel}>BPM</Text>
            </View>

            <Pressable style={[s.previewBtn, running && s.previewBtnActive]} onPress={togglePreview}>
              <Ionicons
                name={running ? 'stop' : 'play'}
                size={16}
                color={running ? '#fff' : colors.brand[700]}
              />
              <Text style={[s.previewLabel, running && s.previewLabelActive]}>
                {running ? 'Stop' : 'Try it'}
              </Text>
            </Pressable>
          </View>

          {/* Slider for a coarse sweep, ±1 steppers for exact tempos. */}
          <View style={s.sliderRow}>
            <Pressable
              style={[s.stepBtn, bpm <= MIN_BPM && s.stepBtnDisabled]}
              onPress={() => step(-BPM_STEP)}
              disabled={bpm <= MIN_BPM}
              hitSlop={8}
            >
              <Ionicons name="remove" size={20} color={colors.brand[700]} />
            </Pressable>

            <View style={s.sliderTrack}>
              <Slider
                value={bpm}
                min={MIN_BPM}
                max={MAX_BPM}
                step={1}
                onChange={setBpm}
                onSlidingStart={() => { draggingRef.current = true; }}
                onSlidingComplete={() => {
                  draggingRef.current = false;
                  haptic.light();
                  // The preview's tempo was frozen while dragging; apply the
                  // final value now.
                  if (runningRef.current) { stop(); void start(); }
                }}
              />
            </View>

            <Pressable
              style={[s.stepBtn, bpm >= MAX_BPM && s.stepBtnDisabled]}
              onPress={() => step(BPM_STEP)}
              disabled={bpm >= MAX_BPM}
              hitSlop={8}
            >
              <Ionicons name="add" size={20} color={colors.brand[700]} />
            </Pressable>
          </View>

          <Pressable style={s.soundRow} onPress={() => { haptic.light(); setSound(!sound); }}>
            <Ionicons
              name={sound ? 'volume-high-outline' : 'volume-mute-outline'}
              size={18}
              color={colors.text.secondary}
            />
            <Text style={s.soundLabel}>{sound ? 'Click on' : 'Click off — visual beat only'}</Text>
            <Switch
              value={sound}
              onValueChange={(next) => { haptic.light(); setSound(next); }}
              trackColor={{ true: colors.brand[500], false: '#d1d5db' }}
            />
          </Pressable>

          {sound && (
            <Text style={s.hint}>
              The click is picked up by the mic along with your playing. Headphones give the cleanest
              analysis.
            </Text>
          )}
        </>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    width: '100%',
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    padding: spacing.md,
    gap: spacing.md,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  title: { flex: 1, fontSize: 15, fontWeight: '700', color: colors.text.primary },
  bpmRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  sliderRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  sliderTrack: { flex: 1 },
  stepBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.brand[50],
  },
  stepBtnDisabled: { opacity: 0.4 },
  bpmValue: { flex: 1, flexDirection: 'row', alignItems: 'baseline', gap: spacing.xs },
  bpmNumber: { fontSize: 32, fontWeight: '800', color: colors.text.primary, lineHeight: 36 },
  bpmLabel: { fontSize: 12, fontWeight: '700', color: colors.text.muted, letterSpacing: 1 },
  previewBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.full,
    backgroundColor: colors.brand[50],
  },
  previewBtnActive: { backgroundColor: colors.brand[600] },
  previewLabel: { fontSize: 13, fontWeight: '700', color: colors.brand[700] },
  previewLabelActive: { color: '#fff' },
  soundRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  soundLabel: { flex: 1, fontSize: 13, color: colors.text.secondary },
  hint: { fontSize: 12, color: colors.text.muted, lineHeight: 17 },
});
