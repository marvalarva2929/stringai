import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  Modal,
  View,
  Text,
  Pressable,
  StyleSheet,
  Platform,
} from 'react-native';
import { useSharedValue } from 'react-native-reanimated';
import { Audio } from 'expo-av';
import { detectPitchFromFile } from '../../services/audioEngine';
import {
  isMicPitchAvailable,
  startMicPitch,
  stopMicPitch,
  addPitchListener,
  type PitchReading,
} from '../../services/micPitch';
import { WAV_OPTIONS } from '../../lib/audioCapture';
import { CentsGauge, noteColor } from '../practice/CentsGauge';
import { colors, spacing, radius } from '../../constants/theme';

// ─────────────────────────────────────────────────────────────
// Tuning constants
// ─────────────────────────────────────────────────────────────

/** Median filter width over incoming Hz. Kills the occasional octave flip without adding real lag. */
const MEDIAN_WINDOW = 5;
/** EMA on cents. At ~47 readings/sec, 0.3 gives a ~65ms time constant — smooth but still lively. */
const CENTS_EMA_ALPHA = 0.3;
/** Consecutive readings agreeing on a new note before we switch the big letter. ~64ms. */
const NOTE_COMMIT_FRAMES = 3;
/** How long without a voiced reading before we fall back to "Play a note…". */
const SILENCE_TIMEOUT_MS = 350;
/** The needle runs at full rate on the UI thread; the numeric readout only needs ~12Hz to be legible. */
const READOUT_INTERVAL_MS = 80;

const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

const VIOLIN_STRINGS: { label: string; freq: number }[] = [
  { label: 'G3', freq: 196.0 },
  { label: 'D4', freq: 293.66 },
  { label: 'A4', freq: 440.0 },
  { label: 'E5', freq: 659.25 },
];

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

interface NoteInfo {
  name: string;
  octave: number;
  midi: number;
}

function midiToNote(midi: number): NoteInfo {
  return {
    name: NOTE_NAMES[((midi % 12) + 12) % 12],
    octave: Math.floor(midi / 12) - 1,
    midi,
  };
}

function hzToMidiFloat(hz: number): number {
  return 12 * Math.log2(hz / 440) + 69;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** What the (throttled) React tree renders. The needle does not go through here. */
interface Display {
  note: NoteInfo;
  cents: number;
  hz: number;
}

// ─────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────

interface TunerModalProps {
  visible: boolean;
  onClose: () => void;
}

export function TunerModal({ visible, onClose }: TunerModalProps) {
  const [display, setDisplay] = useState<Display | null>(null);
  const [permissionDenied, setPermissionDenied] = useState(false);

  /** Live cents, consumed by CentsGauge on the UI thread. Never triggers a React render. */
  const centsSv = useSharedValue(0);

  // Smoothing state — refs so the hot path never causes a render.
  const hzBuf = useRef<number[]>([]);
  const emaCents = useRef<number | null>(null);
  const committedMidi = useRef<number | null>(null);
  const candidateMidi = useRef<number | null>(null);
  const candidateCount = useRef(0);
  const lastVoicedAt = useRef(0);
  const lastReadoutAt = useRef(0);

  const resetSmoothing = useCallback(() => {
    hzBuf.current = [];
    emaCents.current = null;
    committedMidi.current = null;
    candidateMidi.current = null;
    candidateCount.current = 0;
    lastVoicedAt.current = 0;
    lastReadoutAt.current = 0;
    centsSv.value = 0;
  }, [centsSv]);

  // ── The hot path: ~47 readings/sec ────────────────────────────────────
  const onReading = useCallback((reading: PitchReading) => {
    const now = Date.now();

    if (!reading.voiced) {
      if (lastVoicedAt.current !== 0 && now - lastVoicedAt.current > SILENCE_TIMEOUT_MS) {
        resetSmoothing();
        setDisplay(null);
      }
      return;
    }

    lastVoicedAt.current = now;

    hzBuf.current.push(reading.hz);
    if (hzBuf.current.length > MEDIAN_WINDOW) hzBuf.current.shift();
    const hz = median(hzBuf.current);

    const midiFloat = hzToMidiFloat(hz);
    const nearestMidi = Math.round(midiFloat);

    // Note hysteresis: a new letter has to hold for a few frames before it wins, otherwise
    // playing exactly between two semitones makes the display strobe.
    let noteChanged = false;
    if (committedMidi.current === null) {
      committedMidi.current = nearestMidi;
      emaCents.current = null;
      noteChanged = true;
    } else if (nearestMidi === committedMidi.current) {
      candidateMidi.current = null;
      candidateCount.current = 0;
    } else if (nearestMidi === candidateMidi.current) {
      candidateCount.current += 1;
      if (candidateCount.current >= NOTE_COMMIT_FRAMES) {
        committedMidi.current = nearestMidi;
        candidateMidi.current = null;
        candidateCount.current = 0;
        emaCents.current = null;
        noteChanged = true;
      }
    } else {
      candidateMidi.current = nearestMidi;
      candidateCount.current = 1;
    }

    // Cents are measured against the *committed* note, so the needle stays continuous
    // across the hysteresis window instead of snapping from +50 to -50.
    const cents = (midiFloat - committedMidi.current!) * 100;
    emaCents.current = emaCents.current === null
      ? cents
      : emaCents.current + CENTS_EMA_ALPHA * (cents - emaCents.current);

    centsSv.value = emaCents.current;

    // Push to React on a note change immediately; otherwise throttle the readout.
    if (noteChanged || now - lastReadoutAt.current >= READOUT_INTERVAL_MS) {
      lastReadoutAt.current = now;
      setDisplay({
        note: midiToNote(committedMidi.current!),
        cents: Math.round(emaCents.current),
        hz,
      });
    }
  }, [centsSv, resetSmoothing]);

  // ── Streaming path (iOS native module) ────────────────────────────────
  useEffect(() => {
    if (!visible || !isMicPitchAvailable()) return;

    let cancelled = false;
    let subscription: { remove: () => void } | null = null;

    (async () => {
      const { granted } = await Audio.requestPermissionsAsync();
      if (cancelled) return;
      if (!granted) {
        setPermissionDenied(true);
        return;
      }

      setPermissionDenied(false);
      subscription = addPitchListener(onReading);

      try {
        await startMicPitch();
      } catch {
        if (!cancelled) setPermissionDenied(true);
      }
    })();

    return () => {
      cancelled = true;
      subscription?.remove();
      void (async () => {
        await stopMicPitch();
        // The native tap runs the session in .measurement mode, which attenuates output.
        // Hand the session back to expo-av or the rest of the app plays back quiet.
        try {
          await Audio.setAudioModeAsync({ allowsRecordingIOS: false });
        } catch {}
      })();
      resetSmoothing();
      setDisplay(null);
    };
  }, [visible, onReading, resetSmoothing]);

  // ── Legacy path (Android / Expo Go): record short clips and analyze them ──
  // Far slower (~1 reading/sec) but keeps the tuner functional where the native tap
  // isn't available. iOS uses the streaming path above.
  const legacyRunning = useRef(false);
  useEffect(() => {
    if (!visible || isMicPitchAvailable()) return;

    let cancelled = false;

    async function loop() {
      if (!legacyRunning.current || cancelled) return;
      try {
        const recording = new Audio.Recording();
        await recording.prepareToRecordAsync(WAV_OPTIONS);
        await recording.startAsync();
        await new Promise<void>((r) => setTimeout(r, 280));
        await recording.stopAndUnloadAsync();
        if (!legacyRunning.current || cancelled) return;

        const uri = recording.getURI();
        if (uri) {
          const hz = await detectPitchFromFile(uri);
          if (!legacyRunning.current || cancelled) return;
          if (hz !== null) {
            onReading({ hz, clarity: 1, rms: 1, voiced: true });
          } else {
            onReading({ hz: 0, clarity: 0, rms: 0, voiced: false });
          }
        }
      } catch {
        // ignore individual clip errors
      }
      if (legacyRunning.current && !cancelled) loop();
    }

    (async () => {
      try {
        const { granted } = await Audio.requestPermissionsAsync();
        if (cancelled) return;
        if (!granted) {
          setPermissionDenied(true);
          return;
        }
        setPermissionDenied(false);
        await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      } catch {
        return;
      }
      legacyRunning.current = true;
      loop();
    })();

    return () => {
      cancelled = true;
      legacyRunning.current = false;
      void Audio.setAudioModeAsync({ allowsRecordingIOS: false }).catch(() => {});
      resetSmoothing();
      setDisplay(null);
    };
  }, [visible, onReading, resetSmoothing]);

  // Teardown lives in the effect cleanups above so it runs on every close path
  // (backdrop, ✕, hardware back, unmount), not just this one.
  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  const active = display !== null;
  const statusColor = active ? noteColor(display.cents) : colors.text.muted;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={handleClose}
      statusBarTranslucent
    >
      <View style={styles.overlay}>
        <Pressable style={styles.backdrop} onPress={handleClose} />
        <View style={styles.sheet}>
          {/* Header */}
          <View style={styles.header}>
            <View style={styles.handle} />
            <View style={styles.headerRow}>
              <Text style={styles.headerTitle}>Tuner</Text>
              <Pressable style={styles.closeBtn} onPress={handleClose} hitSlop={12}>
                <Text style={styles.closeBtnText}>✕</Text>
              </Pressable>
            </View>
          </View>

          {permissionDenied ? (
            <View style={styles.permissionBox}>
              <Text style={styles.permissionText}>
                Microphone access is needed for the tuner. Enable it in Settings.
              </Text>
            </View>
          ) : (
            <>
              {/* Note name */}
              <View style={styles.noteDisplay}>
                {active ? (
                  <>
                    <Text style={[styles.noteName, { color: noteColor(display.cents) }]}>
                      {display.note.name}
                    </Text>
                    <Text style={styles.noteOctave}>{display.note.octave}</Text>
                  </>
                ) : (
                  <Text style={styles.noteListening}>Play a note…</Text>
                )}
              </View>

              {/* Cents meter — needle is driven from centsSv on the UI thread */}
              <CentsGauge cents={display?.cents ?? 0} active={active} centsSv={centsSv} />

              {/* Status label */}
              <Text style={[styles.statusText, { color: statusColor }]}>
                {active
                  ? Math.abs(display.cents) <= 5
                    ? 'In tune ✓'
                    : `${display.cents > 0 ? '+' : ''}${display.cents}¢`
                  : 'Listening…'}
              </Text>
            </>
          )}

          {/* Violin strings reference */}
          <View style={styles.stringsRow}>
            {VIOLIN_STRINGS.map((s) => {
              const isNearest =
                display !== null &&
                Math.abs(display.cents) <= 30 &&
                Math.abs(display.hz - s.freq) < 40;
              return (
                <View
                  key={s.label}
                  style={[styles.stringChip, isNearest && styles.stringChipActive]}
                >
                  <Text style={[styles.stringLabel, isNearest && styles.stringLabelActive]}>
                    {s.label}
                  </Text>
                </View>
              );
            })}
          </View>
        </View>
      </View>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  backdrop: { flex: 1 },
  sheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingBottom: Platform.OS === 'ios' ? 32 : 20,
  },

  header: { alignItems: 'center', paddingTop: spacing.sm },
  handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: '#e5e7eb', marginBottom: spacing.md },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    paddingHorizontal: spacing.xl,
    marginBottom: spacing.md,
  },
  headerTitle: { fontSize: 18, fontWeight: '700', color: colors.text.primary },
  closeBtn: { padding: 4 },
  closeBtnText: { fontSize: 16, color: colors.text.muted, fontWeight: '600' },

  noteDisplay: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'center',
    height: 100,
    gap: 4,
  },
  noteName: { fontSize: 80, fontWeight: '800', lineHeight: 90 },
  noteOctave: { fontSize: 32, fontWeight: '600', color: colors.text.secondary, marginBottom: 12 },
  noteListening: { fontSize: 20, color: colors.text.muted, alignSelf: 'center' },

  statusText: {
    textAlign: 'center',
    fontSize: 16,
    fontWeight: '700',
    marginTop: spacing.sm,
    marginBottom: spacing.lg,
  },

  permissionBox: {
    margin: spacing.lg,
    padding: spacing.md,
    backgroundColor: '#fef3c7',
    borderRadius: radius.md,
  },
  permissionText: { fontSize: 14, color: '#92400e', textAlign: 'center', lineHeight: 20 },

  stringsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    marginTop: spacing.sm,
  },
  stringChip: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 10,
    borderRadius: radius.md,
    backgroundColor: '#f3f4f6',
  },
  stringChipActive: { backgroundColor: colors.brand[100] },
  stringLabel: { fontSize: 15, fontWeight: '700', color: colors.text.secondary },
  stringLabelActive: { color: colors.brand[700] },
});
