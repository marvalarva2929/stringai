import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { PracticeBlock } from '../../lib/practiceBlocks';
import { targetLine } from '../../lib/practiceCopy';
import { sequenceStepsFor } from '../../lib/sequenceSteps';
import { useAnalysisStore } from '../../store/useAnalysisStore';
import { InlineVideoPlayer } from '../analysis/InlineVideoPlayer';
import { colors, radius, spacing } from '../../constants/theme';

// ─────────────────────────────────────────────────────────────
// The case for the exercise.
//
// A targeted drill only feels targeted if the player can see the thing it is
// targeting. This shows, in order: what you played, what was wrong with it,
// how that compared with the rest of the take, and how this drill is that same
// problem with everything else stripped away.
//
// The clip is the part that does the convincing. Everything else is words.
// ─────────────────────────────────────────────────────────────

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function EvidencePanel({ block }: { block: PracticeBlock }) {
  const ref = block.evidenceRefs[0];
  const sessionCache = useAnalysisStore((st) => st.sessionResultCache);
  const [seekVersion, setSeekVersion] = useState(0);

  // The recording lives in an in-memory cache, so after a relaunch the clip is
  // simply gone. That's a missing nicety, not a broken screen — the rest of the
  // panel still makes the case.
  const source = ref?.sourceSessionId ? sessionCache?.[ref.sourceSessionId] : undefined;
  const clip = useMemo(() => {
    if (!source?.videoUri || ref?.startSeconds == null) return null;
    // A moment is often a second or two; pad it so there is musical context
    // either side rather than a fragment that starts mid-note.
    const start = Math.max(0, ref.startSeconds - 0.75);
    const end = (ref.endSeconds ?? ref.startSeconds + 2) + 0.75;
    return { uri: source.videoUri, start, end, durationSeconds: source.durationSeconds };
  }, [source, ref?.startSeconds, ref?.endSeconds]);

  const steps = sequenceStepsFor(block.evaluator);

  return (
    <View style={s.panel}>
      <Text style={s.eyebrow}>Why this drill</Text>

      {/* 1 — what you played */}
      {clip && (
        <View style={s.clipWrap}>
          <InlineVideoPlayer
            uri={clip.uri}
            seekVersion={seekVersion}
            seekSeconds={clip.start}
            seekEndSeconds={clip.end}
            durationSeconds={clip.durationSeconds}
            active
          />
          <Pressable style={s.replay} onPress={() => setSeekVersion((v) => v + 1)}>
            <Ionicons name="play-circle" size={16} color={colors.brand[700]} />
            <Text style={s.replayText}>
              Replay {ref?.startSeconds != null ? formatTime(ref.startSeconds) : 'the moment'}
            </Text>
          </Pressable>
        </View>
      )}

      {/* 2 — what went wrong */}
      <Text style={s.finding}>{block.reason}</Text>

      {/* 3 — how it compared with everything else. Present only when the
          measurement actually supported the comparison. */}
      {ref?.reason ? <Text style={s.detail}>{ref.reason}</Text> : null}

      {/* 4 — the bridge from the finding to this drill */}
      {block.bridge ? (
        <View style={s.bridge}>
          <Ionicons name="arrow-forward-circle" size={16} color={colors.brand[700]} style={s.bridgeIcon} />
          <Text style={s.bridgeText}>{block.bridge}</Text>
        </View>
      ) : null}

      {/* 5 — what you'll actually be asked to do */}
      <View style={s.rows}>
        <Row label="Target" value={targetLine(block)} />
        {steps.length > 0 && (
          <Row label="You'll play" value={`${steps.length} notes · ${steps.map((step) => step.note).join('  ')}`} />
        )}
        <Row label="Pass condition" value={block.successCriteria.summary} />
      </View>
    </View>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={s.row}>
      <Text style={s.rowLabel}>{label}</Text>
      <Text style={s.rowValue}>{value}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  panel: {
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    padding: spacing.md,
    gap: spacing.sm,
    borderWidth: 1.5,
    borderColor: '#eef2f7',
  },
  eyebrow: {
    fontSize: 11,
    fontWeight: '900',
    color: colors.text.muted,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  clipWrap: { gap: 6 },
  replay: { flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start' },
  replayText: { fontSize: 13, fontWeight: '800', color: colors.brand[700] },
  finding: { fontSize: 15, lineHeight: 21, fontWeight: '700', color: colors.text.primary },
  detail: { fontSize: 13, lineHeight: 19, color: colors.text.secondary, fontStyle: 'italic' },
  bridge: {
    flexDirection: 'row',
    gap: spacing.sm,
    backgroundColor: colors.brand[50],
    borderRadius: radius.lg,
    padding: spacing.sm + 2,
  },
  bridgeIcon: { marginTop: 1 },
  bridgeText: { flex: 1, fontSize: 13, lineHeight: 19, color: colors.brand[900], fontWeight: '600' },
  rows: { gap: 6, marginTop: 2 },
  row: { gap: 1 },
  rowLabel: {
    fontSize: 11,
    fontWeight: '800',
    color: colors.text.muted,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  rowValue: { fontSize: 13, lineHeight: 19, color: colors.text.primary },
});
