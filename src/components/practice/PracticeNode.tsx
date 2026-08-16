import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { PracticeBlock } from '../../lib/practiceBlocks';
import { blockAccent } from '../../lib/practiceCopy';
import { PracticeGraphic } from './PracticeGraphic';
import { colors, radius, spacing } from '../../constants/theme';

export type NodeState = 'done' | 'next' | 'available';

/**
 * A single stop on the practice path. A left rail (connector + numbered
 * medallion) gives the journey feel; the card leads with a colored, drill-typed
 * graphic and a one-line title — no descriptive body copy.
 */
export function PracticeNode({
  block,
  index,
  state,
  isLast,
  onPress,
}: {
  block: PracticeBlock;
  index: number;
  state: NodeState;
  isLast: boolean;
  onPress: () => void;
}) {
  const done = state === 'done';
  const next = state === 'next';
  const accent = blockAccent(block.type);
  const requiresCamera = block.liveMode.requiresCamera;
  const needLabel = requiresCamera ? 'Camera' : block.liveMode.requiresMic ? 'Mic' : 'By ear';
  const needIcon = requiresCamera ? 'camera' : block.liveMode.requiresMic ? 'mic' : 'musical-note';
  const evaluatorId = block.evaluator?.evaluatorId;
  const gradedPerNote = evaluatorId === 'sequence' || evaluatorId === 'scale';

  return (
    <View style={s.row}>
      <View style={s.rail}>
        <View style={[s.medallion, done && s.medallionDone, next && s.medallionNext]}>
          {done ? (
            <Ionicons name="checkmark" size={16} color="#fff" />
          ) : (
            <Text style={[s.medallionNum, next && s.medallionNumNext]}>{index + 1}</Text>
          )}
        </View>
        {!isLast && <View style={[s.connector, done && s.connectorDone]} />}
      </View>

      <Pressable
        style={({ pressed }) => [s.card, next && s.cardNext, pressed && s.cardPressed]}
        onPress={onPress}
      >
        <View style={[s.tile, { backgroundColor: accent }, done && s.tileDone]}>
          <PracticeGraphic type={block.type} size={TILE} />
          {done && (
            <View style={s.tileCheck}>
              <Ionicons name="checkmark" size={14} color={accent} />
            </View>
          )}
        </View>

        <View style={s.content}>
          {next && <Text style={s.nextLabel}>Up next</Text>}
          <Text style={s.title} numberOfLines={2}>{block.title}</Text>
          {/* The reason the drill is here at all. Without it the path is a menu;
              with it, every card is an argument the player can agree or
              disagree with — which is the whole point of targeting them. */}
          {block.reason ? (
            <Text style={s.because} numberOfLines={2}>{block.reason}</Text>
          ) : null}
          <View style={s.meta}>
            <View style={s.chip}>
              <Ionicons name="time-outline" size={13} color={colors.text.muted} />
              <Text style={s.chipText}>{Math.max(3, block.estimatedMinutes)} min</Text>
            </View>
            <View style={s.chip}>
              <Ionicons name={needIcon as any} size={13} color={colors.text.muted} />
              <Text style={s.chipText}>{needLabel}</Text>
            </View>
            {gradedPerNote && (
              <View style={s.chip}>
                <Ionicons name="checkmark-circle-outline" size={13} color={colors.text.muted} />
                <Text style={s.chipText}>Graded per note</Text>
              </View>
            )}
          </View>
        </View>

        <Ionicons
          name="chevron-forward"
          size={20}
          color={next ? accent : '#cbd5e1'}
          style={s.chevron}
        />
      </Pressable>
    </View>
  );
}

const RAIL_W = 32;
const MED = 26;
const TILE = 78;

const s = StyleSheet.create({
  row: { flexDirection: 'row', gap: spacing.md },
  rail: { width: RAIL_W, alignItems: 'center' },
  medallion: {
    width: MED,
    height: MED,
    borderRadius: MED / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.brand[50],
    borderWidth: 2,
    borderColor: colors.brand[100],
  },
  medallionDone: { backgroundColor: colors.score.excellent, borderColor: colors.score.excellent },
  medallionNext: { backgroundColor: colors.brand[600], borderColor: colors.brand[600] },
  medallionNum: { fontSize: 12, fontWeight: '900', color: colors.brand[600] },
  medallionNumNext: { color: '#fff' },
  connector: {
    flex: 1,
    width: 3,
    marginTop: 4,
    borderRadius: 2,
    backgroundColor: '#e5e7eb',
    minHeight: spacing.lg,
  },
  connectorDone: { backgroundColor: colors.score.excellent },
  card: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginBottom: spacing.lg,
    backgroundColor: '#fff',
    borderRadius: radius.xl,
    padding: spacing.md - 2,
    borderWidth: 1.5,
    borderColor: '#eef2f7',
  },
  cardNext: { borderColor: colors.brand[300], backgroundColor: colors.brand[50] },
  cardPressed: { opacity: 0.85 },
  tile: {
    width: TILE,
    height: TILE,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  tileDone: { opacity: 0.55 },
  tileCheck: {
    position: 'absolute',
    top: 3,
    right: 3,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  content: { flex: 1, gap: 3 },
  nextLabel: {
    fontSize: 10,
    fontWeight: '900',
    color: colors.brand[600],
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  title: { fontSize: 16, fontWeight: '900', color: colors.text.primary, lineHeight: 20 },
  because: { fontSize: 12, lineHeight: 16, color: colors.text.secondary, marginTop: 1 },
  meta: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: 3 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  chipText: { fontSize: 12, fontWeight: '700', color: colors.text.muted },
  chevron: { marginLeft: -4 },
});
