import { create } from 'zustand';
import { persist, createJSONStorage, StateStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AnalysisResult, MetricScore, SessionSummary } from '../types/analysis';
import { Piece } from '../types/piece';
import { AnalyticsEvent, STREAK_MILESTONES } from '../constants/analyticsEvents';
import { track } from '../services/analytics';
import { computeStreak } from '../lib/streak';
import { minutesPracticedThisWeek } from '../lib/weeklyGoal';
import { useAuthStore } from './useAuthStore';

// Wraps AsyncStorage so full-device errors are swallowed rather than crashing.
const safeStorage: StateStorage = {
  getItem: (name) => AsyncStorage.getItem(name).catch(() => null),
  setItem: (name, value) => AsyncStorage.setItem(name, value).catch(() => {}),
  removeItem: (name) => AsyncStorage.removeItem(name).catch(() => {}),
};

// In-memory cache of full results keyed by session ID.
// Not persisted — rebuilt from currentResult + sessionHistory on load.
type SessionResultCache = Record<string, AnalysisResult>;

export type AnalysisPhase =
  | 'piece_input'        // step 1 — type the song name + optional sheet music
  | 'method_select'      // step 2 — choose record in-app or upload video
  | 'camera_tip'       // step 2b — camera position guide before live recording
  | 'calibrating'      // step 2c — bow reference capture before live recording
  | 'recording'
  | 'processing_audio'
  | 'processing_video'
  | 'uploading'
  | 'done'
  | 'error';

/**
 * Genuinely-measured figures for a session, captured at analysis time.
 *
 * MetricScore.occurrenceRate is only a real measurement for some metrics — for
 * pitchAccuracy, vibrato and dynamicControl it is computed as `1 - score/100`,
 * i.e. the internal score restated. The real note/beat counts live on
 * intonationAnalysis / rhythmAnalysis, which are in-memory only. Picking them
 * out here is what lets the Progress screen show "84% of notes in tune" without
 * inventing a unit that was never measured.
 */
export interface SessionHeadline {
  /** intonationAnalysis.inTuneRate — inTuneCount / noteEvents.length */
  inTuneRate?: number;
  /** intonationAnalysis.totalNoteEvents — sample size behind inTuneRate */
  totalNotes?: number;
  /** intonationAnalysis.tendencyCents — signed, negative = flat */
  tendencyCents?: number;
  /** intonationStabilityAnalysis.avgDriftCents */
  avgDriftCents?: number;
  /** Fraction of notes on the beat grid (rhythmAccuracy's occurrenceRate is real) */
  onGridRate?: number;
  /** rhythmAnalysis.bpmEst */
  bpmEst?: number;
  /** Fraction of session time free of tone faults (toneQuality's is real) */
  cleanToneRate?: number;
  /** vibratoAnalysis.eligibleCount — how many notes could be assessed at all */
  vibratoEligible?: number;
  /** vibratoAnalysis.avgNoteScore */
  vibratoAvgScore?: number;
}

export interface MetricHistoryEntry {
  sessionId: string;
  recordedAt: string;
  scores: MetricScore[];
  /** Frozen L9 evidence for this session. Persisted (unlike sessionResultCache)
   *  so the daily plan's window survives an app restart. Absent on entries saved
   *  before this existed — callers fall back to the score-level derivation. */
  evidence?: import('../lib/practiceEvidence').PracticeEvidence[];
  /** Which analysis version produced `evidence`. See EVIDENCE_VERSION. */
  evidenceVersion?: number;
  /** Piece this session practiced, for piece-scoped issue queries. */
  pieceId?: string;
  /** Real-unit figures for trend display. Absent on entries saved before this
   *  existed — callers fall back to the qualitative severity band. */
  headline?: SessionHeadline;
}

interface AnalysisState {
  phase: AnalysisPhase;
  selectedPiece: Piece | null;
  currentResult: AnalysisResult | null;
  sessionHistory: SessionSummary[];
  metricHistory: MetricHistoryEntry[];
  sessionResultCache: SessionResultCache;
  error: string | null;
  recordingUri: string | null;

  setPhase: (phase: AnalysisPhase) => void;
  setSelectedPiece: (piece: Piece | null) => void;
  setRecordingUri: (uri: string) => void;
  setResult: (result: AnalysisResult) => void;
  addToHistory: (summary: SessionSummary) => void;
  /** Union server-fetched summaries with local ones (dedupe by id, newest first). */
  mergeHistory: (summaries: SessionSummary[]) => void;
  addToMetricHistory: (entry: MetricHistoryEntry) => void;
  cacheSessionResult: (result: AnalysisResult) => void;
  setError: (msg: string) => void;
  reset: () => void;
  // Jump straight to recording with a pre-selected piece (e.g. "Continue Session")
  continueWithPiece: (piece: Piece | null) => void;
}

// Phases that can't be meaningfully restored — reset to a safe state on rehydration.
const TRANSIENT_PHASES: AnalysisPhase[] = [
  'camera_tip', 'calibrating', 'recording', 'processing_audio', 'processing_video', 'uploading', 'error',
];

export const useAnalysisStore = create<AnalysisState>()(
  persist(
    (set, get) => ({
      phase: 'piece_input',
      selectedPiece: null,
      currentResult: null,
      sessionHistory: [],
      metricHistory: [],
      sessionResultCache: {},
      error: null,
      recordingUri: null,

      setPhase: (phase) => set({ phase }),
      setSelectedPiece: (piece) => set({ selectedPiece: piece }),
      setRecordingUri: (uri) => set({ recordingUri: uri }),
      setResult: (result) => set({ currentResult: result, phase: 'done' }),
      // A session landing is the only thing that can move the streak or the
      // weekly total, so the habit events are emitted here rather than
      // recomputed on every render of the home screen. Reported after the write
      // rather than inside the updater, keeping the updater side-effect free.
      addToHistory: (summary) => {
        const previous = get().sessionHistory;
        const sessionHistory = [summary, ...previous];
        set({ sessionHistory });

        const before = computeStreak(previous);
        const after = computeStreak(sessionHistory);
        if (after > before) {
          track(AnalyticsEvent.STREAK_EXTENDED, { streak_days: after });
          if ((STREAK_MILESTONES as readonly number[]).includes(after)) {
            track(AnalyticsEvent.STREAK_MILESTONE, { streak_days: after });
          }
        } else if (before > 1 && after <= 1) {
          // They came back, but not in time — the gap ended the run.
          track(AnalyticsEvent.STREAK_BROKEN, { previous_streak: before });
        }

        // Only on the session that crosses the line, so the event counts
        // weeks-goal-hit rather than sessions-after-hitting-it.
        const goal = useAuthStore.getState().weeklyGoalMinutes;
        if (goal && minutesPracticedThisWeek(previous) < goal) {
          const nowMinutes = minutesPracticedThisWeek(sessionHistory);
          if (nowMinutes >= goal) {
            track(AnalyticsEvent.WEEKLY_GOAL_MET, { minutes: goal, actual: nowMinutes });
          }
        }
      },
      mergeHistory: (summaries) =>
        set((state) => {
          const byId = new Map<string, SessionSummary>();
          for (const s of [...state.sessionHistory, ...summaries]) {
            if (!byId.has(s.id)) byId.set(s.id, s);
          }
          const merged = [...byId.values()].sort(
            (a, b) => new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime(),
          );
          return { sessionHistory: merged };
        }),
      addToMetricHistory: (entry) =>
        set((state) => ({ metricHistory: [entry, ...state.metricHistory] })),
      cacheSessionResult: (result) =>
        set((state) => {
          // Keep sessionSignals only on the newest entry — the full time-series
          // substrate is large and only the active session needs it.
          const cache: SessionResultCache = {};
          for (const [id, r] of Object.entries(state.sessionResultCache)) {
            cache[id] = r.sessionSignals ? { ...r, sessionSignals: undefined } : r;
          }
          cache[result.sessionId] = result;
          return { sessionResultCache: cache };
        }),
      setError: (msg) => set({ error: msg, phase: 'error' }),
      reset: () => set({ phase: 'piece_input', selectedPiece: null, currentResult: null, error: null, recordingUri: null }),
      continueWithPiece: (piece) =>
        set({ phase: 'method_select', selectedPiece: piece, currentResult: null, error: null, recordingUri: null }),
    }),
    {
      name: 'stringai-analysis-v1',
      storage: createJSONStorage(() => safeStorage),
      // Only persist state that must survive navigation and app restarts.
      // sessionResultCache is omitted (in-memory cache, can be large).
      // recordingUri/selectedPiece/error are transient.
      partialize: (state) => ({
        phase: state.phase,
        // sessionSignals holds TimeSeries closures that JSON.stringify silently
        // drops — persisting it would rehydrate broken objects. Strip it.
        currentResult: state.currentResult?.sessionSignals
          ? { ...state.currentResult, sessionSignals: undefined }
          : state.currentResult,
        sessionHistory: state.sessionHistory,
        metricHistory: state.metricHistory,
      }),
      onRehydrateStorage: () => (state) => {
        // The activation sample analysis is not a session. It's persisted only
        // because currentResult is, so drop it before anything else reads it —
        // otherwise a user who took the "no violin" path would find a fake
        // session waiting for them on next launch. Runs first so the phase
        // reset below sees the cleared result.
        if (state?.currentResult?.isDemo) {
          state.currentResult = null;
          state.phase = 'piece_input';
        }
        // Reset any phase that can't be resumed (mid-recording, mid-upload, errors).
        if (state && TRANSIENT_PHASES.includes(state.phase)) {
          // The reset is also the only evidence that a run was interrupted — an
          // app kill mid-analysis otherwise leaves no trace anywhere. Reported
          // before the phase is overwritten.
          if (state.phase !== 'error') {
            track(AnalyticsEvent.ANALYSIS_ABANDONED, { phase: state.phase });
          }
          state.phase = state.currentResult ? 'done' : 'piece_input';
          state.error = null;
          state.recordingUri = null;
        }
      },
    }
  )
);
