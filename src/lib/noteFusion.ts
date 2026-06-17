import { RawAudioSignals, IntonationAnalysis, PitchClassIssue } from '../types/analysis';
import { FrameKeypoints, POSE, HAND, CONFIDENCE_THRESHOLD, jointAngle } from './poseScoring';

// ─────────────────────────────────────────────────────────────
// NoteEvent type
// ─────────────────────────────────────────────────────────────

export interface NoteEvent {
  // Timing
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;

  // Pitch identity
  pitchHz: number;
  noteName: string;                // e.g. "F#4"
  string: 'G' | 'D' | 'A' | 'E';
  inferredFinger: 0 | 1 | 2 | 3 | 4;
  positionGroup: 'first' | 'third' | 'fifth' | 'higher';

  // Pitch accuracy
  centsDeviation: number;          // signed: + = sharp, - = flat
  absCentsDeviation: number;
  inTune: boolean;                 // |cents| <= 25

  // Tone & dynamics
  fundamentalRatio: number;        // 0-1, FFT fundamental/total power
  dynamicLevel: number;            // 0-1, normalized RMS

  // Bow (null until bow detector built; bowZone uses wrist proxy)
  bowContactPoint: number | null;
  bowAngle: number | null;
  bowDistanceFromBridge: number | null;
  bowZone: 'sul_ponticello' | 'normal' | 'sul_tasto' | null;

  // Left hand / posture (null when pose frames unavailable)
  wristCollapsed: boolean | null;
  shoulderRaised: boolean | null;

  // Context
  distanceFromCrossing: number | null;  // notes since last string change (null if none in prev 5)
  phrasePosition: number;               // 0-1 within detected phrase
  phraseDurationSeconds: number;
}

// ─────────────────────────────────────────────────────────────
// Pitch helpers
// ─────────────────────────────────────────────────────────────

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function midiToName(midi: number): string {
  const pc = ((midi % 12) + 12) % 12;
  const oct = Math.floor(midi / 12) - 1;
  return NOTE_NAMES[pc] + oct;
}

function freqToMidiRaw(freq: number): number {
  return 12 * Math.log2(freq / 440) + 69;
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Violin string boundaries (open string freq to just below next open string)
const STRING_RANGES: { str: 'G' | 'D' | 'A' | 'E'; minHz: number }[] = [
  { str: 'E', minHz: 659 },
  { str: 'A', minHz: 440 },
  { str: 'D', minHz: 294 },
  { str: 'G', minHz: 0   },
];

function inferString(freq: number): 'G' | 'D' | 'A' | 'E' {
  for (const { str, minHz } of STRING_RANGES) {
    if (freq >= minHz) return str;
  }
  return 'G';
}

const OPEN_STRING_HZ: Record<'G' | 'D' | 'A' | 'E', number> = {
  G: 196.0,
  D: 293.7,
  A: 440.0,
  E: 659.3,
};

// Semitones above open string → first-position finger (approximate)
function inferFinger(freq: number, str: 'G' | 'D' | 'A' | 'E'): 0 | 1 | 2 | 3 | 4 {
  const semis = Math.max(0, Math.round(12 * Math.log2(freq / OPEN_STRING_HZ[str])));
  if (semis === 0) return 0;
  if (semis <= 2) return 1;
  if (semis <= 4) return 2;
  if (semis <= 6) return 3;
  return 4;
}

function positionGroupFromMidi(midi: number): 'first' | 'third' | 'fifth' | 'higher' {
  // Violin: first position tops out around B4 (MIDI 71), third ~E5 (76), fifth ~A5 (81)
  if (midi <= 71) return 'first';
  if (midi <= 76) return 'third';
  if (midi <= 81) return 'fifth';
  return 'higher';
}

// ─────────────────────────────────────────────────────────────
// Pose helpers
// ─────────────────────────────────────────────────────────────

function nearestPoseFrame(frames: FrameKeypoints[], t: number): FrameKeypoints | null {
  if (frames.length === 0) return null;
  let best = frames[0];
  let bestDiff = Math.abs(frames[0].timestamp - t);
  for (let i = 1; i < frames.length; i++) {
    const diff = Math.abs(frames[i].timestamp - t);
    if (diff < bestDiff) { best = frames[i]; bestDiff = diff; }
  }
  return bestDiff <= 2 ? best : null;
}

function getWristCollapsed(frame: FrameKeypoints): boolean | null {
  const pose = frame.poseLandmarks;
  const lh   = frame.leftHandLandmarks;
  if (!pose || !lh) return null;
  const elbow    = pose[POSE.LEFT_ELBOW];
  const wrist    = pose[POSE.LEFT_WRIST];
  const indexMcp = lh[HAND.INDEX_MCP];
  if (!elbow || !wrist || !indexMcp) return null;
  if ((elbow.visibility    ?? 1) < CONFIDENCE_THRESHOLD) return null;
  if ((wrist.visibility    ?? 1) < CONFIDENCE_THRESHOLD) return null;
  if ((indexMcp.visibility ?? 1) < CONFIDENCE_THRESHOLD) return null;
  return jointAngle(elbow, wrist, indexMcp) < 160;
}

function getShoulderRaised(frame: FrameKeypoints): boolean | null {
  const pose = frame.poseLandmarks;
  if (!pose) return null;
  const lS = pose[POSE.LEFT_SHOULDER], rS = pose[POSE.RIGHT_SHOULDER];
  if (!lS || !rS) return null;
  if ((lS.visibility !== undefined && lS.visibility < CONFIDENCE_THRESHOLD) ||
      (rS.visibility !== undefined && rS.visibility < CONFIDENCE_THRESHOLD)) return null;
  return Math.abs(lS.y - rS.y) > 0.04;
}

// Bow zone requires a bow detector — wrist-x proxy is unreliable from a front camera.
function getBowZone(_frame: FrameKeypoints): 'sul_ponticello' | 'normal' | 'sul_tasto' | null {
  return null;
}

// ─────────────────────────────────────────────────────────────
// Phrase detection from smoothed RMS
// ─────────────────────────────────────────────────────────────

interface Phrase { start: number; end: number; duration: number }

function detectPhrases(rmsFrames: { value: number; timestamp: number }[]): Phrase[] {
  if (rmsFrames.length < 2) return [];
  const hopSec = (rmsFrames[rmsFrames.length - 1].timestamp - rmsFrames[0].timestamp) /
                 (rmsFrames.length - 1);
  // 500ms rolling average
  const halfWin = Math.max(1, Math.round(0.25 / hopSec));
  const smoothed = rmsFrames.map((_, i) => {
    const lo = Math.max(0, i - halfWin);
    const hi = Math.min(rmsFrames.length - 1, i + halfWin);
    let s = 0;
    for (let j = lo; j <= hi; j++) s += rmsFrames[j].value;
    return s / (hi - lo + 1);
  });

  const silenceThresh = 0.008;
  const minSilenceFrames = Math.max(1, Math.round(0.3 / hopSec));
  const phrases: Phrase[] = [];
  let phraseStart: number | null = null;
  let silenceRun = 0;

  for (let i = 0; i < smoothed.length; i++) {
    const t = rmsFrames[i].timestamp;
    if (smoothed[i] >= silenceThresh) {
      if (phraseStart === null) phraseStart = t;
      silenceRun = 0;
    } else {
      silenceRun++;
      if (phraseStart !== null && silenceRun >= minSilenceFrames) {
        const endIdx = Math.max(0, i - silenceRun);
        const end = rmsFrames[endIdx].timestamp;
        if (end > phraseStart) phrases.push({ start: phraseStart, end, duration: end - phraseStart });
        phraseStart = null;
        silenceRun = 0;
      }
    }
  }
  if (phraseStart !== null) {
    const end = rmsFrames[rmsFrames.length - 1].timestamp;
    if (end > phraseStart) phrases.push({ start: phraseStart, end, duration: end - phraseStart });
  }
  return phrases;
}

function phraseContext(phrases: Phrase[], t: number): { position: number; duration: number } {
  for (const p of phrases) {
    if (t >= p.start && t <= p.end + 0.1) {
      return {
        position: p.duration > 0 ? Math.min(1, (t - p.start) / p.duration) : 0,
        duration: p.duration,
      };
    }
  }
  return { position: 0, duration: 0 };
}

// ─────────────────────────────────────────────────────────────
// Note segmentation from pitch frames
// ─────────────────────────────────────────────────────────────

interface PitchSegment {
  start: number;
  end: number;
  frames: { frequency: number; timestamp: number }[];
}

// Groups consecutive same-pitch-class pitch frames into note segments.
//
// Gap bridge: up to MAX_NULL_GAP consecutive null frames inside an active note are
// tolerated (handles brief YIN failures on bow attacks or lightly-played frames).
// Beyond that, silence is treated as a note boundary.
//
// The RMS noise gate in detectPitches() (audioEngine.ts) is the primary defence
// against garbage YIN calls on silence — null frames during inter-note silences
// prevent those from opening or extending segments here.
function segmentByPitch(
  pitchFrames: { frequency: number | null; timestamp: number }[],
  duration: number,
): PitchSegment[] {
  const MIN_DURATION_S = 0.05;  // 50ms (was 80ms) — catches fast notes (~32nd at 120 BPM = 62ms)
  const MAX_NULL_GAP   = 4;     // 4×25ms hop = 100ms bridge (was 2×50ms = same tolerance)
  // Must match hopSize in detectPitches (audioEngine.ts). Used to extend the
  // outgoing note's end by one hop past its last detected frame so the handoff
  // between A.endSeconds and B.startSeconds has no audible gap.
  const HOP_S = 0.025;

  const segments: PitchSegment[] = [];
  let curPc: string | null = null;
  let segStart = 0;
  let segFrames: { frequency: number; timestamp: number }[] = [];
  let nullRun = 0;

  const flush = (end: number) => {
    if (curPc === null || segFrames.length === 0) return;
    if (end - segStart >= MIN_DURATION_S) segments.push({ start: segStart, end, frames: segFrames });
    curPc = null;
    segFrames = [];
    nullRun = 0;
  };

  for (const f of pitchFrames) {
    if (f.frequency === null) {
      nullRun++;
      if (curPc !== null && nullRun > MAX_NULL_GAP) {
        const endT = segFrames.length > 0
          ? segFrames[segFrames.length - 1].timestamp + HOP_S
          : f.timestamp;
        flush(endT);
      }
      continue;
    }

    nullRun = 0;
    const midi = Math.round(freqToMidiRaw(f.frequency));
    const pc = NOTE_NAMES[((midi % 12) + 12) % 12];

    if (pc === curPc) {
      segFrames.push({ frequency: f.frequency, timestamp: f.timestamp });
    } else {
      // A ends at the last frame where A was detected + 1 hop (the last moment A
      // was audible). B starts at f.timestamp (the first moment B is audible).
      // These two values are what chip timestamps display and what the overlay
      // uses to decide which note is current — keeping them at actual audible
      // moments guarantees the overlay and chip always agree with the video.
      const aEnd = segFrames.length > 0
        ? segFrames[segFrames.length - 1].timestamp + HOP_S
        : f.timestamp;
      flush(aEnd);
      curPc = pc;
      segStart = f.timestamp;
      segFrames = [{ frequency: f.frequency, timestamp: f.timestamp }];
    }
  }

  if (segFrames.length > 0) flush(duration);
  return segments;
}

// Iteratively removes short events that are sandwiched between notes within
// SEMITONE_DIST semitones on both sides AND where those two neighbors are also
// similar to each other — this targets vibrato pitch-class bleed (A→A#→A oscillation)
// and bow-change transients while leaving fast scalar/chromatic passages intact.
//
// The key guard is |prevMidi - nextMidi| <= SEMITONE_DIST: a chromatic passing note
// like G→G#→A has |G-A|=2, so G# is NOT filtered. Only the oscillation pattern
// (prev ≈ cur ≈ next) is removed. MAX_PASSES runs iteratively because filtering one
// artifact can expose the next.
function filterArtifacts(events: NoteEvent[]): NoteEvent[] {
  const SHORT_S = 0.15;        // candidate threshold: events under 150ms (was 300ms — too aggressive for fast playing)
  const SEMITONE_DIST = 1;     // within 1 semitone of both neighbors
  const MAX_PASSES = 6;

  let arr = events;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const next = arr.filter((ev, i) => {
      if (ev.durationSeconds >= SHORT_S) return true;
      if (i === 0 || i === arr.length - 1) return true;
      const prevMidi = Math.round(freqToMidiRaw(arr[i - 1].pitchHz));
      const curMidi  = Math.round(freqToMidiRaw(ev.pitchHz));
      const nextMidi = Math.round(freqToMidiRaw(arr[i + 1].pitchHz));
      // Only filter if it looks like an oscillation: the two surrounding notes must
      // also be close to each other (not a chromatic/scalar passage moving forward).
      return !(Math.abs(curMidi - prevMidi) <= SEMITONE_DIST &&
               Math.abs(curMidi - nextMidi) <= SEMITONE_DIST &&
               Math.abs(prevMidi - nextMidi) <= SEMITONE_DIST);
    });
    if (next.length === arr.length) break;
    arr = next;
  }
  return arr;
}

// ─────────────────────────────────────────────────────────────
// Main fusion function
// ─────────────────────────────────────────────────────────────

export function fuseSignals(
  audio: RawAudioSignals,
  poseFrames: FrameKeypoints[],
): NoteEvent[] {
  const { pitchFrames, rmsFrames, toneFrames, duration } = audio;
  if (pitchFrames.length === 0) return [];

  const segments = segmentByPitch(pitchFrames, duration);
  if (segments.length === 0) return [];

  const maxRms = rmsFrames.reduce((m, f) => Math.max(m, f.value), 0.001);
  const phrases = detectPhrases(rmsFrames);
  const events: NoteEvent[] = [];

  for (const seg of segments) {
    const { start: noteStart, end: noteEnd, frames: segPitches } = seg;
    const noteDuration = noteEnd - noteStart;

    const pitchHz = median(segPitches.map(f => f.frequency));
    if (pitchHz < 150 || pitchHz > 5000) continue;

    // Pitch identity
    const midiRaw = freqToMidiRaw(pitchHz);
    const midiRounded = Math.round(midiRaw);
    const centsDeviation = (midiRaw - midiRounded) * 100;
    const noteName = midiToName(midiRounded);
    const str = inferString(pitchHz);
    const finger = inferFinger(pitchHz, str);
    const posGrp = positionGroupFromMidi(midiRounded);

    // Tone quality: mean fundamental ratio in window
    const noteTones = toneFrames.filter(f => f.timestamp >= noteStart && f.timestamp < noteEnd);
    const fundamentalRatio = noteTones.length > 0
      ? noteTones.reduce((s, f) => s + f.fundamentalRatio, 0) / noteTones.length
      : 0.5;

    // Dynamic level: mean RMS in window, normalized to session max
    const noteRmsVals = rmsFrames.filter(f => f.timestamp >= noteStart && f.timestamp < noteEnd);
    const meanRms = noteRmsVals.length > 0
      ? noteRmsVals.reduce((s, f) => s + f.value, 0) / noteRmsVals.length
      : 0;
    const dynamicLevel = Math.min(1, meanRms / maxRms);

    // Pose signals at note midpoint
    const noteMid = (noteStart + noteEnd) / 2;
    const poseFrame = nearestPoseFrame(poseFrames, noteMid);
    const wristCollapsed  = poseFrame ? getWristCollapsed(poseFrame)  : null;
    const shoulderRaised  = poseFrame ? getShoulderRaised(poseFrame)  : null;
    const bowZone         = poseFrame ? getBowZone(poseFrame)         : null;

    // Phrase context
    const { position: phrasePosition, duration: phraseDurationSeconds } =
      phraseContext(phrases, noteStart);

    events.push({
      startSeconds: noteStart,
      endSeconds: noteEnd,
      durationSeconds: noteDuration,
      pitchHz,
      noteName,
      string: str,
      inferredFinger: finger,
      positionGroup: posGrp,
      centsDeviation,
      absCentsDeviation: Math.abs(centsDeviation),
      inTune: Math.abs(centsDeviation) <= 25,
      fundamentalRatio,
      dynamicLevel,
      bowContactPoint: null,
      bowAngle: null,
      bowDistanceFromBridge: null,
      bowZone,
      wristCollapsed,
      shoulderRaised,
      distanceFromCrossing: null,  // filled in below
      phrasePosition,
      phraseDurationSeconds,
    });
  }

  // Remove vibrato bleed and bow-change transients before final output
  const filtered = filterArtifacts(events);

  // distanceFromCrossing — scan back up to 5 notes for last string change
  for (let i = 0; i < filtered.length; i++) {
    let dist: number | null = null;
    for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
      if (filtered[j].string !== filtered[i].string) {
        dist = i - j;
        break;
      }
    }
    filtered[i].distanceFromCrossing = dist;
  }

  return filtered;
}

// ─────────────────────────────────────────────────────────────
// Debug logger — call inside __DEV__ guard
// ─────────────────────────────────────────────────────────────

export function debugLogNoteEvents(noteEvents: NoteEvent[]): void {
  if (noteEvents.length === 0) {
    console.log('[NoteFusion] No note events detected (no pitched audio found in recording)');
    return;
  }

  const header = [
    'time'.padEnd(14),
    'note'.padEnd(5),
    'cents'.padStart(6),
    '  str',
    'fgr',
    ' vol',
    'ratio',
    'tune',
    'wrist',
    'xing',
    'phrase',
  ].join(' ');
  const sep = '─'.repeat(header.length);

  console.log(`\n[NoteFusion] ── ${noteEvents.length} note events ─────────────────────────────────`);
  console.log('  ' + header);
  console.log('  ' + sep);

  for (const n of noteEvents) {
    const time  = `${n.startSeconds.toFixed(2)}-${n.endSeconds.toFixed(2)}s`.padEnd(14);
    const note  = n.noteName.padEnd(5);
    const cents = ((n.centsDeviation >= 0 ? '+' : '') + Math.round(n.centsDeviation) + 'c').padStart(6);
    const str   = '  ' + n.string;
    const fgr   = ' ' + n.inferredFinger;
    const vol   = n.dynamicLevel.toFixed(2).padStart(4);
    const ratio = n.fundamentalRatio.toFixed(2).padStart(5);
    const tune  = n.inTune ? ' yes' : '  no';
    const wrist = n.wristCollapsed === null ? '   --' : n.wristCollapsed ? '  BAD' : '   ok';
    const xing  = n.distanceFromCrossing === null ? '  --' : ('  ' + n.distanceFromCrossing);
    const phrase = n.phrasePosition.toFixed(2).padStart(6);
    console.log('  ' + [time, note, cents, str, fgr, vol, ratio, tune, wrist, xing, phrase].join(' '));
  }

  // Summary
  const total = noteEvents.length;
  const inTuneN  = noteEvents.filter(n => n.inTune).length;
  const pct      = Math.round((inTuneN / total) * 100);
  const sCounts  = { G: 0, D: 0, A: 0, E: 0 } as Record<string, number>;
  const fCounts  = [0, 0, 0, 0, 0];
  for (const n of noteEvents) { sCounts[n.string]++; fCounts[n.inferredFinger]++; }

  // Crossing intonation check
  const afterCrossing = noteEvents.filter(n => n.distanceFromCrossing !== null && n.distanceFromCrossing <= 1);
  const xingInTune    = afterCrossing.filter(n => n.inTune).length;

  // Per-finger in-tune rate
  const fingerStats = fCounts.map((total, fi) => {
    if (total === 0) return null;
    const good = noteEvents.filter(n => n.inferredFinger === fi && n.inTune).length;
    return { fi, total, pct: Math.round((good / total) * 100) };
  }).filter(Boolean) as { fi: number; total: number; pct: number }[];

  console.log('  ' + sep);
  console.log(`  In tune: ${inTuneN}/${total} (${pct}%)`);
  console.log(`  Strings: G:${sCounts.G}  D:${sCounts.D}  A:${sCounts.A}  E:${sCounts.E}`);
  console.log(`  Fingers: open:${fCounts[0]}  1st:${fCounts[1]}  2nd:${fCounts[2]}  3rd:${fCounts[3]}  4th:${fCounts[4]}`);
  console.log(`  Per-finger tune%: ${fingerStats.map(s => `${s!.fi === 0 ? 'open' : s!.fi + 'st'}:${s!.pct}%`).join('  ')}`);
  if (afterCrossing.length > 0) {
    console.log(`  After string crossings: ${xingInTune}/${afterCrossing.length} in tune (${Math.round((xingInTune / afterCrossing.length) * 100)}%)`);
  }
  const wristBad = noteEvents.filter(n => n.wristCollapsed === true).length;
  if (wristBad > 0) {
    console.log(`  Wrist collapsed: ${wristBad} notes (${Math.round((wristBad / total) * 100)}%)`);
  }
  console.log('[NoteFusion] ─────────────────────────────────────────────────────────────────\n');
}

// ─────────────────────────────────────────────────────────────
// Derive IntonationAnalysis from NoteEvent[] (single source of truth)
// ─────────────────────────────────────────────────────────────

export function deriveIntonationAnalysis(noteEvents: NoteEvent[]): IntonationAnalysis {
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

  const inTuneCount = noteEvents.filter(n => n.inTune).length;
  const outOfTuneCount = noteEvents.length - inTuneCount;
  const inTuneRate = inTuneCount / noteEvents.length;
  const meanCents = noteEvents.reduce((s, n) => s + n.centsDeviation, 0) / noteEvents.length;
  const overallTendency: IntonationAnalysis['overallTendency'] =
    meanCents < -8 ? 'flat' : meanCents > 8 ? 'sharp' : 'neutral';

  // Group by full note name including octave (e.g. "B4", "B5" are separate entries)
  const byClass = new Map<string, { all: NoteEvent[]; outOfTune: NoteEvent[] }>();
  for (const n of noteEvents) {
    const pc = n.noteName;
    if (!byClass.has(pc)) byClass.set(pc, { all: [], outOfTune: [] });
    const entry = byClass.get(pc)!;
    entry.all.push(n);
    if (!n.inTune) entry.outOfTune.push(n);
  }

  const problemNotes: PitchClassIssue[] = [];
  for (const [pc, { all: pcNotes, outOfTune: badNotes }] of byClass.entries()) {
    const outCnt = badNotes.length;
    const rate = outCnt / pcNotes.length;
    // Minimum bar: ≥2 out-of-tune occurrences OR error rate ≥ 30%
    if (outCnt < 2 && rate < 0.30) continue;

    const avgDev = badNotes.reduce((s, n) => s + n.centsDeviation, 0) / outCnt;

    // Deduplicate timestamps (keep first 3, skip those within 2s of a kept one)
    const deduped: { startSeconds: number; endSeconds: number }[] = [];
    for (const n of badNotes) {
      if (!deduped.some(k => Math.abs(k.startSeconds - n.startSeconds) < 2.0)) {
        deduped.push({ startSeconds: n.startSeconds, endSeconds: n.endSeconds });
      }
    }

    // Most common MIDI pitch for this class (includes octave context)
    const midiCounts = new Map<number, number>();
    for (const n of pcNotes) {
      const midi = Math.round(freqToMidiRaw(n.pitchHz));
      midiCounts.set(midi, (midiCounts.get(midi) ?? 0) + 1);
    }
    const representativeMidi = [...midiCounts.entries()]
      .sort((a, b) => b[1] - a[1])[0]?.[0];

    problemNotes.push({
      pitchClass: pc,
      totalNoteEvents: pcNotes.length,
      outOfTuneCount: outCnt,
      errorRate: rate,
      avgDeviationCents: Math.round(avgDev),
      tendency: avgDev < -5 ? 'flat' : avgDev > 5 ? 'sharp' : 'mixed',
      exampleTimestamps: deduped.slice(0, 3),
      representativeMidi,
    });
  }

  problemNotes.sort((a, b) => b.outOfTuneCount - a.outOfTuneCount);

  // Observation summary — same format as intonationAnalysis.ts
  let observationSummary: string;
  if (outOfTuneCount === 0) {
    observationSummary = 'All detected notes were in tune.';
  } else {
    const inTunePct = Math.round((inTuneCount / noteEvents.length) * 100);
    if (problemNotes.length === 0) {
      observationSummary = `${outOfTuneCount} note${outOfTuneCount !== 1 ? 's were' : ' was'} out of tune.`;
    } else {
      const top = problemNotes[0];
      const tend = top.tendency === 'flat' ? 'flat' : top.tendency === 'sharp' ? 'sharp' : 'off';
      observationSummary =
        `${top.pitchClass} was ${tend} ${top.outOfTuneCount}× ` +
        `(${Math.round(top.errorRate * 100)}% of the time). ` +
        `${inTunePct}% of notes in tune overall.`;
    }
  }

  return {
    totalNoteEvents: noteEvents.length,
    inTuneCount,
    outOfTuneCount,
    inTuneRate,
    overallTendency,
    tendencyCents: Math.round(meanCents),
    problemNotes,
    observationSummary,
    _score: Math.round(inTuneRate * 100),
  };
}
