/**
 * Intonation Analysis Engine
 *
 * Converts raw YIN pitch frames into note-level intonation events:
 *   PitchFrame[] → note events → grouped by pitch class → IntonationAnalysis
 *
 * Design decisions:
 * - Consecutive frames of the same pitch class are collapsed into one "note event"
 *   so that "F# was flat 5 times" means 5 distinct notes, not 5×N frames.
 * - Minimum note duration (80ms) filters out transients and passing tones.
 * - Pitch class grouping ignores octave so finger habit patterns are visible:
 *   F#4 and F#5 being flat both point to the same 2nd-finger placement problem.
 */

import { IntonationAnalysis, PitchClassIssue } from '../types/analysis';
import { INTONATION_THRESHOLDS } from '../constants/intonationSpec';

// ─────────────────────────────────────────────────────────────
// Internal types
// ─────────────────────────────────────────────────────────────

interface PitchFrame {
  frequency: number | null;
  timestamp: number;
}

interface NoteEvent {
  pitchClass: string;
  noteName: string;
  midi: number;
  startSeconds: number;
  endSeconds: number;
  avgDeviationCents: number; // signed: negative = flat, positive = sharp
  isOutOfTune: boolean;
}

// ─────────────────────────────────────────────────────────────
// Note name helpers
// ─────────────────────────────────────────────────────────────

// Violinists read sharps, not flats — use the sharp spelling throughout.
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function frequencyToNoteInfo(hz: number): {
  pitchClass: string;
  octave: number;
  noteName: string;
  midi: number;
  deviationCents: number;
} {
  // A4 = 440 Hz = MIDI 69
  const raw = 12 * Math.log2(hz / 440) + 69;
  const midi = Math.round(raw);
  const deviationCents = (raw - midi) * 100;
  const pitchClass = NOTE_NAMES[((midi % 12) + 12) % 12];
  const octave = Math.floor(midi / 12) - 1;
  return { pitchClass, octave, noteName: `${pitchClass}${octave}`, midi, deviationCents };
}

// ─────────────────────────────────────────────────────────────
// Step 1: collapse pitch frames into note events
// ─────────────────────────────────────────────────────────────

function detectNoteEvents(
  pitches: PitchFrame[],
  threshold: number,
): NoteEvent[] {
  const detected = pitches.filter((p) => p.frequency !== null);
  if (detected.length === 0) return [];

  const events: NoteEvent[] = [];
  let currentPitchClass: string | null = null;
  let currentNoteName = '';
  let currentMidi = 0;
  let currentStart = 0;
  let currentDeviations: number[] = [];

  const flush = (endSeconds: number) => {
    if (!currentPitchClass || currentDeviations.length === 0) return;
    const duration = endSeconds - currentStart;
    if (duration < INTONATION_THRESHOLDS.minNoteEventSeconds) return;

    // ── Pass 1: reject YIN outliers (octave errors, harmonic lock-ons) ──────
    // A frame > 2.5× the threshold away from the rough mean is likely a
    // mis-detection, not a real intonation deviation.
    const roughMean = currentDeviations.reduce((s, d) => s + d, 0) / currentDeviations.length;
    const outlierCutoff = threshold * 2.5;
    const filtered = currentDeviations.filter(d => Math.abs(d - roughMean) <= outlierCutoff);
    const deviations = filtered.length >= 1 ? filtered : currentDeviations;

    // ── Pass 2: trim onset frame (attack transient / finger-landing noise) ───
    // Skip the first N frames so only the settled pitch contributes to the avg.
    const trimCount = Math.min(INTONATION_THRESHOLDS.onsetTrimFrames, deviations.length - 1);
    const trimmed = deviations.slice(trimCount);

    const avg = trimmed.reduce((s, d) => s + d, 0) / trimmed.length;

    // ── Pass 3: frame-agreement check (the "double check") ──────────────────
    // Require a majority of trimmed frames to individually agree with the
    // direction of the average. A single outlier frame won't suffice.
    let isOutOfTune: boolean;

    if (Math.abs(avg) > threshold * INTONATION_THRESHOLDS.highConfidenceMultiple) {
      // Average is so far off that we trust it without counting frame agreement.
      isOutOfTune = true;
    } else if (trimmed.length < INTONATION_THRESHOLDS.minConfidenceFrames) {
      // Too few frames to run agreement check — apply a stricter magnitude bar.
      isOutOfTune = Math.abs(avg) > threshold * INTONATION_THRESHOLDS.shortNoteMultiple;
    } else {
      // Normal path: check both magnitude AND frame agreement.
      const frameThreshold = threshold * INTONATION_THRESHOLDS.frameAgreementSensitivity;
      const sign = avg >= 0 ? 1 : -1;
      const agreeing = trimmed.filter(d => d * sign > frameThreshold).length;
      const agreementRate = agreeing / trimmed.length;
      isOutOfTune =
        Math.abs(avg) > threshold &&
        agreementRate >= INTONATION_THRESHOLDS.frameAgreementRate;
    }

    events.push({
      pitchClass: currentPitchClass,
      noteName: currentNoteName,
      midi: currentMidi,
      startSeconds: currentStart,
      endSeconds,
      avgDeviationCents: avg,
      isOutOfTune,
    });
  };

  for (const frame of detected) {
    const info = frequencyToNoteInfo(frame.frequency!);

    if (info.pitchClass !== currentPitchClass) {
      flush(frame.timestamp);
      currentPitchClass = info.pitchClass;
      currentNoteName = info.noteName;
      currentMidi = info.midi;
      currentStart = frame.timestamp;
      currentDeviations = [info.deviationCents];
    } else {
      currentDeviations.push(info.deviationCents);
    }
  }

  flush(detected[detected.length - 1].timestamp);

  // ── Post-processing: remove transition artifacts ─────────────────────────
  // A very short out-of-tune event sandwiched between events of the same
  // pitch class on both sides is almost certainly a bow-change or position-
  // shift artifact, not a genuine intonation error.
  return filterTransitionArtifacts(events);
}

/**
 * Removes out-of-tune events that look like transition artifacts:
 * short notes detected mid-bow-stroke between two occurrences of the same
 * pitch class (the surrounding events don't have to be the immediate neighbor).
 */
function filterTransitionArtifacts(events: NoteEvent[]): NoteEvent[] {
  // Duration threshold below which we suspect a transition artifact (3 frames ≈ 150ms)
  const shortEventSeconds = INTONATION_THRESHOLDS.minNoteEventSeconds * 2;

  return events.filter((ev, i) => {
    if (!ev.isOutOfTune) return true;
    const duration = ev.endSeconds - ev.startSeconds;
    if (duration > shortEventSeconds) return true; // long enough to be real

    // Look at the two events on each side (not just immediate neighbors,
    // since silent gaps produce null frames that are already filtered out).
    const before = events.slice(Math.max(0, i - 2), i);
    const after  = events.slice(i + 1, i + 3);

    const pitchBefore = before.length > 0 ? before[before.length - 1].pitchClass : null;
    const pitchAfter  = after.length  > 0 ? after[0].pitchClass : null;

    // Both neighbors are the same pitch class (different from this event) → artifact
    if (
      pitchBefore !== null &&
      pitchBefore === pitchAfter &&
      pitchBefore !== ev.pitchClass
    ) {
      return false;
    }

    return true;
  });
}

// ─────────────────────────────────────────────────────────────
// Step 2: aggregate by pitch class
// ─────────────────────────────────────────────────────────────

function modeOf(values: number[]): number {
  const counts = new Map<number, number>();
  let maxCount = 0, result = values[0];
  for (const v of values) {
    const c = (counts.get(v) ?? 0) + 1;
    counts.set(v, c);
    if (c > maxCount) { maxCount = c; result = v; }
  }
  return result;
}

function aggregateByPitchClass(events: NoteEvent[]): PitchClassIssue[] {
  const map = new Map<
    string,
    {
      total: number;
      outOfTuneDeviations: number[];
      allDeviations: number[];
      outOfTuneTimestamps: { startSeconds: number; endSeconds: number }[];
      midiValues: number[];
    }
  >();

  for (const ev of events) {
    if (!map.has(ev.pitchClass)) {
      map.set(ev.pitchClass, { total: 0, outOfTuneDeviations: [], allDeviations: [], outOfTuneTimestamps: [], midiValues: [] });
    }
    const entry = map.get(ev.pitchClass)!;
    entry.total++;
    entry.allDeviations.push(ev.avgDeviationCents);
    entry.midiValues.push(ev.midi);
    if (ev.isOutOfTune) {
      entry.outOfTuneDeviations.push(ev.avgDeviationCents);
      // Correct for YIN onset lag: the player pressed the note one hop (~50ms)
      // before the first frame that detected the new pitch class.
      const lag = INTONATION_THRESHOLDS.onsetLagSeconds;
      entry.outOfTuneTimestamps.push({
        startSeconds: Math.max(0, ev.startSeconds - lag),
        endSeconds: ev.endSeconds,
      });
    }
  }

  const issues: PitchClassIssue[] = [];
  for (const [pitchClass, data] of map.entries()) {
    const outOfTuneCount = data.outOfTuneDeviations.length;
    if (
      outOfTuneCount < INTONATION_THRESHOLDS.problemNoteMinCount &&
      outOfTuneCount / data.total < INTONATION_THRESHOLDS.problemNoteErrorRate
    ) {
      continue;
    }

    const avgDev =
      outOfTuneCount > 0
        ? data.outOfTuneDeviations.reduce((s, d) => s + d, 0) / outOfTuneCount
        : 0;

    // Deduplicate timestamps that are within 2s of an already-kept one, then take first 3
    const deduped: { startSeconds: number; endSeconds: number }[] = [];
    for (const ts of data.outOfTuneTimestamps) {
      if (!deduped.some((kept) => Math.abs(kept.startSeconds - ts.startSeconds) < 2.0)) {
        deduped.push(ts);
      }
    }

    issues.push({
      pitchClass,
      totalNoteEvents: data.total,
      outOfTuneCount,
      errorRate: outOfTuneCount / data.total,
      avgDeviationCents: Math.round(avgDev),
      tendency: avgDev < -5 ? 'flat' : avgDev > 5 ? 'sharp' : 'mixed',
      exampleTimestamps: deduped.slice(0, 3),
      representativeMidi: modeOf(data.midiValues),
    });
  }

  // Most-problematic first
  return issues.sort((a, b) => b.outOfTuneCount - a.outOfTuneCount);
}

// ─────────────────────────────────────────────────────────────
// Step 3: build the observation summary sentence
// ─────────────────────────────────────────────────────────────

function buildObservationSummary(
  outOfTuneCount: number,
  totalNoteEvents: number,
  problemNotes: PitchClassIssue[],
  trend?: { prevCount: number },
): string {
  if (outOfTuneCount === 0) return 'All detected notes were in tune.';

  const inTunePct = Math.round(((totalNoteEvents - outOfTuneCount) / totalNoteEvents) * 100);
  const trendClause =
    trend && trend.prevCount > 0
      ? outOfTuneCount < trend.prevCount * 0.7
        ? ` (improved from ${trend.prevCount} last session)`
        : outOfTuneCount > trend.prevCount * 1.3
        ? ` (more than ${trend.prevCount} last session)`
        : ''
      : '';

  if (problemNotes.length === 0) {
    return `${outOfTuneCount} note${outOfTuneCount !== 1 ? 's were' : ' was'} out of tune${trendClause}.`;
  }

  const top = problemNotes[0];
  const topTend = top.tendency === 'flat' ? 'flat' : top.tendency === 'sharp' ? 'sharp' : 'off';

  if (problemNotes.length === 1) {
    return (
      `${top.pitchClass} was ${topTend} ${top.outOfTuneCount}× ` +
      `(${Math.round(top.errorRate * 100)}% of the time). ` +
      `${inTunePct}% of notes in tune overall${trendClause}.`
    );
  }

  const second = problemNotes[1];
  const secTend = second.tendency === 'flat' ? 'flat' : second.tendency === 'sharp' ? 'sharp' : 'off';
  return (
    `${top.pitchClass} was ${topTend} ${top.outOfTuneCount}× and ` +
    `${second.pitchClass} was ${secTend} ${second.outOfTuneCount}×. ` +
    `${inTunePct}% of notes in tune overall${trendClause}.`
  );
}

// ─────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────

export function analyzeIntonation(
  pitches: PitchFrame[],
  prevAnalysis?: { outOfTuneCount: number },
): IntonationAnalysis {
  const threshold = INTONATION_THRESHOLDS.outOfTuneCents;
  const noteEvents = detectNoteEvents(pitches, threshold);

  if (noteEvents.length === 0) {
    return {
      totalNoteEvents: 0,
      inTuneCount: 0,
      outOfTuneCount: 0,
      inTuneRate: 1,
      overallTendency: 'neutral',
      tendencyCents: 0,
      problemNotes: [],
      observationSummary: 'No notes detected — check audio recording.',
      _score: 50,
    };
  }

  const inTuneCount = noteEvents.filter((e) => !e.isOutOfTune).length;
  const outOfTuneCount = noteEvents.length - inTuneCount;
  const inTuneRate = inTuneCount / noteEvents.length;

  // Overall signed average deviation across ALL events
  const allAvg =
    noteEvents.reduce((s, e) => s + e.avgDeviationCents, 0) / noteEvents.length;
  const overallTendency: IntonationAnalysis['overallTendency'] =
    allAvg < -INTONATION_THRESHOLDS.tendencyCents
      ? 'flat'
      : allAvg > INTONATION_THRESHOLDS.tendencyCents
      ? 'sharp'
      : 'neutral';

  const problemNotes = aggregateByPitchClass(noteEvents);

  const observationSummary = buildObservationSummary(
    outOfTuneCount,
    noteEvents.length,
    problemNotes,
    prevAnalysis ? { prevCount: prevAnalysis.outOfTuneCount } : undefined,
  );

  return {
    totalNoteEvents: noteEvents.length,
    inTuneCount,
    outOfTuneCount,
    inTuneRate,
    overallTendency,
    tendencyCents: Math.round(allAvg),
    problemNotes,
    observationSummary,
    _score: Math.round(inTuneRate * 100),
  };
}
