import React, { useMemo } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { AnalysisResult } from '../../types/analysis';
import type { PracticeEvidence } from '../../lib/practiceEvidence';
import { sessionEvidenceFor } from '../../lib/practiceEvidence';
import { rankPracticeEvidence } from '../../lib/practiceRanking';
import { colors, radius, spacing } from '../../constants/theme';

// ─────────────────────────────────────────────────────────────
// Problem spots — act one of the story.
//
// Not "your intonation scored 62". A short list of *moments*, each one a place
// in the music where something specific went wrong, with the clip to prove it.
// This is the page the practice plan is an answer to, so the two have to speak
// the same language: the same issues, the same words, in the same order.
// ─────────────────────────────────────────────────────────────

/** More than this and it stops being a diagnosis and becomes a list of faults. */
const MAX_SPOTS = 4;

// This page renders inside the dark carousel (see ResultsCarousel's DARK_BG),
// not on a light surface — colors.text.* are near-black and unreadable there,
// so it needs its own light-on-dark palette matching the rest of the carousel.
const CARD_BG = 'rgba(255,255,255,0.08)';
const CARD_BORDER = 'rgba(255,255,255,0.12)';
const TEXT_PRIMARY = '#ffffff';
const TEXT_SECONDARY = 'rgba(255,255,255,0.75)';
const TEXT_MUTED = 'rgba(255,255,255,0.45)';
const ACCENT = colors.brand[400];

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Only issues that can point at a moment in the recording belong on this page. */
function isLocatable(issue: PracticeEvidence): boolean {
  return issue.target.startSeconds != null;
}

export function ProblemSpotsPage({
  result,
  /** Plays a window on the carousel's shared video player above this page. */
  onSegmentPress,
}: {
  result: AnalysisResult;
  onSegmentPress: (startSeconds: number, endSeconds: number) => void;
}) {
  const spots = useMemo(() => {
    // Not `result.sessionEvidence` directly: a session analysed before the
    // current analysis version froze findings that are now known to be wrong,
    // and a rich result can always recompute them.
    const issues = sessionEvidenceFor(result);
    return rankPracticeEvidence(issues.filter(isLocatable)).slice(0, MAX_SPOTS);
  }, [result]);

  if (spots.length === 0) {
    return (
      <ScrollView contentContainerStyle={s.emptyWrap} showsVerticalScrollIndicator={false}>
        <Ionicons name="checkmark-circle" size={44} color={colors.score.excellent} />
        <Text style={s.emptyTitle}>Nothing stood out</Text>
        <Text style={s.emptyBody}>
          No single moment in this take was clearly worse than the rest. That's a good sign —
          your practice plan will reinforce rather than repair.
        </Text>
      </ScrollView>
    );
  }

  return (
    <ScrollView contentContainerStyle={s.wrap} showsVerticalScrollIndicator={false}>
      <Text style={s.kicker}>Problem spots</Text>
      <Text style={s.title}>
        {spots.length === 1 ? 'One moment' : `${spots.length} moments`} worth going back to
      </Text>
      <Text style={s.lede}>
        {result.videoUri
          ? 'Tap one to hear what you actually played. Each of these becomes an exercise in your plan.'
          : 'Each of these becomes an exercise in your plan.'}
      </Text>

      {spots.map((spot, index) => (
        <SpotCard
          key={spot.id}
          spot={spot}
          index={index}
          canPlay={Boolean(result.videoUri)}
          onPlay={onSegmentPress}
        />
      ))}
    </ScrollView>
  );
}

function SpotCard({
  spot,
  index,
  canPlay,
  onPlay,
}: {
  spot: PracticeEvidence;
  index: number;
  canPlay: boolean;
  onPlay: (startSeconds: number, endSeconds: number) => void;
}) {
  const start = spot.target.startSeconds ?? 0;
  const end = spot.target.endSeconds ?? start + 2;
  // A moment is often a second or two; pad it so playback starts before the
  // note rather than halfway through it.
  const play = () => onPlay(Math.max(0, start - 0.75), end + 0.75);

  return (
    <Pressable style={s.card} onPress={canPlay ? play : undefined} disabled={!canPlay}>
      <View style={s.cardHead}>
        <View style={s.stamp}>
          <Text style={s.stampText}>{formatTime(start)}</Text>
        </View>
        <View style={s.headCopy}>
          <Text style={s.spotTitle}>{spot.title}</Text>
          <Text style={s.spotIndex}>Spot {index + 1}</Text>
        </View>
        {canPlay && <Ionicons name="play-circle" size={26} color={ACCENT} />}
      </View>

      <Text style={s.what}>{spot.reason}</Text>

      {/* The comparison, when the measurement supported one. This is the line
          that turns "you played some notes flat" into a diagnosis. */}
      {spot.contrast ? <Text style={s.contrast}>{spot.contrast}</Text> : null}

      <Text style={s.detail}>{spot.evidenceSummary}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  wrap: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  kicker: {
    fontSize: 12,
    fontWeight: '900',
    color: TEXT_MUTED,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  title: { fontSize: 26, fontWeight: '900', color: TEXT_PRIMARY, lineHeight: 31 },
  lede: { fontSize: 14, lineHeight: 20, color: TEXT_SECONDARY, marginBottom: spacing.xs },
  card: {
    backgroundColor: CARD_BG,
    borderRadius: radius.xl,
    padding: spacing.md,
    gap: 6,
    borderWidth: 1.5,
    borderColor: CARD_BORDER,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  stamp: {
    backgroundColor: colors.brand[50],
    borderRadius: radius.full,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  stampText: { fontSize: 13, fontWeight: '900', color: colors.brand[700] },
  headCopy: { flex: 1 },
  spotTitle: { fontSize: 16, fontWeight: '900', color: TEXT_PRIMARY },
  spotIndex: {
    fontSize: 11,
    fontWeight: '800',
    color: TEXT_MUTED,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  what: { fontSize: 14, lineHeight: 20, color: TEXT_PRIMARY },
  contrast: { fontSize: 13, lineHeight: 19, color: TEXT_SECONDARY, fontStyle: 'italic' },
  body: { gap: 8, marginTop: 4 },
  replay: { flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start' },
  replayText: { fontSize: 13, fontWeight: '800', color: ACCENT },
  noClip: { fontSize: 13, color: TEXT_MUTED },
  detail: { fontSize: 12, lineHeight: 18, color: TEXT_MUTED },
  emptyWrap: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.sm,
  },
  emptyTitle: { fontSize: 22, fontWeight: '900', color: TEXT_PRIMARY },
  emptyBody: {
    fontSize: 14,
    lineHeight: 21,
    color: TEXT_SECONDARY,
    textAlign: 'center',
  },
});
