import React, { useState, useRef, useEffect } from 'react';
import {
  Modal,
  View,
  Text,
  Pressable,
  StyleSheet,
  Platform,
} from 'react-native';
import { Audio } from 'expo-av';
import { detectPitchFromFile } from '../../services/audioEngine';
import { colors, spacing, radius } from '../../constants/theme';

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

interface NoteInfo {
  name: string;
  octave: number;
  cents: number; // -50 to +50
}

function frequencyToNote(freq: number): NoteInfo {
  const midi = 12 * Math.log2(freq / 440) + 69;
  const roundedMidi = Math.round(midi);
  const cents = Math.round((midi - roundedMidi) * 100);
  const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  const name = NOTE_NAMES[((roundedMidi % 12) + 12) % 12];
  const octave = Math.floor(roundedMidi / 12) - 1;
  return { name, octave, cents };
}

const VIOLIN_STRINGS: { label: string; freq: number }[] = [
  { label: 'G3', freq: 196.0 },
  { label: 'D4', freq: 293.66 },
  { label: 'A4', freq: 440.0 },
  { label: 'E5', freq: 659.25 },
];

const WAV_OPTIONS: Audio.RecordingOptions = {
  android: {
    extension: '.m4a',
    outputFormat: Audio.AndroidOutputFormat.MPEG_4,
    audioEncoder: Audio.AndroidAudioEncoder.AAC,
    sampleRate: 44100,
    numberOfChannels: 1,
    bitRate: 128000,
  },
  ios: {
    extension: '.wav',
    outputFormat: Audio.IOSOutputFormat.LINEARPCM,
    audioQuality: Audio.IOSAudioQuality.MEDIUM,
    sampleRate: 44100,
    numberOfChannels: 1,
    bitRate: 128000,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  web: {},
};

// ─────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────

interface TunerModalProps {
  visible: boolean;
  onClose: () => void;
}

export function TunerModal({ visible, onClose }: TunerModalProps) {
  const [freq, setFreq] = useState<number | null>(null);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const runningRef = useRef(false);
  const smoothBuffer = useRef<number[]>([]);

  useEffect(() => {
    if (visible) {
      setPermissionDenied(false);
      startLoop();
    } else {
      runningRef.current = false;
      smoothBuffer.current = [];
      setFreq(null);
    }
    return () => { runningRef.current = false; };
  }, [visible]);

  async function startLoop() {
    try {
      const { granted } = await Audio.requestPermissionsAsync();
      if (!granted) { setPermissionDenied(true); return; }
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
    } catch {
      return;
    }
    runningRef.current = true;
    loop();
  }

  async function loop() {
    if (!runningRef.current) return;
    try {
      const recording = new Audio.Recording();
      await recording.prepareToRecordAsync(WAV_OPTIONS);
      await recording.startAsync();
      await new Promise<void>((r) => setTimeout(r, 280));
      await recording.stopAndUnloadAsync();
      if (!runningRef.current) return;
      const uri = recording.getURI();
      if (uri) {
        const pitch = await detectPitchFromFile(uri);
        if (!runningRef.current) return;
        if (pitch !== null) {
          smoothBuffer.current = [...smoothBuffer.current.slice(-3), pitch];
          const sorted = [...smoothBuffer.current].sort((a, b) => a - b);
          setFreq(sorted[Math.floor(sorted.length / 2)]);
        } else {
          smoothBuffer.current = smoothBuffer.current.slice(1);
          if (smoothBuffer.current.length === 0) setFreq(null);
        }
      }
    } catch {
      // ignore individual clip errors
    }
    if (runningRef.current) loop();
  }

  const handleClose = async () => {
    runningRef.current = false;
    try { await Audio.setAudioModeAsync({ allowsRecordingIOS: false }); } catch {}
    onClose();
  };

  const note = freq !== null ? frequencyToNote(freq) : null;

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
                {note ? (
                  <>
                    <Text style={[styles.noteName, { color: noteColor(note.cents) }]}>
                      {note.name}
                    </Text>
                    <Text style={styles.noteOctave}>{note.octave}</Text>
                  </>
                ) : (
                  <Text style={styles.noteListening}>Play a note…</Text>
                )}
              </View>

              {/* Cents meter */}
              <CentsMeter cents={note?.cents ?? 0} active={note !== null} />

              {/* Status label */}
              <Text style={[styles.statusText, { color: note ? noteColor(note.cents) : colors.text.muted }]}>
                {note
                  ? Math.abs(note.cents) <= 5
                    ? 'In tune ✓'
                    : `${note.cents > 0 ? '+' : ''}${note.cents}¢`
                  : 'Listening…'}
              </Text>
            </>
          )}

          {/* Violin strings reference */}
          <View style={styles.stringsRow}>
            {VIOLIN_STRINGS.map((s) => {
              const isNearest =
                note !== null &&
                Math.abs(note.cents) <= 30 &&
                Math.abs(freq! - s.freq) < 40;
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
// Cents meter
// ─────────────────────────────────────────────────────────────

function CentsMeter({ cents, active }: { cents: number; active: boolean }) {
  const clamped = Math.max(-50, Math.min(50, cents));
  // 0% = -50¢, 100% = +50¢
  const needlePercent = ((clamped + 50) / 100) * 100;
  const color = noteColor(clamped);

  return (
    <View style={meter.wrap}>
      {/* Tick marks */}
      <View style={meter.ticks}>
        {[-50, -25, 0, 25, 50].map((v) => (
          <View key={v} style={meter.tickCol}>
            <View style={[meter.tick, v === 0 && meter.tickCenter]} />
            <Text style={[meter.tickLabel, v === 0 && meter.tickLabelCenter]}>{v}</Text>
          </View>
        ))}
      </View>

      {/* Track */}
      <View style={meter.track}>
        {/* Green center zone */}
        <View style={meter.greenZone} />
        {/* Needle */}
        {active && (
          <View
            style={[
              meter.needle,
              { left: `${needlePercent}%` as any, backgroundColor: color },
            ]}
          />
        )}
      </View>

      <Text style={meter.centsLabel}>cents</Text>
    </View>
  );
}

function noteColor(cents: number): string {
  const abs = Math.abs(cents);
  if (abs <= 8) return colors.score.excellent;
  if (abs <= 20) return '#f59e0b';
  return colors.score.critical;
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

const meter = StyleSheet.create({
  wrap: { paddingHorizontal: spacing.xl, marginTop: spacing.sm },
  ticks: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  tickCol: { alignItems: 'center', width: 28 },
  tick: { width: 1, height: 8, backgroundColor: '#d1d5db' },
  tickCenter: { height: 12, backgroundColor: '#9ca3af' },
  tickLabel: { fontSize: 9, color: colors.text.muted, marginTop: 2 },
  tickLabelCenter: { fontWeight: '700', color: colors.text.secondary },
  track: {
    height: 20,
    backgroundColor: '#f3f4f6',
    borderRadius: 10,
    overflow: 'hidden',
    position: 'relative',
    justifyContent: 'center',
  },
  greenZone: {
    position: 'absolute',
    left: '42%',
    right: '42%',
    top: 0,
    bottom: 0,
    backgroundColor: '#dcfce7',
  },
  needle: {
    position: 'absolute',
    width: 3,
    top: 2,
    bottom: 2,
    borderRadius: 2,
    transform: [{ translateX: -1.5 }],
  },
  centsLabel: {
    textAlign: 'center',
    fontSize: 11,
    color: colors.text.muted,
    marginTop: spacing.xs,
  },
});
