import React, { useState, useRef, useMemo, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ScrollView,
  Dimensions,
  Modal,
  TouchableWithoutFeedback,
} from 'react-native';
import { Ionicons, FontAwesome6 } from '@expo/vector-icons';
import { Audio } from 'expo-av';
import Svg, { Path, Line } from 'react-native-svg';
import { getReferenceNoteUri, pitchClassInfo } from '../../lib/referenceNote';
import {
  LLMFeedback,
  LLMCoachingItem,
  SessionAssessment,
  IntonationAnalysis,
  MetricScore,
  MetricKey,
  FlaggedTimestamp,
  PitchClassIssue,
  VibratoAnalysis,
  VibratoNoteResult,
} from '../../types/analysis';
import { colors, spacing, radius } from '../../constants/theme';
import { haptic } from '../../lib/haptics';

// ─────────────────────────────────────────────────────────────
// Layout constants
// ─────────────────────────────────────────────────────────────

const { width: SCREEN_W } = Dimensions.get('window');
const GRAPH_RANGE = 50;
const CELL_W = Math.floor((SCREEN_W - spacing.md * 2 - 8) / 2);

function CategoryIcon({ categoryId, size = 16, color = '#6b7280' }: { categoryId: string; size?: number; color?: string }) {
  switch (categoryId) {
    case 'intonation': return <Ionicons name="musical-note" size={size} color={color} />;
    case 'vibrato':    return <Ionicons name="pulse" size={size} color={color} />;
    case 'tone':       return <Ionicons name="volume-high" size={size} color={color} />;
    case 'bow':        return <Ionicons name="musical-notes" size={size} color={color} />;
    case 'posture':    return <Ionicons name="person" size={size} color={color} />;
    case 'rhythm':     return <FontAwesome6 name="drum" size={size} color={color} />;
    default:           return <Ionicons name="ellipse" size={size} color={color} />;
  }
}

function cellColors(score: number | null): { bg: string; text: string } {
  if (score === null) return { bg: '#f3f4f6', text: '#6b7280' };
  if (score >= 80) return { bg: '#dcfce7', text: '#166534' };
  if (score >= 60) return { bg: '#fef9c3', text: '#854d0e' };
  if (score >= 40) return { bg: '#ffedd5', text: '#9a3412' };
  return { bg: '#fee2e2', text: '#991b1b' };
}

// ─────────────────────────────────────────────────────────────
// Category definitions
// ─────────────────────────────────────────────────────────────

type CategoryId = 'intonation' | 'vibrato' | 'tone' | 'bow' | 'posture' | 'rhythm';

const CATEGORIES: { id: CategoryId; label: string; keys: MetricKey[] }[] = [
  { id: 'intonation', label: 'Intonation', keys: ['pitchAccuracy', 'intonationStability'] },
  { id: 'vibrato',    label: 'Vibrato',    keys: ['vibrato'] },
  { id: 'tone',       label: 'Tone',       keys: ['toneQuality', 'dynamicControl'] },
  { id: 'bow',        label: 'Bow',        keys: ['bowSmoothness', 'bowPlacement', 'bowAngle', 'bowDistribution'] },
  { id: 'posture',    label: 'Posture',    keys: ['posture', 'leftHandWrist', 'bowArmLevel'] },
  { id: 'rhythm',     label: 'Rhythm',     keys: ['rhythmAccuracy'] },
];

// ─────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────

export interface CoachingReportProps {
  llmFeedback?: LLMFeedback;
  assessment?: SessionAssessment;
  intonationAnalysis?: IntonationAnalysis;
  vibratoAnalysis?: VibratoAnalysis;
  prevIntonationAnalysis?: IntonationAnalysis;
  videoUri?: string;
  metrics?: MetricScore[];
  durationSeconds?: number;
  onTimestampPress?: (seconds: number) => void;
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function fmtSecs(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
}

function detectTuningIssue(problemNotes: PitchClassIssue[]): string | null {
  if (problemNotes.length < 2) return null;
  const allFlat  = problemNotes.every(n => n.tendency === 'flat');
  const allSharp = problemNotes.every(n => n.tendency === 'sharp');
  if (!allFlat && !allSharp) return null;
  const devs   = problemNotes.map(n => Math.abs(n.avgDeviationCents));
  const avg    = Math.round(devs.reduce((a, b) => a + b, 0) / devs.length);
  const spread = Math.max(...devs) - Math.min(...devs);
  if (avg < 12 || spread > 28) return null;
  const dir    = allFlat ? 'flat' : 'sharp';
  const action = allFlat ? 'up' : 'down';
  return (
    `All your problem notes are consistently ~${avg}¢ ${dir} — ` +
    `this looks like an overall tuning issue rather than individual note problems. ` +
    `Try tuning your violin ${action} before your next take.`
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

    if (prev === pitchClass) return;

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

// ─────────────────────────────────────────────────────────────
// Root component
// ─────────────────────────────────────────────────────────────

export function CoachingReport({
  llmFeedback, assessment, intonationAnalysis, vibratoAnalysis, prevIntonationAnalysis,
  videoUri, metrics, onTimestampPress,
}: CoachingReportProps) {
  const [selectedCatId, setSelectedCatId] = useState<CategoryId | null>(null);
  const { playingNote, toggle, stopAll } = useTuneNote();
  const [tunePanelNote, setTunePanelNote] = useState<string | null>(null);
  const [tunePanelMidi, setTunePanelMidi] = useState<number | undefined>(undefined);

  const openTunePanel = useCallback((pitchClass: string, midi?: number) => {
    setTunePanelNote(pitchClass);
    setTunePanelMidi(midi);
    toggle(pitchClass, midi);
  }, [toggle]);

  const closeTunePanel = useCallback(() => {
    stopAll();
    setTunePanelNote(null);
    setTunePanelMidi(undefined);
  }, [stopAll]);

  const metricsMap = useMemo(() => {
    if (!metrics) return {} as Record<string, MetricScore>;
    return Object.fromEntries(metrics.map((m) => [m.key, m])) as Record<string, MetricScore>;
  }, [metrics]);

  const getCategoryScore = useCallback((keys: MetricKey[]): number | null => {
    const scores = keys
      .map(k => metricsMap[k])
      .filter(m => m && m.measurementQuality !== 'unavailable')
      .map(m => m.score);
    if (scores.length === 0) return null;
    return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  }, [metricsMap]);

  const isFoundation = assessment?.playerCategory === 'foundation';
  const tuneModal = (
    <Modal visible={tunePanelNote !== null} transparent animationType="slide" onRequestClose={closeTunePanel}>
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
  );

  // ── Detail view ────────────────────────────────────────────
  if (selectedCatId !== null) {
    const cat = CATEGORIES.find(c => c.id === selectedCatId)!;
    const catScore = getCategoryScore(cat.keys);
    const { bg, text: textColor } = cellColors(catScore);

    const catKeys: Record<string, MetricKey[]> = {
      tone: ['toneQuality', 'dynamicControl'],
      bow: ['bowSmoothness', 'bowPlacement', 'bowAngle', 'bowDistribution'],
      posture: ['posture', 'leftHandWrist', 'bowArmLevel'],
      rhythm: ['rhythmAccuracy'],
    };

    return (
      <View style={styles.container}>
        {/* Back header */}
        <Pressable style={styles.detailHeader} onPress={() => { haptic.light(); setSelectedCatId(null); }}>
          <Text style={styles.detailBack}>← {cat.label}</Text>
          {catScore !== null && (
            <View style={[styles.detailScoreBadge, { backgroundColor: bg }]}>
              <Text style={[styles.detailScoreText, { color: textColor }]}>{catScore}/100</Text>
            </View>
          )}
        </Pressable>

        <ScrollView contentContainerStyle={styles.detailContent} showsVerticalScrollIndicator={false}>
          {selectedCatId === 'intonation' && (
            <>
              <IntonationTextCard
                analysis={intonationAnalysis}
                coachingItem={llmFeedback?.items.find(i => i.metricKey === 'pitchAccuracy' || i.metricKey === 'intonationStability')}
                trendText={intonationAnalysis ? buildTrendText(intonationAnalysis, prevIntonationAnalysis) : null}
                tuningWarning={intonationAnalysis ? detectTuningIssue(intonationAnalysis.problemNotes) : null}
              />
              {intonationAnalysis?.problemNotes.slice(0, 5).map((note) => (
                <IntonationNoteCard
                  key={note.pitchClass}
                  issue={note}
                  videoUri={videoUri}
                  onTimestampPress={onTimestampPress}
                  onTune={openTunePanel}
                  isPlaying={playingNote === note.pitchClass}
                />
              ))}
            </>
          )}

          {selectedCatId === 'vibrato' && (
            <>
              <VibratoTextCard
                metric={metricsMap['vibrato']}
                analysis={vibratoAnalysis}
                coachingItem={llmFeedback?.items.find(i => i.metricKey === 'vibrato')}
              />
              {vibratoAnalysis?.notes.map((note, i) => (
                <VibratoNoteCard key={i} note={note} index={i} onTimestampPress={onTimestampPress} />
              ))}
            </>
          )}

          {selectedCatId !== 'intonation' && selectedCatId !== 'vibrato' && (() => {
            const keys = catKeys[selectedCatId] ?? [];
            const item = llmFeedback?.items.find(i => keys.includes(i.metricKey));
            const observation = keys.map(k => metricsMap[k]?.observationSummary).find(Boolean) ?? null;
            const flaggedTs = keys.flatMap(k => metricsMap[k]?.flaggedTimestamps ?? []).slice(0, 3);
            return (
              <>
                <GenericTextCard categoryId={selectedCatId} coachingItem={item} observation={observation} />
                {videoUri && onTimestampPress && flaggedTs.map((ts, i) => (
                  <TimestampCard key={i} ts={ts} onPress={() => onTimestampPress(ts.startSeconds)} />
                ))}
              </>
            );
          })()}
        </ScrollView>
        {tuneModal}
      </View>
    );
  }

  // ── Waffle view (default) ──────────────────────────────────
  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.waffleContent} showsVerticalScrollIndicator={false}>
        {/* Summary strip */}
        {llmFeedback?.overallTake && (
          <View style={styles.summaryStrip}>
            <View style={[styles.summaryTag, {
              backgroundColor: isFoundation ? '#fef3c7' : colors.brand[50],
            }]}>
              <Text style={[styles.summaryTagText, {
                color: isFoundation ? '#92400e' : colors.brand[700],
              }]}>
                {isFoundation ? 'BUILD YOUR FOUNDATION' : 'REFINE YOUR TECHNIQUE'}
              </Text>
            </View>
            <Text style={styles.summaryText}>{llmFeedback.overallTake}</Text>
          </View>
        )}

        {/* Metric waffle */}
        <View style={styles.waffle}>
          {CATEGORIES.map((cat) => {
            const score = getCategoryScore(cat.keys);
            const { bg, text: textColor } = cellColors(score);
            return (
              <Pressable
                key={cat.id}
                style={[styles.waffleCell, { backgroundColor: bg }]}
                onPress={() => { haptic.light(); setSelectedCatId(cat.id); }}
              >
                <View style={styles.waffleCellIcon}><CategoryIcon categoryId={cat.id} size={16} color="#6b7280" /></View>
                <Text style={[styles.waffleCellLabel, { color: textColor + 'bb' }]}>
                  {cat.label.toUpperCase()}
                </Text>
                <Text style={[styles.waffleCellScore, { color: textColor }]}>
                  {score !== null ? score : '—'}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
      {tuneModal}
    </View>
  );
}

// ─────────────────────────────────────────────────────────────
// Intonation cards
// ─────────────────────────────────────────────────────────────

function IntonationTextCard({ analysis, coachingItem, trendText, tuningWarning }: {
  analysis?: IntonationAnalysis;
  coachingItem?: LLMCoachingItem;
  trendText?: { text: string; color: string } | null;
  tuningWarning?: string | null;
}) {
  if (!analysis) {
    return (
      <View style={styles.cardContent}>
        <Text style={styles.cardTitle}>Intonation</Text>
        <Text style={styles.feedbackText}>No audio detected.</Text>
      </View>
    );
  }
  const pct = Math.round(analysis.inTuneRate * 100);
  const rateColor =
    pct >= 85 ? colors.score.excellent :
    pct >= 70 ? colors.score.good :
    pct >= 55 ? colors.score.needs_attention :
    colors.score.critical;
  return (
    <View style={styles.cardContent}>
      <View style={styles.cardHeader}>
        <View style={styles.catEmoji}><CategoryIcon categoryId="intonation" size={18} /></View>
        <Text style={styles.cardTitle}>Intonation</Text>
        <View style={[styles.ratePill, { backgroundColor: rateColor + '22', borderColor: rateColor + '66' }]}>
          <Text style={[styles.ratePillText, { color: rateColor }]}>{pct}% in tune</Text>
        </View>
      </View>
      <Text style={styles.feedbackText}>
        {coachingItem?.feedback ?? analysis.observationSummary}
      </Text>
      {trendText && <Text style={[styles.trendText, { color: trendText.color }]}>{trendText.text}</Text>}
      {tuningWarning && (
        <View style={styles.tuningWarning}>
          <Text style={styles.tuningWarningTitle}>⚠ Possible tuning issue</Text>
          <Text style={styles.tuningWarningBody}>{tuningWarning}</Text>
        </View>
      )}
      {analysis.outOfTuneCount === 0 && (
        <Text style={styles.allTuneText}>All detected notes were in tune!</Text>
      )}
      {analysis.problemNotes.length > 0 && (
        <Text style={styles.hintText}>Swipe → to see each problem note</Text>
      )}
    </View>
  );
}

function IntonationNoteCard({ issue, videoUri, onTimestampPress, onTune, isPlaying }: {
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
  const arrow = issue.tendency === 'flat' ? '↓' : issue.tendency === 'sharp' ? '↑' : '↕';
  const tendWord = issue.tendency === 'flat' ? 'flat' : issue.tendency === 'sharp' ? 'sharp' : 'off';
  const absAvg = Math.abs(issue.avgDeviationCents);
  const barWidth = Math.min(100, (absAvg / 50) * 100);

  return (
    <View style={styles.cardContent}>
      <View style={styles.noteCardHero}>
        <Text style={[styles.noteCardBigArrow, { color: tendColor }]}>{arrow}</Text>
        <Text style={styles.noteCardBigName}>{issue.pitchClass}</Text>
      </View>
      <Text style={[styles.noteCardTend, { color: tendColor }]}>
        {tendWord} by ~{absAvg}¢ on average
      </Text>
      <Text style={styles.noteCardStat}>
        Out of tune {issue.outOfTuneCount}× — {Math.round(issue.errorRate * 100)}% error rate
      </Text>
      <View style={styles.deviationBarBg}>
        <View style={[styles.deviationBarFill, { width: `${barWidth}%` as any, backgroundColor: tendColor }]} />
      </View>
      <View style={styles.noteCardActions}>
        {videoUri && issue.exampleTimestamps?.length && onTimestampPress && (
          <Pressable style={styles.seekBtn} onPress={() => onTimestampPress(issue.exampleTimestamps![0].startSeconds)}>
            <Text style={styles.seekBtnText}>Seek to example</Text>
          </Pressable>
        )}
        {onTune && (
          <Pressable
            style={[styles.tuneBtn, isPlaying && styles.tuneBtnActive]}
            onPress={() => onTune(issue.pitchClass, issue.representativeMidi)}
          >
            <Text style={[styles.tuneBtnText, isPlaying && styles.tuneBtnTextActive]}>
              {isPlaying ? 'Stop' : 'Tune this note'}
            </Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────
// Vibrato cards
// ─────────────────────────────────────────────────────────────

function VibratoTextCard({ metric, analysis, coachingItem }: {
  metric?: MetricScore;
  analysis?: VibratoAnalysis;
  coachingItem?: LLMCoachingItem;
}) {
  const score = analysis?.avgNoteScore ?? metric?.score ?? 0;
  const scoreColor =
    score >= 75 ? colors.score.excellent :
    score >= 50 ? colors.score.good :
    score >= 25 ? colors.score.needs_attention :
    colors.score.critical;
  return (
    <View style={styles.cardContent}>
      <View style={styles.cardHeader}>
        <View style={styles.catEmoji}><CategoryIcon categoryId="vibrato" size={18} /></View>
        <Text style={styles.cardTitle}>Vibrato</Text>
        <View style={[styles.ratePill, { backgroundColor: scoreColor + '22', borderColor: scoreColor + '66' }]}>
          <Text style={[styles.ratePillText, { color: scoreColor }]}>{score}/100</Text>
        </View>
      </View>
      <Text style={styles.feedbackText}>
        {coachingItem?.feedback ?? metric?.observationSummary ?? 'Not enough data to assess vibrato.'}
      </Text>
      {(analysis?.eligibleCount ?? 0) > 0 && (
        <Text style={styles.hintText}>Swipe → to see each note</Text>
      )}
    </View>
  );
}

// Mini graph for vibrato note cards
const GRAPH_H = 70;
const IDEAL_RATE_HZ = 5.5;
const IDEAL_DEPTH_CENTS = 25;
const PITCH_HOP_HZ = 40;

function buildPath(cents: number[], w: number, h: number): string {
  if (cents.length < 2) return '';
  const PAD = 4;
  const mh = h - PAD * 2;
  let d = '';
  cents.forEach((c, i) => {
    const x = (i / Math.max(cents.length - 1, 1)) * w;
    const clamped = Math.max(-GRAPH_RANGE, Math.min(GRAPH_RANGE, c));
    const y = PAD + mh / 2 - (clamped / GRAPH_RANGE) * (mh / 2);
    d += i === 0 ? `M${x.toFixed(1)} ${y.toFixed(1)}` : ` L${x.toFixed(1)} ${y.toFixed(1)}`;
  });
  return d;
}

function VibratoNoteCard({ note, index, onTimestampPress }: {
  note: VibratoNoteResult;
  index: number;
  onTimestampPress?: (s: number) => void;
}) {
  const scoreColor =
    note.noteScore >= 75 ? colors.score.excellent :
    note.noteScore >= 50 ? colors.score.good :
    note.noteScore >= 25 ? colors.score.needs_attention :
    colors.score.critical;
  const graphW = SCREEN_W - 64;
  const actualPath = buildPath(note.cents, graphW, GRAPH_H);
  const idealCents = Array.from({ length: note.cents.length }, (_, i) =>
    IDEAL_DEPTH_CENTS * Math.sin(2 * Math.PI * IDEAL_RATE_HZ * (i / PITCH_HOP_HZ))
  );
  const idealPath = buildPath(idealCents, graphW, GRAPH_H);
  const cy = 4 + (GRAPH_H - 8) / 2;

  return (
    <View style={styles.cardContent}>
      <View style={styles.vibratoNoteHeader}>
        <Text style={styles.vibratoNoteTime}>Note {index + 1} — {fmtSecs(note.startS)}–{fmtSecs(note.endS)}</Text>
        <View style={[styles.vibratoScoreBadge, { backgroundColor: scoreColor }]}>
          <Text style={styles.vibratoScoreText}>{note.noteScore}</Text>
        </View>
      </View>
      <View style={styles.vibratoStatsRow}>
        <Text style={styles.vibratoStat}>{note.rateHz} Hz</Text>
        <Text style={styles.vibratoStatSep}>·</Text>
        <Text style={styles.vibratoStat}>±{note.depthCents}¢</Text>
        <Text style={styles.vibratoStatSep}>·</Text>
        <Text style={styles.vibratoStat}>AC {note.periodicityScore.toFixed(2)}</Text>
      </View>
      {note.cents.length > 1 && (
        <View style={styles.vibratoGraph}>
          <Svg width={graphW} height={GRAPH_H}>
            <Line x1={0} y1={cy} x2={graphW} y2={cy} stroke="rgba(0,0,0,0.12)" strokeWidth={1} />
            {idealPath ? <Path d={idealPath} stroke="rgba(250,180,50,0.4)" strokeWidth={1.5} fill="none" strokeDasharray="5,4" /> : null}
            {actualPath ? <Path d={actualPath} stroke={scoreColor} strokeWidth={2} fill="none" strokeLinejoin="round" strokeLinecap="round" /> : null}
          </Svg>
        </View>
      )}
      {note.feedbackNotes.length > 0 && (
        <View style={styles.feedbackTags}>
          {note.feedbackNotes.map((fb, i) => (
            <View key={i} style={styles.feedbackTag}>
              <Text style={styles.feedbackTagText}>{fb}</Text>
            </View>
          ))}
        </View>
      )}
      {onTimestampPress && (
        <Pressable style={styles.seekBtn} onPress={() => onTimestampPress(note.startS)}>
          <Text style={styles.seekBtnText}>Seek to note</Text>
        </Pressable>
      )}
    </View>
  );
}

// ─────────────────────────────────────────────────────────────
// Generic category cards
// ─────────────────────────────────────────────────────────────

const CAT_META: Record<string, { label: string }> = {
  tone:    { label: 'Tone & Dynamics' },
  bow:     { label: 'Bow Technique' },
  posture: { label: 'Posture' },
  rhythm:  { label: 'Rhythm' },
};

function GenericTextCard({ categoryId, coachingItem, observation }: {
  categoryId: string;
  coachingItem?: LLMCoachingItem;
  observation?: string | null;
}) {
  const meta = CAT_META[categoryId] ?? { label: categoryId };
  return (
    <View style={styles.cardContent}>
      <View style={styles.cardHeader}>
        <View style={styles.catEmoji}><CategoryIcon categoryId={categoryId} size={18} /></View>
        <Text style={styles.cardTitle}>{meta.label}</Text>
      </View>
      {coachingItem && <Text style={styles.feedbackText}>{coachingItem.feedback}</Text>}
      {observation && <Text style={styles.observationText}>{observation}</Text>}
      {coachingItem?.exercise && (
        <View style={styles.exerciseBody}>
          <Text style={styles.exerciseLabel}>SUGGESTED EXERCISE</Text>
          <Text style={styles.exerciseText}>{coachingItem.exercise}</Text>
        </View>
      )}
    </View>
  );
}

function TimestampCard({ ts, onPress }: { ts: FlaggedTimestamp; onPress: () => void }) {
  return (
    <View style={styles.cardContent}>
      <View style={styles.timestampCardInner}>
        <Text style={styles.timestampTime}>{fmtSecs(ts.startSeconds)}–{fmtSecs(ts.endSeconds)}</Text>
        {ts.note && <Text style={styles.timestampNote}>{ts.note}</Text>}
        <Pressable style={styles.seekBtnLarge} onPress={onPress}>
          <Text style={styles.seekBtnLargeText}>▶ Watch this moment</Text>
        </Pressable>
      </View>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },

  // Waffle view
  waffleContent: { paddingBottom: 8 },
  summaryStrip: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
    gap: spacing.xs,
  },
  summaryTag: {
    alignSelf: 'flex-start',
    borderRadius: radius.sm,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginBottom: 2,
  },
  summaryTagText: { fontSize: 9, fontWeight: '800', letterSpacing: 0.8 },
  summaryText: { fontSize: 13, color: colors.text.secondary, lineHeight: 19 },

  waffle: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  waffleCell: {
    width: CELL_W,
    height: 88,
    borderRadius: radius.sm,
    padding: 12,
    justifyContent: 'space-between',
  },
  waffleCellIcon: { alignItems: 'center', justifyContent: 'center' },
  waffleCellLabel: { fontSize: 10, fontWeight: '700', letterSpacing: 0.5 },
  waffleCellScore: { fontSize: 28, fontWeight: '800', alignSelf: 'flex-end', lineHeight: 32 },

  // Detail view
  detailHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e5e7eb',
    backgroundColor: '#fff',
  },
  detailBack: { fontSize: 14, fontWeight: '700', color: colors.brand[600] },
  detailScoreBadge: {
    borderRadius: radius.sm,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  detailScoreText: { fontSize: 12, fontWeight: '800' },
  detailContent: { padding: spacing.md, gap: spacing.md, paddingBottom: 24 },

  // Card inner
  cardContent: { padding: spacing.md, gap: spacing.sm },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  catEmoji: { alignItems: 'center', justifyContent: 'center' },
  cardTitle: { fontSize: 16, fontWeight: '700', color: colors.text.primary, flex: 1 },

  // Text
  feedbackText: { fontSize: 14, color: colors.text.secondary, lineHeight: 21 },
  observationText: { fontSize: 13, color: colors.text.muted, lineHeight: 19, fontStyle: 'italic' },
  trendText: { fontSize: 12, fontWeight: '600' },
  hintText: { fontSize: 11, color: colors.text.muted, fontStyle: 'italic', marginTop: 4 },

  // Pills
  ratePill: { borderRadius: radius.full, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 3 },
  ratePillText: { fontSize: 11, fontWeight: '700' },

  // Intonation text card
  allTuneText: { fontSize: 13, color: '#166534', backgroundColor: '#f0fdf4', borderRadius: radius.sm, padding: spacing.sm },
  tuningWarning: { backgroundColor: '#fefce8', borderRadius: radius.sm, borderWidth: 1, borderColor: '#fde047', padding: spacing.sm, gap: 3 },
  tuningWarningTitle: { fontSize: 12, fontWeight: '700', color: '#92400e' },
  tuningWarningBody: { fontSize: 12, color: '#78350f', lineHeight: 17 },

  // Intonation note card
  noteCardHero: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.md },
  noteCardBigArrow: { fontSize: 48, fontWeight: '800', lineHeight: 56 },
  noteCardBigName: { fontSize: 52, fontWeight: '800', color: colors.text.primary, lineHeight: 60 },
  noteCardTend: { fontSize: 16, fontWeight: '600' },
  noteCardStat: { fontSize: 13, color: colors.text.secondary },
  deviationBarBg: { height: 6, backgroundColor: '#f3f4f6', borderRadius: 3, marginTop: 4 },
  deviationBarFill: { height: 6, borderRadius: 3 },
  noteCardActions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },

  // Vibrato cards
  vibratoNoteHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  vibratoNoteTime: { fontSize: 13, fontWeight: '600', color: colors.text.secondary },
  vibratoScoreBadge: { borderRadius: radius.full, paddingHorizontal: 10, paddingVertical: 3, minWidth: 36, alignItems: 'center' },
  vibratoScoreText: { fontSize: 13, fontWeight: '800', color: '#fff' },
  vibratoStatsRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  vibratoStat: { fontSize: 12, color: colors.text.muted },
  vibratoStatSep: { fontSize: 12, color: colors.text.muted + '60' },
  vibratoGraph: { borderRadius: radius.sm, overflow: 'hidden', backgroundColor: '#f9fafb' },
  feedbackTags: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  feedbackTag: { backgroundColor: '#fef3c7', borderRadius: radius.sm, paddingHorizontal: 8, paddingVertical: 4 },
  feedbackTagText: { fontSize: 11, color: '#92400e' },

  // Generic card
  exerciseBody: { backgroundColor: '#f9fafb', borderRadius: radius.sm, padding: spacing.sm, gap: 4, borderWidth: 1, borderColor: '#e5e7eb' },
  exerciseLabel: { fontSize: 9, fontWeight: '800', color: colors.text.muted, letterSpacing: 0.8 },
  exerciseText: { fontSize: 12, color: colors.text.secondary, lineHeight: 18 },

  // Timestamp card
  timestampCardInner: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.lg },
  timestampTime: { fontSize: 32, fontWeight: '800', color: colors.text.primary },
  timestampNote: { fontSize: 16, color: colors.text.secondary },

  // Buttons
  seekBtn: {
    backgroundColor: colors.brand[600], borderRadius: radius.sm,
    paddingHorizontal: 14, paddingVertical: 8, alignSelf: 'flex-start',
  },
  seekBtnText: { fontSize: 13, fontWeight: '600', color: '#fff' },
  seekBtnLarge: {
    backgroundColor: colors.brand[600], borderRadius: radius.md,
    paddingHorizontal: 32, paddingVertical: 14, alignSelf: 'center',
  },
  seekBtnLargeText: { fontSize: 15, fontWeight: '700', color: '#fff' },
  tuneBtn: {
    backgroundColor: 'transparent', borderRadius: radius.sm,
    paddingHorizontal: 14, paddingVertical: 8, alignSelf: 'flex-start',
    borderWidth: 1, borderColor: colors.brand[300],
  },
  tuneBtnActive: { backgroundColor: '#fee2e2', borderColor: colors.score.critical },
  tuneBtnText: { fontSize: 13, fontWeight: '600', color: colors.brand[600] },
  tuneBtnTextActive: { color: colors.score.critical },
});
