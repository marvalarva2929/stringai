import type { NoteEvent, Phrase } from './noteFusion';
import { midiToNoteName, noteNameToMidi } from './pitchNaming';

// ─────────────────────────────────────────────────────────────
// L7.5 — Musical context
//
// Everything above this layer measures physics: cents, hertz, bow position.
// Nothing measures *music* — what key was that, what shape was that figure,
// what was actually hard about it. Without that the app can only ever say
// "you played C# flat", and the exercise it hands back is a physics drill.
//
// This layer answers three questions over the same NoteEvent[] the rest of the
// pipeline already has:
//   estimateKey    — what key is this, globally and per phrase
//   detectFigures  — what musical shapes occurred (runs, arpeggios, crossings,
//                    shifts, holds, ornaments, sequences)
//   assessFigures  — which of them went badly, and — the part that matters —
//                    whether that KIND of figure went worse than the rest of
//                    the take. A tally is not a diagnosis; a contrast is.
//
// Pure, no RN/Expo imports, so it runs under plain Node for tests.
// ─────────────────────────────────────────────────────────────

export type Mode = 'major' | 'minor';

export interface KeyEstimate {
  /** Pitch class of the tonic, e.g. 'G', 'F#'. */
  tonic: string;
  mode: Mode;
  /** Label in the same vocabulary scaleSequence.parseScaleName accepts. */
  name: string;
  /** 0-1. Low when the take is short, chromatic, or relative-key ambiguous. */
  confidence: number;
}

export type FigureKind =
  | 'scalar_run'
  | 'arpeggio'
  | 'crossing_run'
  | 'shift'
  | 'sustained'
  | 'ornament'
  | 'sequence';

export type ChordQuality = 'major' | 'minor' | 'diminished' | 'dominant7' | 'diminished7';

export interface ChordIdentity {
  rootPitchClass: string;
  quality: ChordQuality;
  /** "G major", "D7", "C#dim7" — display-ready. */
  label: string;
}

export interface MusicalFigure {
  id: string;
  kind: FigureKind;
  startSeconds: number;
  endSeconds: number;
  /** Indices into the NoteEvent[] this context was built from. */
  noteIndices: number[];
  noteNames: string[];
  midiNotes: number[];
  /** Distinct strings touched, in order of first appearance. */
  strings: NoteEvent['string'][];
  /** Distinct positions touched, in order of first appearance. */
  positions: NoteEvent['positionGroup'][];
  /** Signed semitone deltas between consecutive notes. */
  intervalContour: number[];
  notesPerSecond: number;
  /** Index into the phrases array, or null when the figure spans none. */
  phraseId: number | null;
  /** Key of the phrase this figure sits in; falls back to the session key. */
  localKey: KeyEstimate | null;
  /** `arpeggio` only. */
  chord?: ChordIdentity;
  /** `shift` only. */
  shift?: {
    string: NoteEvent['string'];
    fromPosition: NoteEvent['positionGroup'];
    toPosition: NoteEvent['positionGroup'];
    semitones: number;
    finger: number;
  };
  /**
   * `crossing_run` only — the string pairs actually crossed, most-frequent
   * first, each ordered low-to-high ('G-D', 'D-A').
   *
   * NOT the same as `strings`, which is every string the figure touched. A
   * passage that visits G, D and A crosses G-D and D-A; it never crosses G-A,
   * and building an exercise from the extremes of `strings` invented a G-E
   * crossing for a player who had only gone G to D.
   */
  stringPairs?: string[];
  /** `ornament` only. */
  trill?: { lowerMidi: number; upperMidi: number; alternations: number; ratePerSecond: number };
  /** `sequence` only — how many times this contour recurred in the take. */
  repetitions?: number;
}

export type FigureSeverity = 'minor' | 'moderate' | 'significant';

/**
 * How one KIND of figure compared with everything else the player did. This is
 * the sentence that turns a measurement into a diagnosis, so it is computed
 * from real group statistics and refuses to speak below a usable sample.
 */
export interface KindContrast {
  kind: FigureKind;
  /** Plural noun phrase for prose: "crossing runs", "shifts". */
  label: string;
  inMeanAbsCents: number;
  inNoteCount: number;
  outMeanAbsCents: number;
  outNoteCount: number;
  /** in − out. Positive means this kind was worse than the rest of the take. */
  deltaCents: number;
  /** Cohen's d. */
  effectSize: number;
  significant: boolean;
}

export interface FigureAssessment {
  figureId: string;
  kind: FigureKind;
  meanAbsCents: number;
  /** Signed mean — tells flat from sharp, which changes the coaching. */
  meanSignedCents: number;
  inTuneRate: number;
  worstNoteName: string | null;
  worstCents: number | null;
  /** Spread of bow contact point across the figure; null when bow unseen. */
  bowCoverage: number | null;
  severity: FigureSeverity;
  confidence: number;
  /** The kind-level comparison, when one could be made honestly. */
  contrast: KindContrast | null;
}

export interface MusicalContext {
  key: KeyEstimate | null;
  /** Per-phrase key, index-aligned with the phrases passed in. */
  phraseKeys: (KeyEstimate | null)[];
  figures: MusicalFigure[];
  contrasts: KindContrast[];
  /** Worst-first, so callers can just take the head. */
  assessments: FigureAssessment[];
}

// ── Constants ────────────────────────────────────────────────

const PITCH_CLASS_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Open-string pitches, for ordering a crossing pair low-to-high. */
const OPEN_STRING_MIDI: Record<string, number> = { G: 55, D: 62, A: 69, E: 76 };
/** Low to high — neighbours are one step apart. */
const STRING_ORDER = ['G', 'D', 'A', 'E'];

/** True when two strings sit next to each other (G-D, D-A, A-E). */
export function areAdjacentStrings(a: string, b: string): boolean {
  const ia = STRING_ORDER.indexOf(a);
  const ib = STRING_ORDER.indexOf(b);
  return ia >= 0 && ib >= 0 && Math.abs(ia - ib) === 1;
}
// Krumhansl–Kessler probe-tone profiles.
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

/** Below this the pitch-class histogram is noise, not a key. */
const MIN_KEY_NOTES = 8;
const MIN_KEY_SECONDS = 2;

/** Same discipline as patternDetection: no claim from a handful of notes. */
const MIN_GROUP_SIZE = 8;
/** A contrast has to be both real (effect) and worth saying (cents). */
const MIN_CONTRAST_EFFECT = 0.3;
const MIN_CONTRAST_CENTS = 5;

const MIN_SUSTAINED_SECONDS = 1.2;
const MIN_RUN_NOTES = 4;
const MIN_ARPEGGIO_NOTES = 3;
const STEPWISE_FRACTION = 0.7;
const LEAP_FRACTION = 0.7;
const MIN_TRILL_ALTERNATIONS = 4;
const MIN_TRILL_RATE = 4;
/** A crossing run needs changes often enough to be the point of the passage. */
const MIN_CROSSINGS = 2;
const MIN_CROSSING_DENSITY = 0.34;
const MIN_SEQUENCE_LENGTH = 3;

const CHORD_TEMPLATES: { quality: ChordQuality; intervals: number[]; suffix: string }[] = [
  { quality: 'dominant7', intervals: [0, 4, 7, 10], suffix: '7' },
  { quality: 'diminished7', intervals: [0, 3, 6, 9], suffix: 'dim7' },
  { quality: 'major', intervals: [0, 4, 7], suffix: ' major' },
  { quality: 'minor', intervals: [0, 3, 7], suffix: ' minor' },
  { quality: 'diminished', intervals: [0, 3, 6], suffix: 'dim' },
];

const KIND_LABELS: Record<FigureKind, string> = {
  scalar_run: 'running passages',
  arpeggio: 'arpeggios',
  crossing_run: 'crossing runs',
  shift: 'shifts',
  sustained: 'held notes',
  ornament: 'ornaments',
  sequence: 'repeated figures',
};

// ── Small helpers ────────────────────────────────────────────

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function mean(values: number[]): number {
  return values.length > 0 ? values.reduce((s, v) => s + v, 0) / values.length : 0;
}

function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1));
}

function pitchClassOf(midi: number): number {
  return ((Math.round(midi) % 12) + 12) % 12;
}

function midiOf(note: NoteEvent): number {
  const midi = noteNameToMidi(note.noteName);
  return midi ?? Math.round(69 + 12 * Math.log2(note.pitchHz / 440));
}

function distinct<T>(values: T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const v of values) {
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  const ma = mean(a.slice(0, n));
  const mb = mean(b.slice(0, n));
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  const denom = Math.sqrt(da * db);
  return denom === 0 ? 0 : num / denom;
}

// ── Key estimation ───────────────────────────────────────────

/**
 * Duration-weighted pitch-class histogram. Weighting by sounding time rather
 * than note count is what stops a flurry of passing sixteenths from outvoting
 * the structural notes they decorate.
 */
function pitchClassHistogram(notes: NoteEvent[]): number[] {
  const histogram = new Array(12).fill(0);
  for (const note of notes) {
    histogram[pitchClassOf(midiOf(note))] += Math.max(note.durationSeconds, 0.05);
  }
  return histogram;
}

function rotate(profile: number[], steps: number): number[] {
  return profile.map((_, i) => profile[(i + steps) % 12]);
}

export interface EstimateKeyOptions {
  /** Free-text key from Piece.keySignature, e.g. "D major". A prior, not a rule. */
  keyHint?: string | null;
}

/** How much a matching user-supplied key signature nudges the correlation. */
const KEY_HINT_BONUS = 0.08;

export function estimateKey(notes: NoteEvent[], opts: EstimateKeyOptions = {}): KeyEstimate | null {
  if (notes.length < MIN_KEY_NOTES) return null;
  const totalSeconds = notes.reduce((s, n) => s + n.durationSeconds, 0);
  if (totalSeconds < MIN_KEY_SECONDS) return null;

  const histogram = pitchClassHistogram(notes);
  if (histogram.every((v) => v === 0)) return null;

  const hint = parseKeyName(opts.keyHint ?? undefined);

  const scored: { tonic: number; mode: Mode; r: number }[] = [];
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const mode of ['major', 'minor'] as Mode[]) {
      const profile = rotate(mode === 'major' ? MAJOR_PROFILE : MINOR_PROFILE, (12 - tonic) % 12);
      let r = pearson(histogram, profile);
      if (hint && hint.tonic === tonic && hint.mode === mode) r += KEY_HINT_BONUS;
      scored.push({ tonic, mode, r });
    }
  }
  scored.sort((a, b) => b.r - a.r);

  const best = scored[0];
  if (best.r <= 0) return null;

  // The classic Krumhansl weakness is relative major/minor — they share a
  // pitch-class set, so they score almost identically. Rather than pretend,
  // the margin between the top two collapses confidence when it is genuinely
  // ambiguous, and the caller decides whether that is good enough to speak.
  const runnerUp = scored[1]?.r ?? 0;
  const margin = clamp01((best.r - runnerUp) / 0.12);
  const strength = clamp01(best.r);
  const sample = clamp01(notes.length / 24);
  const confidence = clamp01(strength * (0.45 + 0.55 * margin) * (0.5 + 0.5 * sample));

  const tonic = PITCH_CLASS_NAMES[best.tonic];
  return { tonic, mode: best.mode, name: `${tonic} ${best.mode}`, confidence };
}

/** Parses "D major" / "d minor" / "F#" into a pitch class + mode. */
export function parseKeyName(name?: string | null): { tonic: number; mode: Mode } | null {
  if (!name) return null;
  const match = /^\s*([A-Ga-g])\s*(#|b|♯|♭)?\s*(major|minor|maj|min|m)?\s*$/.exec(name);
  if (!match) return null;
  const [, letter, accidental, quality] = match;
  const base: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
  const offset = accidental === '#' || accidental === '♯' ? 1 : accidental === 'b' || accidental === '♭' ? -1 : 0;
  const tonic = (base[letter.toLowerCase()] + offset + 12) % 12;
  const q = (quality ?? 'major').toLowerCase();
  const mode: Mode = q === 'minor' || q === 'min' || q === 'm' ? 'minor' : 'major';
  return { tonic, mode };
}

// ── Chord identification ─────────────────────────────────────

/**
 * Best chord whose tones cover every pitch class present. Prefers the template
 * that explains the notes with the fewest spare chord tones, so a plain triad
 * beats a 7th chord that merely happens to contain it.
 */
export function identifyChord(midiNotes: number[]): ChordIdentity | null {
  const present = new Set(midiNotes.map(pitchClassOf));
  if (present.size < 3) return null;

  let best: { root: number; template: (typeof CHORD_TEMPLATES)[number]; slack: number } | null = null;
  for (let root = 0; root < 12; root++) {
    for (const template of CHORD_TEMPLATES) {
      const tones = new Set(template.intervals.map((i) => (root + i) % 12));
      let covered = true;
      for (const pc of present) {
        if (!tones.has(pc)) { covered = false; break; }
      }
      if (!covered) continue;
      const slack = tones.size - present.size;
      if (!best || slack < best.slack) best = { root, template, slack };
    }
  }
  if (!best) return null;

  const rootPitchClass = PITCH_CLASS_NAMES[best.root];
  return {
    rootPitchClass,
    quality: best.template.quality,
    label: `${rootPitchClass}${best.template.suffix}`,
  };
}

// ── Figure detection ─────────────────────────────────────────

interface FigureContext {
  notes: NoteEvent[];
  midis: number[];
  phrases: Phrase[];
  phraseKeys: (KeyEstimate | null)[];
  sessionKey: KeyEstimate | null;
}

function phraseIdFor(ctx: FigureContext, startSeconds: number): number | null {
  const index = ctx.phrases.findIndex((p) => startSeconds >= p.start && startSeconds < p.end);
  return index === -1 ? null : index;
}

function buildFigure(
  ctx: FigureContext,
  kind: FigureKind,
  indices: number[],
  extra: Partial<MusicalFigure> = {},
): MusicalFigure {
  const notes = indices.map((i) => ctx.notes[i]);
  const midis = indices.map((i) => ctx.midis[i]);
  const startSeconds = notes[0].startSeconds;
  const endSeconds = notes[notes.length - 1].endSeconds;
  const span = Math.max(endSeconds - startSeconds, 0.001);
  const phraseId = phraseIdFor(ctx, startSeconds);
  const intervalContour: number[] = [];
  for (let i = 1; i < midis.length; i++) intervalContour.push(midis[i] - midis[i - 1]);

  return {
    id: `${kind}:${startSeconds.toFixed(2)}`,
    kind,
    startSeconds,
    endSeconds,
    noteIndices: indices,
    noteNames: notes.map((n) => n.noteName),
    midiNotes: midis,
    strings: distinct(notes.map((n) => n.string)),
    positions: distinct(notes.map((n) => n.positionGroup)),
    intervalContour,
    notesPerSecond: notes.length / span,
    phraseId,
    localKey: (phraseId != null ? ctx.phraseKeys[phraseId] : null) ?? ctx.sessionKey,
    ...extra,
  };
}

/**
 * How many consecutive non-matching intervals end a figure. A whole-run
 * fraction alone is not enough: once a long run has banked enough matches, the
 * average stays healthy while it swallows everything after it, and a crossing
 * passage silently annexes the calm bars that follow. A figure has to keep
 * doing the thing that names it.
 */
const LOCAL_BREAK_RUN = 3;

/** Maximal runs of consecutive notes where `ok(delta)` holds for enough steps. */
function maximalRuns(
  midis: number[],
  minLength: number,
  minFraction: number,
  ok: (delta: number) => boolean,
): number[][] {
  const runs: number[][] = [];
  let start = 0;
  while (start < midis.length - 1) {
    let matches = 0;
    let steps = 0;
    let sinceMatch = 0;
    // The last note reached by a *matching* interval — the run is trimmed back
    // to here, so a figure never ends on notes that aren't part of it.
    let lastMatch = start;
    for (let i = start + 1; i < midis.length; i++) {
      const matched = ok(midis[i] - midis[i - 1]);
      const nextMatches = matches + (matched ? 1 : 0);
      const nextSteps = steps + 1;
      // A single foreign interval inside an otherwise stepwise run shouldn't
      // split it in two, but a stretch of them should.
      if (nextMatches / nextSteps < minFraction) break;
      sinceMatch = matched ? 0 : sinceMatch + 1;
      if (sinceMatch >= LOCAL_BREAK_RUN) break;
      matches = nextMatches;
      steps = nextSteps;
      if (matched) lastMatch = i;
    }
    const length = lastMatch - start + 1;
    if (length >= minLength && matches / Math.max(1, lastMatch - start) >= minFraction) {
      runs.push(Array.from({ length }, (_, k) => start + k));
      start = lastMatch;
    } else {
      start += 1;
    }
  }
  return runs;
}

const isStep = (delta: number) => Math.abs(delta) >= 1 && Math.abs(delta) <= 2;
const isChordLeap = (delta: number) => {
  const abs = Math.abs(delta);
  return abs >= 3 && abs <= 9;
};

function detectScalarRuns(ctx: FigureContext): MusicalFigure[] {
  return maximalRuns(ctx.midis, MIN_RUN_NOTES, STEPWISE_FRACTION, isStep)
    .map((indices) => buildFigure(ctx, 'scalar_run', indices));
}

function detectArpeggios(ctx: FigureContext): MusicalFigure[] {
  const figures: MusicalFigure[] = [];
  for (const indices of maximalRuns(ctx.midis, MIN_ARPEGGIO_NOTES, LEAP_FRACTION, isChordLeap)) {
    const chord = identifyChord(indices.map((i) => ctx.midis[i]));
    // Leaps that don't spell a chord are just leaps — the whole value of
    // calling something an arpeggio is being able to name the harmony.
    if (!chord) continue;
    figures.push(buildFigure(ctx, 'arpeggio', indices, { chord }));
  }
  return figures;
}

function detectCrossingRuns(ctx: FigureContext): MusicalFigure[] {
  const { notes } = ctx;
  const figures: MusicalFigure[] = [];
  let start = 0;
  while (start < notes.length - 1) {
    let crossings = 0;
    let sinceCrossing = 0;
    let lastCrossing = start;
    for (let i = start + 1; i < notes.length; i++) {
      const changed = notes[i].string !== notes[i - 1].string;
      const nextCrossings = crossings + (changed ? 1 : 0);
      const noteCount = i - start + 1;
      if (nextCrossings / noteCount < MIN_CROSSING_DENSITY) break;
      sinceCrossing = changed ? 0 : sinceCrossing + 1;
      if (sinceCrossing >= LOCAL_BREAK_RUN) break;
      crossings = nextCrossings;
      if (changed) lastCrossing = i;
    }
    const end = lastCrossing;
    const length = end - start + 1;
    if (length >= 3 && crossings >= MIN_CROSSINGS) {
      const indices = Array.from({ length }, (_, k) => start + k);
      // Count each real transition. Which pair the player actually crossed most
      // is the one worth drilling — and it has to be a pair they truly played,
      // not the outer edges of everything they touched.
      const counts = new Map<string, number>();
      const firstSeen = new Map<string, number>();
      for (let i = 1; i < indices.length; i++) {
        const from = notes[indices[i - 1]].string;
        const to = notes[indices[i]].string;
        if (from === to) continue;
        // Only neighbouring strings. "G to A" skips the D string entirely — not
        // something a player does between consecutive notes, so where the data
        // says so it is NoteEvent.string being wrong, not the playing being
        // strange. That field is inferred from pitch alone (see noteFusion's
        // inferString), so an octave slip on one note fabricates exactly this.
        if (!areAdjacentStrings(from, to)) continue;
        const key = [from, to].sort((a, b) => OPEN_STRING_MIDI[a] - OPEN_STRING_MIDI[b]).join('-');
        counts.set(key, (counts.get(key) ?? 0) + 1);
        if (!firstSeen.has(key)) firstSeen.set(key, i);
      }
      const stringPairs = [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || firstSeen.get(a[0])! - firstSeen.get(b[0])!)
        .map(([key]) => key);
      // Every apparent crossing was between non-neighbouring strings, so there
      // is nothing here worth claiming.
      if (stringPairs.length > 0) {
        const figure = buildFigure(ctx, 'crossing_run', indices, { stringPairs });
        // Name only the strings the surviving crossings involve, so the figure
        // can't advertise a string that no reported crossing touched.
        figure.strings = distinct(stringPairs.flatMap((p) => p.split('-'))) as NoteEvent['string'][];
        figures.push(figure);
      }
      start = end;
    } else {
      start += 1;
    }
  }
  return figures;
}

function detectShifts(ctx: FigureContext): MusicalFigure[] {
  const { notes, midis } = ctx;
  const figures: MusicalFigure[] = [];
  for (let i = 1; i < notes.length; i++) {
    const from = notes[i - 1];
    const to = notes[i];
    // A position change on the *same* string is a shift. Across strings it is
    // a crossing wearing a shift's clothes, and belongs to the other detector.
    if (from.string !== to.string) continue;
    if (from.positionGroup === to.positionGroup) continue;
    // Include the neighbours so the drill has the approach and the landing,
    // which is what actually goes wrong in a shift.
    const startIndex = Math.max(0, i - 1);
    const endIndex = Math.min(notes.length - 1, i + 1);
    const indices = Array.from({ length: endIndex - startIndex + 1 }, (_, k) => startIndex + k);
    figures.push(
      buildFigure(ctx, 'shift', indices, {
        shift: {
          string: to.string,
          fromPosition: from.positionGroup,
          toPosition: to.positionGroup,
          semitones: midis[i] - midis[i - 1],
          finger: to.inferredFinger,
        },
      }),
    );
  }
  return figures;
}

function detectSustained(ctx: FigureContext): MusicalFigure[] {
  const figures: MusicalFigure[] = [];
  ctx.notes.forEach((note, i) => {
    if (note.durationSeconds < MIN_SUSTAINED_SECONDS) return;
    figures.push(buildFigure(ctx, 'sustained', [i]));
  });
  return figures;
}

function detectOrnaments(ctx: FigureContext): MusicalFigure[] {
  const { midis, notes } = ctx;
  const figures: MusicalFigure[] = [];
  let i = 0;
  while (i < midis.length - MIN_TRILL_ALTERNATIONS) {
    const a = midis[i];
    const b = midis[i + 1];
    const gap = Math.abs(b - a);
    if (gap < 1 || gap > 2) { i += 1; continue; }
    let end = i + 1;
    while (end + 1 < midis.length && midis[end + 1] === midis[end - 1]) end += 1;
    const alternations = end - i;
    if (alternations >= MIN_TRILL_ALTERNATIONS) {
      const indices = Array.from({ length: end - i + 1 }, (_, k) => i + k);
      const span = Math.max(notes[end].endSeconds - notes[i].startSeconds, 0.001);
      const ratePerSecond = alternations / span;
      if (ratePerSecond >= MIN_TRILL_RATE) {
        figures.push(
          buildFigure(ctx, 'ornament', indices, {
            trill: {
              lowerMidi: Math.min(a, b),
              upperMidi: Math.max(a, b),
              alternations,
              ratePerSecond,
            },
          }),
        );
      }
      i = end;
    } else {
      i += 1;
    }
  }
  return figures;
}

/**
 * Interval contours that recur, transposed, elsewhere in the take. A figure the
 * player meets repeatedly is worth drilling on its own terms — and if it went
 * wrong every time, that is a far stronger finding than one bad note.
 */
function detectSequences(ctx: FigureContext): MusicalFigure[] {
  const { midis } = ctx;
  if (midis.length < MIN_SEQUENCE_LENGTH * 2) return [];

  const occurrences = new Map<string, number[]>();
  for (let i = 0; i + MIN_SEQUENCE_LENGTH <= midis.length; i++) {
    const contour: number[] = [];
    for (let k = 1; k < MIN_SEQUENCE_LENGTH; k++) contour.push(midis[i + k] - midis[i + k - 1]);
    // An unmoving "contour" is a repeated note, not a sequence.
    if (contour.every((d) => d === 0)) continue;
    const key = contour.join(',');
    const starts = occurrences.get(key) ?? [];
    starts.push(i);
    occurrences.set(key, starts);
  }

  const figures: MusicalFigure[] = [];
  for (const [, starts] of occurrences) {
    // Overlapping windows are the same occurrence seen twice.
    const spaced = starts.filter((s, idx) => idx === 0 || s - starts[idx - 1] >= MIN_SEQUENCE_LENGTH);
    if (spaced.length < 2) continue;
    for (const start of spaced) {
      const indices = Array.from({ length: MIN_SEQUENCE_LENGTH }, (_, k) => start + k);
      figures.push(buildFigure(ctx, 'sequence', indices, { repetitions: spaced.length }));
    }
  }
  return figures;
}

// ── Assessment ───────────────────────────────────────────────

function severityFor(deltaCents: number, meanAbsCents: number): FigureSeverity {
  if (deltaCents >= 15 || meanAbsCents >= 30) return 'significant';
  if (deltaCents >= 8 || meanAbsCents >= 20) return 'moderate';
  return 'minor';
}

/**
 * Per-kind comparison: every note inside a figure of this kind, against every
 * note that is in no figure of this kind. Both groups must clear MIN_GROUP_SIZE
 * — the same bar patternDetection sets — so a two-note fluke never becomes a
 * claim the app makes out loud.
 */
export function buildKindContrasts(notes: NoteEvent[], figures: MusicalFigure[]): KindContrast[] {
  const contrasts: KindContrast[] = [];
  const kinds = distinct(figures.map((f) => f.kind));

  for (const kind of kinds) {
    const inside = new Set<number>();
    for (const figure of figures) {
      if (figure.kind !== kind) continue;
      for (const i of figure.noteIndices) inside.add(i);
    }
    const inValues: number[] = [];
    const outValues: number[] = [];
    notes.forEach((note, i) => {
      (inside.has(i) ? inValues : outValues).push(note.absCentsDeviation);
    });
    if (inValues.length < MIN_GROUP_SIZE || outValues.length < MIN_GROUP_SIZE) continue;

    const inMean = mean(inValues);
    const outMean = mean(outValues);
    const inSd = stdDev(inValues);
    const outSd = stdDev(outValues);
    const pooled = Math.sqrt((inSd ** 2 + outSd ** 2) / 2);
    const effectSize = pooled === 0 ? 0 : (inMean - outMean) / pooled;
    const deltaCents = inMean - outMean;

    contrasts.push({
      kind,
      label: KIND_LABELS[kind],
      inMeanAbsCents: Math.round(inMean * 10) / 10,
      inNoteCount: inValues.length,
      outMeanAbsCents: Math.round(outMean * 10) / 10,
      outNoteCount: outValues.length,
      deltaCents: Math.round(deltaCents * 10) / 10,
      effectSize: Math.round(effectSize * 100) / 100,
      significant: effectSize >= MIN_CONTRAST_EFFECT && deltaCents >= MIN_CONTRAST_CENTS,
    });
  }

  return contrasts.sort((a, b) => b.deltaCents - a.deltaCents);
}

export function assessFigures(
  notes: NoteEvent[],
  figures: MusicalFigure[],
  contrasts: KindContrast[],
): FigureAssessment[] {
  const contrastByKind = new Map(contrasts.map((c) => [c.kind, c]));

  return figures
    .map((figure) => {
      const figureNotes = figure.noteIndices.map((i) => notes[i]).filter(Boolean);
      const absCents = figureNotes.map((n) => n.absCentsDeviation);
      const signedCents = figureNotes.map((n) => n.centsDeviation);
      const bowPoints = figureNotes
        .map((n) => n.bowContactPoint)
        .filter((v): v is number => v != null);

      let worstNoteName: string | null = null;
      let worstCents: number | null = null;
      for (const note of figureNotes) {
        if (worstCents == null || note.absCentsDeviation > Math.abs(worstCents)) {
          worstCents = note.centsDeviation;
          worstNoteName = note.noteName;
        }
      }

      const contrast = contrastByKind.get(figure.kind) ?? null;
      const meanAbsCents = mean(absCents);
      return {
        figureId: figure.id,
        kind: figure.kind,
        meanAbsCents: Math.round(meanAbsCents * 10) / 10,
        meanSignedCents: Math.round(mean(signedCents) * 10) / 10,
        inTuneRate: figureNotes.length === 0
          ? 0
          : figureNotes.filter((n) => n.inTune).length / figureNotes.length,
        worstNoteName,
        worstCents: worstCents == null ? null : Math.round(worstCents),
        bowCoverage: bowPoints.length >= 2 ? Math.max(...bowPoints) - Math.min(...bowPoints) : null,
        severity: severityFor(contrast?.significant ? contrast.deltaCents : 0, meanAbsCents),
        confidence: clamp01(figureNotes.length / 6) * (contrast?.significant ? 1 : 0.6),
        contrast: contrast?.significant ? contrast : null,
      };
    })
    .sort((a, b) => b.meanAbsCents * b.confidence - a.meanAbsCents * a.confidence);
}

// ── Entry point ──────────────────────────────────────────────

export interface BuildMusicalContextOptions {
  keyHint?: string | null;
}

export function detectFigures(
  notes: NoteEvent[],
  phrases: Phrase[],
  sessionKey: KeyEstimate | null,
  phraseKeys: (KeyEstimate | null)[],
): MusicalFigure[] {
  if (notes.length < 2) return [];
  const ctx: FigureContext = {
    notes,
    midis: notes.map(midiOf),
    phrases,
    phraseKeys,
    sessionKey,
  };

  // Kinds overlap on purpose — a fast passage that also crosses strings is
  // genuinely both, and which one to coach depends on which measured worse.
  return [
    ...detectScalarRuns(ctx),
    ...detectArpeggios(ctx),
    ...detectCrossingRuns(ctx),
    ...detectShifts(ctx),
    ...detectSustained(ctx),
    ...detectOrnaments(ctx),
    ...detectSequences(ctx),
  ].sort((a, b) => a.startSeconds - b.startSeconds);
}

export function buildMusicalContext(
  notes: NoteEvent[],
  phrases: Phrase[],
  opts: BuildMusicalContextOptions = {},
): MusicalContext {
  const key = estimateKey(notes, { keyHint: opts.keyHint });
  const phraseKeys = phrases.map((phrase) => {
    const inPhrase = notes.filter((n) => n.startSeconds >= phrase.start && n.startSeconds < phrase.end);
    return estimateKey(inPhrase, { keyHint: opts.keyHint });
  });

  const figures = detectFigures(notes, phrases, key, phraseKeys);
  const contrasts = buildKindContrasts(notes, figures);
  const assessments = assessFigures(notes, figures, contrasts);

  return { key, phraseKeys, figures, contrasts, assessments };
}

/** Display helper shared by copy generators. */
export function figureKindLabel(kind: FigureKind): string {
  return KIND_LABELS[kind];
}

export { midiToNoteName };
