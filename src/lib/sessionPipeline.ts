import type { AudioAnalysisOutput, MetricScore, MeasurementQuality, SessionAssessment, PlayerCategory } from '../types/analysis';
import type { BowCalibration } from '../types/calibration';
import type { InstrumentId } from '../types/instrument';
import type { RawBowFrame, SessionSignals } from '../types/signals';
import { POSE, CONFIDENCE_THRESHOLD, scorePoseMetrics, type FrameKeypoints } from './poseScoring';
import { preparePoseFramesForScoring } from './poseFramePrep';
import { fuseSignals, detectPhrases, type NoteEvent, type Phrase } from './noteFusion';
import { buildSessionSignals } from './sessionSignals';
import { deriveBowTimeSeries, applyCalibration } from './bowAnalysis';
import { runPatternDetection, type StatisticalFinding } from './patternDetection';
import { buildSessionAssessment } from './sessionAssessment';
import { groupNotes, type NoteGroup } from './noteGrouping';
import { buildPhraseFeatures, type PhraseFeatures } from './phraseFeatures';

// ─────────────────────────────────────────────────────────────
// Session pipeline (L1–L9 orchestrator)
//
// Pure function over already-extracted signals: audio DSP output, pose frames,
// and bow frames. All layer logic lives here so the pipeline can run identically
// from processMedia, the debug screen, and node-script tests. I/O (audio
// analysis, frame extraction, network) stays in the callers.
// ─────────────────────────────────────────────────────────────

export interface SessionPipelineInput {
  audioOutput: AudioAnalysisOutput;
  /** Raw screen-space frames from convertPoseFrame — NOT normalized.
   *  fuseSignals needs screen-space coords; scoring/signals normalize internally. */
  poseFrames: FrameKeypoints[];
  bowFrames: RawBowFrame[];
  durationSeconds: number;
  instrument: InstrumentId;
  /** User's self-reported goal from onboarding; falls back to video classification. */
  userCategory?: PlayerCategory;
  /** Optional bow calibration captured in the same camera position before recording. */
  calibration?: BowCalibration | null;
}

export interface SessionPipelineOutput {
  /** L2 — per-note events fused from audio + pose (+ bow when available) */
  noteEvents: NoteEvent[];
  /** L3 — shared time-series substrate for all higher layers */
  signals: SessionSignals;
  /** L5 — slur/détaché groups (every note in exactly one group) */
  noteGroups: NoteGroup[];
  /** L6 — phrase boundaries (silence gaps + composite bow-aware score) */
  phrases: Phrase[];
  /** L7 — per-phrase musical descriptors (evidence for L9/L10) */
  phraseFeatures: PhraseFeatures[];
  /** L8 — statistical findings that fired (confidence ≥ 0.4) */
  findings: StatisticalFinding[];
  /** Pose + bow metric scores (empty when < 5 usable pose frames) */
  videoMetrics: MetricScore[];
  /** L9 — categorical session assessment */
  sessionAssessment: SessionAssessment;
}

// Minimum shoulder width in raw screen coordinates (0-1) for reliable measurement.
// Below this, the camera angle is too oblique or the player is too far away.
const MIN_SHOULDER_WIDTH_RAW = 0.15;

/**
 * Assess overall visibility quality from RAW (un-normalized) screen-space frames.
 * Returns 'low' if fewer than 40% of frames have both shoulders clearly visible.
 * Must run before preparePoseFramesForScoring — body-normalized frames always
 * have shoulderWidth ≈ 1.0, making this check meaningless after normalization.
 */
function assessFrameQuality(frames: FrameKeypoints[]): MeasurementQuality {
  if (frames.length === 0) return 'unavailable';
  let goodFrames = 0;
  for (const frame of frames) {
    const pose = frame.poseLandmarks;
    if (!pose) continue;
    const lS = pose[POSE.LEFT_SHOULDER];
    const rS = pose[POSE.RIGHT_SHOULDER];
    if (!lS || !rS) continue;
    if ((lS.visibility ?? 0) < CONFIDENCE_THRESHOLD || (rS.visibility ?? 0) < CONFIDENCE_THRESHOLD) continue;
    const shoulderWidth = Math.abs(lS.x - rS.x);
    if (shoulderWidth >= MIN_SHOULDER_WIDTH_RAW) goodFrames++;
  }
  return goodFrames / frames.length >= 0.4 ? 'high' : 'low';
}

export function runSessionPipeline(input: SessionPipelineInput): SessionPipelineOutput {
  const { audioOutput, poseFrames, bowFrames, durationSeconds, instrument, userCategory, calibration } = input;

  // ── L1: bow geometry series — computed once, shared by every layer ──
  const bowSeries = applyCalibration(deriveBowTimeSeries(bowFrames), calibration ?? null);

  // ── L2: note events (bow series enables hybrid onset splitting) ──
  const noteEvents = fuseSignals(audioOutput.rawSignals, poseFrames, { bow: bowSeries });

  // ── L3: signal substrate ──
  // Prepared (smoothed/normalized) frames so leftWristAngle matches what
  // scoreLeftHandWrist sees — raw frames would make L3 and L4 wrist disagree.
  const quality = assessFrameQuality(poseFrames);
  const prepared = preparePoseFramesForScoring(poseFrames);
  const signals = buildSessionSignals(audioOutput, prepared, bowFrames, noteEvents, durationSeconds, bowSeries);

  // ── L5: slur/détaché grouping ──
  const noteGroups = groupNotes(noteEvents, signals.bowDirection);

  // ── L6: phrase segmentation (same opts as the fuseSignals-internal pass,
  // so phrase context on events and these boundaries always agree) ──
  const phrases = detectPhrases(audioOutput.rawSignals.rmsFrames, {
    bowSpeed: bowSeries.bowSpeed,
    onsets: audioOutput.rawSignals.onsetTimestamps,
  });

  // ── L7: phrase features ──
  const phraseFeatures = buildPhraseFeatures(
    phrases, signals, noteEvents, noteGroups, audioOutput.vibratoAnalysis,
  );

  // ── L8: statistical pattern tests ──
  const findings = runPatternDetection(signals, noteEvents);

  // ── Pose + bow metric scoring ──
  let videoMetrics: MetricScore[] = [];
  if (poseFrames.length >= 5 && prepared.length >= 5) {
    videoMetrics = scorePoseMetrics(prepared, bowFrames, instrument, durationSeconds, signals, bowSeries);
    if (quality === 'low') {
      videoMetrics = videoMetrics.map((m) =>
        m.measurementQuality === 'unavailable' ? m : { ...m, measurementQuality: 'low' as MeasurementQuality },
      );
    }
  }

  // ── L9: categorical assessment (consumes L7 + L8 evidence) ──
  const sessionAssessment = buildSessionAssessment(videoMetrics, userCategory, {
    findings,
    phraseFeatures,
  });

  return { noteEvents, signals, noteGroups, phrases, phraseFeatures, findings, videoMetrics, sessionAssessment };
}
