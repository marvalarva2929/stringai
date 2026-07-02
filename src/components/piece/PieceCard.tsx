import React from 'react';
import { Pressable, View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Piece } from '../../types/piece';
import { colors, spacing, radius } from '../../constants/theme';

interface Props {
  piece: Piece;
  onSelect: (piece: Piece) => void;
}

export function PieceCard({ piece, onSelect }: Props) {
  return (
    <Pressable style={({ pressed }) => [styles.card, pressed && styles.pressed]} onPress={() => onSelect(piece)}>
      <View style={styles.iconCircle}>
        <Ionicons name="musical-note" size={22} color={colors.brand[600]} />
      </View>
      <View style={styles.info}>
        <Text style={styles.title} numberOfLines={1}>{piece.title}</Text>
        {piece.composer && <Text style={styles.composer}>{piece.composer}</Text>}
        {(piece.keySignature || piece.timeSignature) && (
          <Text style={styles.meta}>
            {[piece.keySignature, piece.timeSignature].filter(Boolean).join(' · ')}
          </Text>
        )}
      </View>
      <Text style={styles.arrow}>›</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: radius.lg,
    padding: spacing.md,
    gap: spacing.md,
    marginBottom: spacing.sm,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  pressed: { opacity: 0.75 },
  iconCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.brand[100],
    alignItems: 'center',
    justifyContent: 'center',
  },
  icon: { fontSize: 20 },
  info: { flex: 1 },
  title: { fontSize: 15, fontWeight: '600', color: colors.text.primary },
  composer: { fontSize: 13, color: colors.text.secondary, marginTop: 1 },
  meta: { fontSize: 11, color: colors.text.muted, marginTop: 2 },
  arrow: { fontSize: 20, color: colors.text.muted, fontWeight: '300' },
});
