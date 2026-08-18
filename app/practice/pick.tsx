import React, { useMemo } from 'react';
import { View, Text, StyleSheet, SafeAreaView, ScrollView, Pressable } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAnalysisStore } from '../../src/store/useAnalysisStore';
import { DepthCard } from '../../src/components/ui/DepthCard';
import { TECHNIQUE_PIECE } from '../../src/constants/pieces';
import { colors, spacing, radius } from '../../src/constants/theme';
import type { Piece } from '../../src/types/piece';

/**
 * "Pick a piece" — the single entry into practising.
 *
 * There used to be three ways to start a session (the tab bar's + button, a
 * button on Home, and "Record again" on the completion screen), all landing on
 * the same text-heavy piece-input form: a search box, a name field, an optional
 * PDF upload, a list of previous sessions, and two escape hatches. Naming your
 * piece again is not the first thing you want to do when you sit down to play.
 *
 * So the common case — playing something you have played before — is one tap on
 * a card, and everything else lives behind "New piece". One heading, no
 * explanatory copy, one action per row.
 */

interface PickablePiece {
  piece: Piece;
  sessionCount: number;
  lastPlayedAt: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function lastPlayedLabel(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const days = Math.floor((Date.now() - then) / DAY_MS);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 14) return 'last week';
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  return `${Math.round(days / 30)} months ago`;
}

export default function PickPieceScreen() {
  const sessionHistory = useAnalysisStore((st) => st.sessionHistory);
  const continueWithPiece = useAnalysisStore((st) => st.continueWithPiece);
  const reset = useAnalysisStore((st) => st.reset);

  // There is no pieces table to read: a piece exists because sessions reference
  // it. Same grouping Home and Progress already do, by piece id.
  const pieces = useMemo<PickablePiece[]>(() => {
    const byId = new Map<string, PickablePiece>();
    for (const session of sessionHistory) {
      const ref = session.piece;
      // Sessions predating the "name every take" rule have no piece and cannot
      // be resumed as one. They still count in Progress; they just aren't a
      // thing you can pick up again here.
      if (!ref?.id) continue;

      const existing = byId.get(ref.id);
      if (existing) {
        existing.sessionCount += 1;
        if (session.recordedAt.localeCompare(existing.lastPlayedAt) > 0) {
          existing.lastPlayedAt = session.recordedAt;
        }
        continue;
      }
      byId.set(ref.id, {
        piece: ref.id === TECHNIQUE_PIECE.id
          ? TECHNIQUE_PIECE
          : { id: ref.id, title: ref.title, composer: ref.composer, source: 'manual' },
        sessionCount: 1,
        lastPlayedAt: session.recordedAt,
      });
    }
    return [...byId.values()].sort((a, b) => b.lastPlayedAt.localeCompare(a.lastPlayedAt));
  }, [sessionHistory]);

  const start = (piece: Piece) => {
    // Already sets phase to 'method_select' with the piece selected, so this
    // skips the naming form entirely — the mechanism predates this screen.
    // `from` lets that screen's Back return here instead of to the naming form.
    continueWithPiece(piece);
    router.push({ pathname: '/(tabs)/analyze', params: { from: 'pick' } });
  };

  const startNew = () => {
    reset(); // back to 'piece_input'
    router.push({ pathname: '/(tabs)/analyze', params: { from: 'new' } });
  };

  return (
    <SafeAreaView style={s.safe}>
      <View style={s.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={s.back}>
          <Ionicons name="chevron-back" size={28} color={colors.text.secondary} />
        </Pressable>
        <Text style={s.title}>Pick a piece{'\n'}to practice</Text>
      </View>

      <ScrollView contentContainerStyle={s.list} showsVerticalScrollIndicator={false}>
        {/* First, not last: starting something new is a decision you have
            already made by the time you get here, and hunting for it under a
            long list of pieces is the wrong shape. */}
        <DepthCard onPress={startNew} style={[s.card, s.newCard]}>
          <View style={s.cardRow}>
            <View style={s.plusBadge}>
              <Ionicons name="add" size={24} color="#fff" />
            </View>
            <Text style={s.newLabel}>New piece</Text>
          </View>
        </DepthCard>

        {pieces.map(({ piece, sessionCount, lastPlayedAt }) => (
          <DepthCard key={piece.id} onPress={() => start(piece)} style={s.card}>
            <View style={s.cardRow}>
              <View style={s.cardText}>
                <Text style={s.cardTitle} numberOfLines={2}>{piece.title}</Text>
                <Text style={s.cardMeta}>
                  {sessionCount} {sessionCount === 1 ? 'session' : 'sessions'} · {lastPlayedLabel(lastPlayedAt)}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={22} color={colors.text.muted} />
            </View>
          </DepthCard>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  // The header is a column, not a row: a two-line title beside a back button
  // squeezes the title into a narrow ragged block.
  header: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xl,
    gap: spacing.md,
  },
  back: { alignSelf: 'flex-start', marginLeft: -spacing.xs },
  title: { fontSize: 32, fontWeight: '900', color: colors.text.primary, lineHeight: 38 },
  list: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xxl,
    gap: spacing.md,
  },
  card: { paddingVertical: spacing.lg, paddingHorizontal: spacing.lg },
  cardRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  cardText: { flex: 1, gap: spacing.xs },
  cardTitle: { fontSize: 20, fontWeight: '800', color: colors.text.primary, lineHeight: 26 },
  cardMeta: { fontSize: 13, fontWeight: '600', color: colors.text.muted },
  newCard: { backgroundColor: '#fbfcfe' },
  plusBadge: {
    width: 44,
    height: 44,
    borderRadius: radius.full,
    backgroundColor: colors.brand[600],
    alignItems: 'center',
    justifyContent: 'center',
  },
  newLabel: { fontSize: 20, fontWeight: '800', color: colors.text.primary },
});
