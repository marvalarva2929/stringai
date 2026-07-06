import { create } from 'zustand';
import { persist, createJSONStorage, StateStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AnalysisResult, MetricScore, SessionSummary } from '../types/analysis';
import { Piece } from '../types/piece';

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
  | 'calibrating'      // legacy — no longer used
  | 'recording'
  | 'processing_audio'
  | 'processing_video'
  | 'uploading'
  | 'done'
  | 'error';

export interface MetricHistoryEntry {
  sessionId: string;
  recordedAt: string;
  scores: MetricScore[];
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
    (set) => ({
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
      addToHistory: (summary) =>
        set((state) => ({ sessionHistory: [summary, ...state.sessionHistory] })),
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
        // Reset any phase that can't be resumed (mid-recording, mid-upload, errors).
        if (state && TRANSIENT_PHASES.includes(state.phase)) {
          state.phase = state.currentResult ? 'done' : 'piece_input';
          state.error = null;
          state.recordingUri = null;
        }
      },
    }
  )
);
