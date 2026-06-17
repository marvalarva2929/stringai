import React, { useState, useRef, useMemo, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ScrollView,
  FlatList,
  LayoutAnimation,
  Dimensions,
  Modal,
  TouchableWithoutFeedback,
} from 'react-native';
import { Audio } from 'expo-av';
import { getReferenceNoteUri, pitchClassInfo } from '../../lib/referenceNote';
import {
  LLMFeedback,
  LLMCoachingItem,
  SessionAssessment,
  IntonationAnalysis,
  MetricScore,
  FlaggedTimestamp,
  PitchClassIssue,
} from '../../types/analysis';
import { colors, spacing, radius } from '../../constants/theme';
import { METRIC_META } from '../../constants/metricMeta';
import { AnalysisTimeline } from './AnalysisTimeline';

const { width: SCREEN_W } = Dimensions.get('window');
const CARD_GAP = 10;
const CARD_W = Math.round(SCREEN_W * 0.83);
// Equal inset on both sides so each card snaps to the horizontal center of the screen
const SIDE_PAD = Math.round((SCREEN_W - CARD_W) / 2);
const SNAP = CARD_W + CARD_GAP;

export interface CoachingReportProps {
  llmFeedback: LLMFeedback;
  assessment?: SessionAssessment;
  intonationAnalysis?: IntonationAnalysis;
  prevIntonationAnalysis?: IntonationAnalysis;
  videoUri?: string;
  metrics?: MetricScore[];
  durationSeconds?: number;
  onTimestampPress?: (seconds: number) => void;
  /** Called whenever the active card's vertical scroll position changes. atTop/atBottom
   *  let the parent decide whether to steal vertical gestures for the drawer. */
  onCardScrollPosition?: (atTop: boolean, atBottom: boolean) => void;
  /** When false, card ScrollViews cannot scroll — used so upward swipes expand the drawer
   *  instead of scrolling card content when the drawer is at its minimum height. */
  cardScrollEnabled?: boolean;
}

function fmtSecs(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
}

// ─────────────────────────────────────────────────────────────
// Hook: play / stop a single reference pitch
// ─────────────────────────────────────────────────────────────

function useTuneNote() {
  const [playingNote, setPlayingNote] = useState<string | null>(null);
  const playingRef = useRef<string | null>(null);
  const soundRef  = useRef<Audio.Sound | null>(null);

  useEffect(() => {
    return () => { soundRef.current?.unloadAsync().catch(() => {}); };
  }, []);

  const stopAll = useCallback(async () => {
    const sound = soundRef.current;
    soundRef.current = null;
    playingRef.current = null;
    setPlayingNote(null);
    if (sound) {
      await sound.stopAsync().catch(() => {});
      await sound.unloadAsync().catch(() => {});
    }
  }, []);

  // useCallback with [] — all deps are stable refs / stable state setters
  const toggle = useCallback(async (pitchClass: string, midi?: number) => {
    const prev = playingRef.current;
    const prevSound = soundRef.current;
    soundRef.current = null;
    playingRef.current = null;
    setPlayingNote(null);

    if (prevSound) {
      await prevSound.stopAsync().catch(() => {});
      await prevSound.unloadAsync().catch(() => {});
    }

    if (prev === pitchClass) return; // tap same note → stop only

    playingRef.current = pitchClass;
    setPlayingNote(pitchClass);
    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
        shouldDuckAndroid: false,
      });
      const uri = await getReferenceNoteUri(pitchClass, midi);
      const { sound } = await Audio.Sound.createAsync(
        { uri },
        { shouldPlay: true, volume: 1.0 },
      );
      soundRef.current = sound;
      sound.setOnPlaybackStatusUpdate((st) => {
        if (st.isLoaded && st.didJustFinish) {
          if (playingRef.current === pitchClass) {
            playingRef.current = null;
            setPlayingNote(null);
          }
          sound.unloadAsync().catch(() => {});
          if (soundRef.current === sound) soundRef.current = null;
        }
      });
    } catch (e) {
      console.error('[TuneNote] playback error:', e);
      playingRef.current = null;
      setPlayingNote(null);
    }
  }, []);

  return { playingNote, toggle, stopAll };
}

// ─────────────────────────────────────────────────────────────
// Tune-practice mini panel (Modal slide-up)
// ─────────────────────────────────────────────────────────────

const PANEL_H = Math.round(Dimensions.get('window').height * 0.42);

function TunePracticePanel({
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
      <View style={panelStyles.backdrop}>
        <TouchableWithoutFeedback>
          <View style={panelStyles.sheet}>
            <View style={panelStyles.pill} />

            <Text style={panelStyles.noteName}>{pitchClass}</Text>
            <Text style={panelStyles.noteDesc}>{description}</Text>
            <Text style={panelStyles.noteFreq}>{freq} Hz</Text>

            <Text style={panelStyles.instruction}>
              Play this note on your violin and adjust until the pitches match.
            </Text>

            <Pressable
              style={[panelStyles.playBtn, isPlaying && panelStyles.playBtnActive]}
              onPress={onToggle}
            >
              {isPlaying ? (
                <View style={panelStyles.pauseIcon}>
                  <View style={panelStyles.pauseBar} />
                  <View style={panelStyles.pauseBar} />
                </View>
              ) : (
                <Text style={panelStyles.playBtnIcon}>▶</Text>
              )}
              <Text style={[panelStyles.playBtnText, isPlaying && panelStyles.playBtnTextActive]}>
                {isPlaying ? 'Stop' : 'Play note'}
              </Text>
            </Pressable>

            <Pressable onPress={onClose} style={panelStyles.doneBtn}>
              <Text style={panelStyles.doneBtnText}>Done</Text>
            </Pressable>
          </View>
        </TouchableWithoutFeedback>
      </View>
    </TouchableWithoutFeedback>
  );
}

const panelStyles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
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
  pill: {
    width: 36, height: 4, borderRadius: 2,
    backgroundColor: '#d1d5db',
    marginTop: 10, marginBottom: 4,
  },
  noteName: {
    fontSize: 52, fontWeight: '800',
    color: colors.brand[700],
    lineHeight: 60,
  },
  noteDesc: {
    fontSize: 14, color: colors.text.secondary, fontWeight: '500',
    textAlign: 'center',
  },
  noteFreq: {
    fontSize: 13, color: colors.text.muted,
    textAlign: 'center',
  },
  instruction: {
    fontSize: 13, color: colors.text.secondary,
    textAlign: 'center', lineHeight: 19,
    paddingHorizontal: spacing.md,
  },
  playBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: colors.brand[600],
    borderRadius: radius.full,
    paddingHorizontal: 28, paddingVertical: 14,
    marginTop: spacing.xs,
  },
  playBtnActive: { backgroundColor: colors.score.critical },
  playBtnIcon: { fontSize: 18, color: '#fff' },
  pauseIcon: { flexDirection: 'row', gap: 4, alignItems: 'center' },
  pauseBar: { width: 4, height: 17, backgroundColor: '#fff', borderRadius: 1.5 },
  playBtnText: { fontSize: 16, fontWeight: '700', color: '#fff' },
  playBtnTextActive: {},
  doneBtn: { marginTop: 4 },
  doneBtnText: { fontSize: 14, color: colors.text.muted, fontWeight: '500' },
});

// ─────────────────────────────────────────────────────────────
// Tuning-issue detector
// ─────────────────────────────────────────────────────────────

function detectTuningIssue(problemNotes: PitchClassIssue[]): string | null {
  if (problemNotes.length < 2) return null;
  const allFlat  = problemNotes.every(n => n.tendency === 'flat');
  const allSharp = problemNotes.every(n => n.tendency === 'sharp');
  if (!allFlat && !allSharp) return null;
  const devs   = problemNotes.map(n => Math.abs(n.avgDeviationCents));
  const avg    = Math.round(devs.reduce((a, b) => a + b, 0) / devs.length);
  const spread = Math.max(...devs) - Math.min(...devs);
  if (avg < 12 || spread > 28) return null; // not consistently off
  const dir    = allFlat ? 'flat' : 'sharp';
  const action = allFlat ? 'up' : 'down';
  return (
    `All your problem notes are consistently ~${avg}¢ ${dir} — ` +
    `this looks like an overall tuning issue rather than individual note problems. ` +
    `Try tuning your violin ${action} before your next take.`
  );
}

// ─────────────────────────────────────────────────────────────
// Root carousel
// ─────────────────────────────────────────────────────────────

interface CardDef {
  id: string;
  render: () => React.ReactElement;
}

export function CoachingReport({
  llmFeedback,
  assessment,
  intonationAnalysis,
  prevIntonationAnalysis,
  videoUri,
  metrics,
  durationSeconds,
  onTimestampPress,
  onCardScrollPosition,
  cardScrollEnabled = true,
}: CoachingReportProps) {
  const [currentIdx, setCurrentIdx] = useState(0);
  const listRef = useRef<FlatList>(null);

  // Tune-practice panel state (lifted here so the Modal can overlay the screen)
  const { playingNote, toggle, stopAll } = useTuneNote();
  const [tunePanelNote, setTunePanelNote] = useState<string | null>(null);
  const [tunePanelMidi, setTunePanelMidi] = useState<number | undefined>(undefined);

  const openTunePanel = useCallback((pitchClass: string, midi?: number) => {
    setTunePanelNote(pitchClass);
    setTunePanelMidi(midi);
    toggle(pitchClass, midi); // auto-play immediately
  }, [toggle]);

  const closeTunePanel = useCallback(() => {
    stopAll();
    setTunePanelNote(null);
    setTunePanelMidi(undefined);
  }, [stopAll]);

  // Reset scroll-position tracking whenever the active card changes
  useEffect(() => {
    onCardScrollPosition?.(true, false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIdx]);

  // Stable callbacks required by FlatList — must not be recreated on each render
  const onViewableItemsChanged = useRef(
    ({ viewableItems }: { viewableItems: Array<{ index: number | null }> }) => {
      if (viewableItems.length > 0 && viewableItems[0].index !== null) {
        setCurrentIdx(viewableItems[0].index);
      }
    }
  ).current;
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 50 }).current;
  const isFoundation = assessment?.playerCategory === 'foundation';
  const accentColor = isFoundation ? colors.score.needs_attention : colors.brand[600];

  const metricsMap = useMemo(() => {
    if (!metrics) return {} as Record<string, MetricScore>;
    return Object.fromEntries(metrics.map((m) => [m.key, m])) as Record<string, MetricScore>;
  }, [metrics]);

  const intonationItem = llmFeedback.items.find(
    (i) => i.metricKey === 'pitchAccuracy' || i.metricKey === 'intonationStability',
  );
  const techniqueItems = llmFeedback.items.filter(
    (i) => i.metricKey !== 'pitchAccuracy' && i.metricKey !== 'intonationStability',
  );

  const cards: CardDef[] = useMemo(() => {
    const result: CardDef[] = [];

    // Summary card (always first)
    result.push({
      id: 'summary',
      render: () => (
        <SummaryCard
          take={llmFeedback.overallTake}
          isFoundation={isFoundation}
          accentColor={accentColor}
          metrics={metrics ?? []}
          durationSeconds={durationSeconds ?? 0}
          onSegmentPress={onTimestampPress}
          videoUri={videoUri}
        />
      ),
    });

    // One card per technique coaching item
    for (const item of techniqueItems) {
      result.push({
        id: `item-${item.metricKey}`,
        render: () => (
          <TechniqueItemCard
            item={item}
            isFoundation={isFoundation}
            accentColor={accentColor}
            flaggedTimestamps={metricsMap[item.metricKey]?.flaggedTimestamps}
            videoUri={videoUri}
            onTimestampPress={onTimestampPress}
          />
        ),
      });
    }

    // Intonation card (always last)
    result.push({
      id: 'intonation',
      render: () => (
        <IntonationCard
          analysis={intonationAnalysis}
          prev={prevIntonationAnalysis}
          coachingItem={intonationItem}
          videoUri={videoUri}
          onTimestampPress={onTimestampPress}
          onTune={openTunePanel}
          playingNote={playingNote}
        />
      ),
    });

    return result;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [llmFeedback, metrics, videoUri, onTimestampPress, durationSeconds, intonationAnalysis, prevIntonationAnalysis, openTunePanel, playingNote]);

  const goTo = (idx: number) => {
    listRef.current?.scrollToIndex({ index: idx, animated: true });
    setCurrentIdx(idx);
  };

  return (
    <View style={styles.container}>
      <FlatList
        ref={listRef}
        data={cards}
        keyExtractor={(item) => item.id}
        horizontal
        showsHorizontalScrollIndicator={false}
        snapToInterval={SNAP}
        snapToAlignment="start"
        decelerationRate="fast"
        scrollEnabled={cardScrollEnabled}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={viewabilityConfig}
        scrollEventThrottle={16}
        contentContainerStyle={styles.listContent}
        ItemSeparatorComponent={() => <View style={{ width: CARD_GAP }} />}
        renderItem={({ item }) => (
          <View style={styles.cardOuter}>
            <ScrollView
              style={styles.cardScroll}
              contentContainerStyle={styles.cardScrollContent}
              showsVerticalScrollIndicator={false}
              nestedScrollEnabled
              scrollEnabled={cardScrollEnabled}
              scrollEventThrottle={32}
              onScroll={(e) => {
                if (!onCardScrollPosition) return;
                const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
                onCardScrollPosition(
                  contentOffset.y <= 2,
                  contentOffset.y >= contentSize.height - layoutMeasurement.height - 2,
                );
              }}
            >
              {item.render()}
            </ScrollView>
          </View>
        )}
        style={styles.list}
        // Edge tap overlay handled below
      />

      {/* Left edge tap */}
      {currentIdx > 0 && (
        <Pressable style={[styles.edgeTap, { left: 0 }]} onPress={() => goTo(currentIdx - 1)}>
          <Text style={styles.edgeArrow}>‹</Text>
        </Pressable>
      )}
      {/* Right edge tap */}
      {currentIdx < cards.length - 1 && (
        <Pressable style={[styles.edgeTap, { right: 0 }]} onPress={() => goTo(currentIdx + 1)}>
          <Text style={styles.edgeArrow}>›</Text>
        </Pressable>
      )}

      {/* Page dots */}
      <View style={styles.dots}>
        {cards.map((_, i) => (
          <Pressable key={i} onPress={() => goTo(i)}>
            <View style={[
              styles.dot,
              i === currentIdx
                ? { backgroundColor: accentColor, width: 14 }
                : { backgroundColor: colors.text.muted + '44', width: 6 },
            ]} />
          </Pressable>
        ))}
      </View>

      {/* Tune-practice mini panel */}
      <Modal
        visible={tunePanelNote !== null}
        transparent
        animationType="slide"
        onRequestClose={closeTunePanel}
      >
        {tunePanelNote !== null && (
          <TunePracticePanel
            pitchClass={tunePanelNote}
            midiNote={tunePanelMidi}
            isPlaying={playingNote === tunePanelNote}
            onToggle={() => toggle(tunePanelNote, tunePanelMidi)}
            onClose={closeTunePanel}
          />
        )}
      </Modal>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────
// Summary card
// ─────────────────────────────────────────────────────────────

function SummaryCard({
  take, isFoundation, accentColor, metrics, durationSeconds, onSegmentPress, videoUri,
}: {
  take: string;
  isFoundation: boolean;
  accentColor: string;
  metrics: MetricScore[];
  durationSeconds: number;
  onSegmentPress?: (s: number) => void;
  videoUri?: string;
}) {
  return (
    <View style={styles.cardContent}>
      <View style={styles.cardHeader}>
        <Text style={[styles.cardTag, { color: accentColor }]}>
          {isFoundation ? 'BUILD YOUR FOUNDATION' : 'REFINE YOUR TECHNIQUE'}
        </Text>
      </View>
      <Text style={styles.takeText}>{take}</Text>
      {durationSeconds > 0 && metrics.length > 0 && (
        <AnalysisTimeline
          durationSeconds={durationSeconds}
          metrics={metrics}
          videoUri={videoUri}
          onSegmentPress={onSegmentPress}
        />
      )}
    </View>
  );
}

// ─────────────────────────────────────────────────────────────
// Technique item card
// ─────────────────────────────────────────────────────────────

function TechniqueItemCard({
  item, isFoundation, accentColor, flaggedTimestamps, videoUri, onTimestampPress,
}: {
  item: LLMCoachingItem;
  isFoundation: boolean;
  accentColor: string;
  flaggedTimestamps?: FlaggedTimestamp[];
  videoUri?: string;
  onTimestampPress?: (s: number) => void;
}) {
  const [showExercise, setShowExercise] = useState(false);
  const meta = METRIC_META[item.metricKey];
  const visibleTs = flaggedTimestamps?.slice(0, 3) ?? [];
  const showChips = videoUri && visibleTs.length > 0 && !!onTimestampPress;

  return (
    <View style={styles.cardContent}>
      <View style={styles.cardHeader}>
        <Text style={styles.cardIcon}>{meta?.icon ?? '●'}</Text>
        <Text style={styles.cardTitle}>{meta?.label ?? item.metricKey}</Text>
      </View>

      <Text style={styles.observationText}>{item.observation}</Text>
      <Text style={styles.feedbackText}>{item.feedback}</Text>

      {showChips && (
        <View style={styles.chipRow}>
          {visibleTs.map((ts, i) => (
            <Pressable
              key={i}
              style={styles.chip}
              onPress={() => onTimestampPress!(ts.startSeconds)}
            >
              <Text style={styles.chipText}>▶ {fmtSecs(ts.startSeconds)}–{fmtSecs(ts.endSeconds)}</Text>
            </Pressable>
          ))}
        </View>
      )}

      {item.exercise && (
        <>
          <Pressable
            onPress={() => {
              LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
              setShowExercise((v) => !v);
            }}
            style={styles.exerciseToggle}
          >
            <Text style={[styles.exerciseToggleText, { color: accentColor }]}>
              {showExercise ? '▲ Hide exercise' : '▶ See exercise'}
            </Text>
          </Pressable>
          {showExercise && (
            <View style={[styles.exerciseBody, { backgroundColor: accentColor + '14' }]}>
              <Text style={styles.exerciseText}>{item.exercise}</Text>
            </View>
          )}
        </>
      )}
    </View>
  );
}

// ─────────────────────────────────────────────────────────────
// Intonation card
// ─────────────────────────────────────────────────────────────

function IntonationCard({
  analysis, prev, coachingItem, videoUri, onTimestampPress, onTune, playingNote,
}: {
  analysis?: IntonationAnalysis;
  prev?: IntonationAnalysis;
  coachingItem?: LLMCoachingItem;
  videoUri?: string;
  onTimestampPress?: (s: number) => void;
  onTune?: (pitchClass: string, midi?: number) => void;
  playingNote?: string | null;
}) {

  if (!analysis) {
    return (
      <View style={styles.cardContent}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardIcon}>🎵</Text>
          <Text style={styles.cardTitle}>Intonation</Text>
        </View>
        <Text style={styles.feedbackText}>No audio detected — record with microphone enabled.</Text>
      </View>
    );
  }

  const pct = Math.round(analysis.inTuneRate * 100);
  const rateColor =
    pct >= 85 ? colors.score.excellent :
    pct >= 70 ? colors.score.good :
    pct >= 55 ? colors.score.needs_attention :
    colors.score.critical;

  const trendText = buildTrendText(analysis, prev);
  const tuningWarning = detectTuningIssue(analysis.problemNotes);

  return (
    <View style={styles.cardContent}>
      <View style={styles.cardHeader}>
        <Text style={styles.cardIcon}>🎵</Text>
        <Text style={styles.cardTitle}>Intonation</Text>
        <View style={[styles.ratePill, { backgroundColor: rateColor + '20', borderColor: rateColor + '55' }]}>
          <Text style={[styles.ratePillText, { color: rateColor }]}>{pct}% in tune</Text>
        </View>
      </View>

      {coachingItem && <Text style={styles.feedbackText}>{coachingItem.feedback}</Text>}
      <Text style={styles.observationText}>{analysis.observationSummary}</Text>
      {trendText && <Text style={[styles.trendText, { color: trendText.color }]}>{trendText.text}</Text>}

      {tuningWarning && (
        <View style={styles.tuningWarning}>
          <Text style={styles.tuningWarningTitle}>⚠ Possible tuning issue</Text>
          <Text style={styles.tuningWarningText}>{tuningWarning}</Text>
        </View>
      )}

      {analysis.outOfTuneCount === 0 && (
        <View style={styles.allTuneRow}>
          <Text style={styles.allTuneText}>All detected notes were in tune.</Text>
        </View>
      )}

      {analysis.problemNotes.length > 0 && (
        <View style={styles.problemBlock}>
          <Text style={styles.subLabel}>PROBLEM NOTES</Text>
          {analysis.problemNotes.slice(0, 5).map((note) => (
            <NoteCard
              key={note.pitchClass}
              issue={note}
              videoUri={videoUri}
              onTimestampPress={onTimestampPress}
              onTune={onTune}
              isPlaying={playingNote === note.pitchClass}
            />
          ))}
        </View>
      )}
    </View>
  );
}

// ─────────────────────────────────────────────────────────────
// Individual problem-note mini card
// ─────────────────────────────────────────────────────────────

function NoteCard({
  issue, videoUri, onTimestampPress, onTune, isPlaying,
}: {
  issue: PitchClassIssue;
  videoUri?: string;
  onTimestampPress?: (s: number) => void;
  onTune?: (pitchClass: string, midi?: number) => void;
  isPlaying?: boolean;
}) {
  const tendColor =
    issue.tendency === 'flat' ? '#3b82f6' :
    issue.tendency === 'sharp' ? colors.score.needs_attention :
    colors.text.muted;
  const tendWord =
    issue.tendency === 'flat' ? 'flat' :
    issue.tendency === 'sharp' ? 'sharp' : 'off';
  const arrow = issue.tendency === 'flat' ? '↓' : issue.tendency === 'sharp' ? '↑' : '↕';
  const absAvg = Math.abs(issue.avgDeviationCents);
  const showChips = videoUri && issue.exampleTimestamps?.length && !!onTimestampPress;

  return (
    <View style={[styles.noteCard, { borderLeftColor: tendColor }]}>
      {/* Top row: arrow + note name + stats */}
      <View style={styles.noteCardTop}>
        <Text style={[styles.noteCardArrow, { color: tendColor }]}>{arrow}</Text>
        <Text style={styles.noteCardName}>{issue.pitchClass}</Text>
        <Text style={styles.noteCardDetail}>
          {issue.outOfTuneCount}× {tendWord}{absAvg > 0 ? `, avg ${absAvg}¢ off` : ''}
        </Text>
        <Text style={styles.noteCardRate}>{Math.round(issue.errorRate * 100)}%</Text>
      </View>

      {/* Bottom row: replay chips + tune link */}
      {(showChips || onTune) && (
        <View style={styles.noteCardBottom}>
          {showChips && (
            <View style={styles.noteCardChips}>
              {issue.exampleTimestamps!.map((ts, i) => (
                <Pressable
                  key={i}
                  style={styles.smallChip}
                  onPress={() => onTimestampPress!(ts.startSeconds)}
                >
                  <Text style={styles.smallChipText}>▶ {fmtSecs(ts.startSeconds)}</Text>
                </Pressable>
              ))}
            </View>
          )}
          {onTune && (
            <Pressable onPress={() => onTune(issue.pitchClass, issue.representativeMidi)} style={styles.tuneLink}>
              <Text style={[styles.tuneLinkText, isPlaying && styles.tuneLinkTextActive]}>
                {isPlaying ? '■ stop' : '♩ Tune'}
              </Text>
            </Pressable>
          )}
        </View>
      )}
    </View>
  );
}

function buildTrendText(curr: IntonationAnalysis, prev?: IntonationAnalysis): { text: string; color: string } | null {
  if (!prev || prev.outOfTuneCount === 0) return null;
  const pct = Math.round(((prev.outOfTuneCount - curr.outOfTuneCount) / prev.outOfTuneCount) * 100);
  if (pct >= 20) return { text: `↑ ${pct}% fewer out-of-tune notes than last session`, color: colors.score.excellent };
  if (pct <= -20) return { text: `↓ ${Math.abs(pct)}% more out-of-tune notes than last session`, color: colors.score.critical };
  return null;
}

// ─────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background, position: 'relative', paddingTop: 6 },

  list: { flex: 1 },
  listContent: { alignItems: 'stretch', paddingHorizontal: SIDE_PAD },

  // Physical card
  cardOuter: {
    width: CARD_W,
    flex: 1,
    alignSelf: 'stretch',
    backgroundColor: '#fff',
    borderRadius: radius.xl,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 6,
    overflow: 'hidden',
  },
  cardScroll: { flex: 1 },
  cardScrollContent: { flexGrow: 1, paddingBottom: 48 },

  // Card inner layout
  cardContent: { padding: spacing.lg, gap: spacing.sm },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, flexWrap: 'wrap' },
  cardTag: { fontSize: 9, fontWeight: '800', letterSpacing: 0.8, textTransform: 'uppercase' },
  cardIcon: { fontSize: 18 },
  cardTitle: { fontSize: 15, fontWeight: '700', color: colors.text.primary, flex: 1 },

  // Text
  takeText: { fontSize: 15, color: colors.text.primary, lineHeight: 23, fontWeight: '500' },
  observationText: { fontSize: 13, color: colors.text.secondary, lineHeight: 19, fontStyle: 'italic' },
  feedbackText: { fontSize: 13, color: colors.text.secondary, lineHeight: 19 },

  // Chips
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: 4 },
  chip: {
    backgroundColor: colors.brand[50], borderRadius: radius.full,
    borderWidth: 1, borderColor: colors.brand[200],
    paddingHorizontal: spacing.sm, paddingVertical: 4,
  },
  chipText: { fontSize: 12, fontWeight: '600', color: colors.brand[700] },

  // Exercise
  exerciseToggle: { marginTop: 2 },
  exerciseToggleText: { fontSize: 12, fontWeight: '600' },
  exerciseBody: { borderRadius: radius.sm, padding: spacing.sm, marginTop: 4 },
  exerciseText: { fontSize: 12, color: colors.text.secondary, lineHeight: 18 },

  // Intonation
  ratePill: { borderRadius: radius.full, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 3 },
  ratePillText: { fontSize: 11, fontWeight: '700' },
  trendText: { fontSize: 12, fontWeight: '600' },
  allTuneRow: { backgroundColor: '#f0fdf4', borderRadius: radius.sm, padding: spacing.sm },
  allTuneText: { fontSize: 13, color: '#166534' },
  problemBlock: { gap: 6, marginTop: spacing.xs },
  subLabel: { fontSize: 9, fontWeight: '700', color: colors.text.muted, letterSpacing: 0.8, textTransform: 'uppercase', marginBottom: 2 },

  // Mini note card
  noteCard: {
    backgroundColor: '#f8f8fc',
    borderRadius: radius.sm,
    borderLeftWidth: 3,
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 5,
  },
  noteCardTop: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  noteCardArrow: { fontSize: 13, fontWeight: '800', width: 14, textAlign: 'center' },
  noteCardName: { fontSize: 14, fontWeight: '700', color: colors.text.primary, width: 26 },
  noteCardDetail: { flex: 1, fontSize: 12, color: colors.text.secondary },
  noteCardRate: { fontSize: 11, fontWeight: '600', color: colors.text.muted },
  noteCardBottom: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  noteCardChips: { flexDirection: 'row', gap: 4, flex: 1 },

  smallChipRow: { flexDirection: 'row', gap: 4, paddingLeft: 20, marginBottom: 2 },
  smallChip: {
    backgroundColor: colors.brand[50], borderRadius: radius.full,
    borderWidth: 1, borderColor: colors.brand[200],
    paddingHorizontal: 8, paddingVertical: 2,
  },
  smallChipText: { fontSize: 11, fontWeight: '600', color: colors.brand[700] },

  // Tune link
  tuneLink: { paddingVertical: 2 },
  tuneLinkText: { fontSize: 12, fontWeight: '600', color: colors.brand[600] },
  tuneLinkTextActive: { color: colors.score.critical },

  // Tuning-issue banner
  tuningWarning: {
    backgroundColor: '#fefce8',
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: '#fde047',
    padding: spacing.sm,
    gap: 3,
  },
  tuningWarningTitle: { fontSize: 12, fontWeight: '700', color: '#92400e' },
  tuningWarningText: { fontSize: 12, color: '#78350f', lineHeight: 17 },


  // Carousel chrome
  edgeTap: {
    position: 'absolute', top: 0, bottom: 30, width: 36,
    justifyContent: 'center', alignItems: 'center', zIndex: 10,
  },
  edgeArrow: { fontSize: 26, color: colors.text.muted + '88', fontWeight: '200' },
  dots: {
    flexDirection: 'row', justifyContent: 'center', alignItems: 'center',
    gap: 6, paddingVertical: 10, backgroundColor: colors.background,
  },
  dot: { height: 6, borderRadius: 3 },
});
