import React from 'react';
import { TouchableWithoutFeedback, View, Text, Pressable, StyleSheet, Dimensions } from 'react-native';
import { pitchClassInfo } from '../../lib/referenceNote';
import { colors, spacing, radius } from '../../constants/theme';

const PANEL_H = Math.round(Dimensions.get('window').height * 0.42);

/** Bottom-sheet reference-pitch player. Shared by the results screens and the practice runner. */
export function TunePracticePanel({
  pitchClass, midiNote, isPlaying, onToggle, onClose,
}: {
  pitchClass: string;
  midiNote?: number;
  isPlaying: boolean;
  onToggle: () => void;
  onClose: () => void;
}) {
  const { freq, description } = pitchClassInfo(pitchClass, midiNote);
  return (
    <TouchableWithoutFeedback onPress={onClose}>
      <View style={s.backdrop}>
        <TouchableWithoutFeedback>
          <View style={s.sheet}>
            <View style={s.pill} />
            <Text style={s.noteName}>{pitchClass}</Text>
            <Text style={s.noteDesc}>{description}</Text>
            <Text style={s.noteFreq}>{freq} Hz</Text>
            <Text style={s.instruction}>
              Play this note on your violin and adjust until the pitches match.
            </Text>
            <Pressable style={[s.playBtn, isPlaying && s.playBtnActive]} onPress={onToggle}>
              {isPlaying ? (
                <View style={s.pauseIcon}>
                  <View style={s.pauseBar} />
                  <View style={s.pauseBar} />
                </View>
              ) : (
                <Text style={s.playBtnIcon}>▶</Text>
              )}
              <Text style={[s.playBtnText, isPlaying && s.playBtnTextActive]}>
                {isPlaying ? 'Stop' : 'Play note'}
              </Text>
            </Pressable>
            <Pressable onPress={onClose} style={s.doneBtn}>
              <Text style={s.doneBtnText}>Done</Text>
            </Pressable>
          </View>
        </TouchableWithoutFeedback>
      </View>
    </TouchableWithoutFeedback>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: {
    height: PANEL_H,
    backgroundColor: '#fff',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
    paddingBottom: 32,
    gap: spacing.sm,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -6 },
    shadowOpacity: 0.18,
    shadowRadius: 20,
    elevation: 20,
  },
  pill: { width: 36, height: 4, borderRadius: 2, backgroundColor: '#d1d5db', marginTop: 10, marginBottom: 4 },
  noteName: { fontSize: 52, fontWeight: '800', color: colors.brand[700], lineHeight: 60 },
  noteDesc: { fontSize: 14, color: colors.text.secondary, fontWeight: '500', textAlign: 'center' },
  noteFreq: { fontSize: 13, color: colors.text.muted, textAlign: 'center' },
  instruction: { fontSize: 13, color: colors.text.secondary, textAlign: 'center', lineHeight: 19, paddingHorizontal: spacing.md },
  playBtn: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: colors.brand[600], borderRadius: radius.full, paddingHorizontal: 28, paddingVertical: 14, marginTop: spacing.xs },
  playBtnActive: { backgroundColor: colors.score.critical },
  playBtnIcon: { fontSize: 18, color: '#fff' },
  pauseIcon: { flexDirection: 'row', gap: 4, alignItems: 'center' },
  pauseBar: { width: 4, height: 17, backgroundColor: '#fff', borderRadius: 1.5 },
  playBtnText: { fontSize: 16, fontWeight: '700', color: '#fff' },
  playBtnTextActive: {},
  doneBtn: { marginTop: 4 },
  doneBtnText: { fontSize: 14, color: colors.text.muted, fontWeight: '500' },
});
