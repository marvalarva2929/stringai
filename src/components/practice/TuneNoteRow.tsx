import React, { useState } from 'react';
import { View, Pressable, Text, StyleSheet, Modal } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTuneNote } from '../../hooks/useTuneNote';
import { TunePracticePanel } from './TuneNotePanel';
import { PITCH_CLASS_MIDI, noteNameToMidi } from '../../lib/pitchNaming';
import type { PracticeBlock } from '../../lib/practiceBlocks';
import { colors, spacing, radius } from '../../constants/theme';

/** "Tune the string" / "Hear the note" chips for pitch-targeted exercises. */
export function TuneNoteRow({ block }: { block: PracticeBlock }) {
  const { playingNote, toggle, stopAll } = useTuneNote();
  const [panel, setPanel] = useState<{ pitchClass: string; midi?: number } | null>(null);

  const targetPitchClass = block.target.pitchClass ?? block.target.noteName;
  const targetMidi = block.target.midiNote ?? (block.target.noteName ? noteNameToMidi(block.target.noteName) ?? undefined : undefined);
  const stringLetter = block.target.string;

  if (!targetPitchClass && !stringLetter) return null;

  const open = (pitchClass: string, midi?: number) => {
    setPanel({ pitchClass, midi });
    toggle(pitchClass, midi);
  };
  const close = () => {
    stopAll();
    setPanel(null);
  };

  return (
    <>
      <View style={s.row}>
        {stringLetter && (
          <Pressable style={s.chip} onPress={() => open(stringLetter, PITCH_CLASS_MIDI[stringLetter])}>
            <Ionicons name="musical-note" size={14} color={colors.brand[700]} />
            <Text style={s.chipText}>Tune {stringLetter} string</Text>
          </Pressable>
        )}
        {targetPitchClass && (
          <Pressable style={s.chip} onPress={() => open(targetPitchClass, targetMidi)}>
            <Ionicons name="volume-high" size={14} color={colors.brand[700]} />
            <Text style={s.chipText}>Hear the note</Text>
          </Pressable>
        )}
      </View>

      <Modal visible={panel !== null} transparent animationType="slide" onRequestClose={close}>
        {panel && (
          <TunePracticePanel
            pitchClass={panel.pitchClass}
            midiNote={panel.midi}
            isPlaying={playingNote === panel.pitchClass}
            onToggle={() => toggle(panel.pitchClass, panel.midi)}
            onClose={close}
          />
        )}
      </Modal>
    </>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', gap: spacing.sm },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.brand[50],
    borderRadius: radius.full,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  chipText: { fontSize: 13, fontWeight: '700', color: colors.brand[700] },
});
