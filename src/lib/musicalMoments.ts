import type { AnalysisResult } from '../types/analysis';
import type { PracticeEvidence, PracticeEvidenceKind } from './practiceEvidence';
import type { PhraseFeatures } from './phraseFeatures';
import type {
  FigureAssessment,
  KindContrast,
  MusicalContext,
  MusicalFigure,
} from './musicalContext';

// ─────────────────────────────────────────────────────────────
// Musical moments
//
// Turns L7.5 figures into the issues the rest of the app already speaks:
// PracticeEvidence. The difference from every other evidence builder is what
// the copy can say. A pitch-class issue can only report a tally — "C# was flat
// in 4 of 9 attempts". A moment reports a diagnosis:
//
//   what happened : "The arpeggio in G at 0:42 kept landing under the third."
//   contrast      : "Your arpeggios averaged 24¢ worse than the rest of the take."
//
// The contrast is the load-bearing sentence, and it is only ever present when
// buildKindContrasts found a real, sampled difference — the app does not get to
// imply causation it did not measure.
//
// Evidence ids here are deliberately CONTENT-based and timestamp-free
// (`figure_crossing:D-A`, not `figure_crossing:41.8s`) so the same problem in
// the same piece is the same issue next week. That identity is what per-piece
// progress is built on; breaking it silently breaks "did it help".
// ─────────────────────────────────────────────────────────────

export type MomentKind = Extract<
  PracticeEvidenceKind,
  | 'figure_intonation'
  | 'figure_crossing'
  | 'figure_shift'
  | 'figure_speed'
  | 'figure_ornament'
  | 'figure_sequence'
  | 'phrase'
>;

/** Above this a passage is fast enough that speed, not aim, is the problem. */
const FAST_NOTES_PER_SECOND = 4;
/** A figure has to be at least this far off to be worth a drill of its own. */
const MIN_MOMENT_CENTS = 12;
/** Cap on moments per session so the plan builder still has room to choose. */
const MAX_MOMENTS = 6;

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function direction(signedCents: number): string {
  return signedCents < 0 ? 'flat' : 'sharp';
}

function pieceSuffix(session: AnalysisResult): string {
  return session.piece?.title ? ` in ${session.piece.title}` : '';
}

/** The italic comparison line, or '' when no honest comparison exists. */
export function contrastSentence(contrast: KindContrast | null): string {
  if (!contrast?.significant) return '';
  return `Your ${contrast.label} averaged ${Math.round(contrast.deltaCents)}¢ further off than the rest of the take (${contrast.inNoteCount} notes vs ${contrast.outNoteCount}).`;
}

// ── Per-kind identity, title, and prose ──────────────────────

interface MomentShape {
  kind: MomentKind;
  /** Content-based, timestamp-free. See the header note. */
  id: string;
  title: string;
  whatHappened: string;
}

function shapeFor(
  figure: MusicalFigure,
  assessment: FigureAssessment,
  session: AnalysisResult,
): MomentShape | null {
  const at = formatTime(figure.startSeconds);
  const off = Math.round(assessment.meanAbsCents);
  const dir = direction(assessment.meanSignedCents);
  const keyName = figure.localKey?.name;

  switch (figure.kind) {
    case 'crossing_run': {
      // The pair the player actually crossed most, which is also the pair the
      // exercise will drill. These must agree: telling someone their G→D
      // crossings drifted and then handing them a G→E drill is incoherent.
      const pair = dominantPair(figure);
      if (!pair) return null;
      const readable = pair.replace('-', '→');
      return {
        kind: 'figure_crossing',
        id: `figure_crossing:${pair}`,
        title: `${readable} crossings`,
        whatHappened: `At ${at} you crossed ${readable} ${figure.noteIndices.length} notes in a row and the pitch drifted ${dir} by about ${off}¢${pieceSuffix(session)}.`,
      };
    }
    case 'shift': {
      const shift = figure.shift;
      if (!shift) return null;
      return {
        kind: 'figure_shift',
        id: `figure_shift:${shift.string}:${shift.fromPosition}-${shift.toPosition}`,
        title: `${shift.fromPosition}→${shift.toPosition} shift, ${shift.string} string`,
        whatHappened: `The shift from ${shift.fromPosition} to ${shift.toPosition} position on the ${shift.string} string at ${at} landed ${dir} by about ${off}¢.`,
      };
    }
    case 'arpeggio': {
      const chord = figure.chord;
      if (!chord) return null;
      return {
        kind: 'figure_intonation',
        id: `figure_intonation:arpeggio:${chord.label.replace(/\s+/g, '-')}`,
        title: `${chord.label} arpeggio`,
        whatHappened: `The ${chord.label} arpeggio at ${at} kept landing ${dir}${keyName ? `, and the passage sits in ${keyName}` : ''} — the chord tones aren't yet in the ear.`,
      };
    }
    case 'scalar_run': {
      const fast = figure.notesPerSecond >= FAST_NOTES_PER_SECOND;
      if (fast) {
        return {
          kind: 'figure_speed',
          id: `figure_speed:${figure.strings.join('-')}${keyName ? `:${keyName.replace(/\s+/g, '-')}` : ''}`,
          title: `Fast passage${keyName ? ` in ${keyName}` : ''}`,
          whatHappened: `The run at ${at} moves at about ${figure.notesPerSecond.toFixed(1)} notes a second, and at that speed the notes went ${dir} by around ${off}¢ — the hands are losing each other, not the ear.`,
        };
      }
      return {
        kind: 'figure_intonation',
        id: `figure_intonation:scalar${keyName ? `:${keyName.replace(/\s+/g, '-')}` : ''}`,
        title: `Stepwise passage${keyName ? ` in ${keyName}` : ''}`,
        whatHappened: `The stepwise passage at ${at}${keyName ? ` in ${keyName}` : ''} ran ${dir} by about ${off}¢ — the hand frame is drifting between neighbouring fingers.`,
      };
    }
    case 'ornament': {
      const trill = figure.trill;
      if (!trill) return null;
      return {
        kind: 'figure_ornament',
        id: `figure_ornament:${trill.lowerMidi}-${trill.upperMidi}`,
        title: 'Ornament evenness',
        whatHappened: `The ornament at ${at} alternated ${trill.alternations} times at about ${trill.ratePerSecond.toFixed(1)} notes a second, and the pitch smeared ${dir} by roughly ${off}¢.`,
      };
    }
    case 'sequence': {
      return {
        kind: 'figure_sequence',
        id: `figure_sequence:${figure.intervalContour.join(',')}`,
        title: 'Recurring figure',
        whatHappened: `This ${figure.noteIndices.length}-note figure comes back ${figure.repetitions ?? 2} times in the take, and each time it went ${dir} by about ${off}¢ — one shape, repeated, that isn't landing.`,
      };
    }
    // Held notes are already covered, and better, by intonation-stability
    // evidence (which measures drift within the note rather than its average).
    // Emitting a moment here would just duplicate that drill.
    case 'sustained':
    default:
      return null;
  }
}

/**
 * The string pair a crossing figure is really about.
 *
 * Falls back to adjacent strings from the touched set only when the pair list
 * is missing (older persisted evidence) — and never invents a pair spanning
 * strings the player didn't cross between.
 */
function dominantPair(figure: MusicalFigure): string | null {
  if (figure.stringPairs && figure.stringPairs.length > 0) return figure.stringPairs[0];
  if (figure.strings.length < 2) return null;
  const order = ['G', 'D', 'A', 'E'];
  const sorted = [...figure.strings].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return `${sorted[0]}-${sorted[1]}`;
}

function priorityFor(assessment: FigureAssessment): number {
  const severityBoost = assessment.severity === 'significant' ? 18 : assessment.severity === 'moderate' ? 10 : 4;
  const contrastBoost = assessment.contrast?.significant
    ? 12 + Math.min(assessment.contrast.deltaCents, 25)
    : 0;
  return 92 + severityBoost + contrastBoost + Math.min(assessment.meanAbsCents, 20);
}

// ── Figure moments ───────────────────────────────────────────

export function buildFigureMoments(
  context: MusicalContext,
  session: AnalysisResult,
): PracticeEvidence[] {
  const figureById = new Map(context.figures.map((f) => [f.id, f]));
  const byId = new Map<string, PracticeEvidence>();

  for (const assessment of context.assessments) {
    if (byId.size >= MAX_MOMENTS) break;
    // A figure that played in tune is not a problem, however interesting its
    // shape. Only a figure that also carries a measured contrast may speak
    // below the absolute threshold — the comparison is its own evidence.
    if (assessment.meanAbsCents < MIN_MOMENT_CENTS && !assessment.contrast?.significant) continue;

    const figure = figureById.get(assessment.figureId);
    if (!figure) continue;
    const shape = shapeFor(figure, assessment, session);
    if (!shape) continue;

    const contrast = contrastSentence(assessment.contrast);
    const evidence: PracticeEvidence = {
      id: shape.id,
      kind: shape.kind,
      metricKey: 'pitchAccuracy',
      title: shape.title,
      reason: shape.whatHappened,
      contrast,
      evidenceSummary: `${figure.noteNames.join(' ')} · average ${Math.round(assessment.meanAbsCents)}¢ ${direction(assessment.meanSignedCents)}, ${Math.round(assessment.inTuneRate * 100)}% in tune.`,
      priority: priorityFor(assessment),
      confidence: assessment.confidence,
      supportsLive: true,
      requiresMic: true,
      requiresCamera: false,
      measurementAvailable: true,
      sourceSessionId: session.sessionId,
      sourceRecordedAt: session.recordedAt,
      sessionCount: 1,
      target: {
        metricKey: 'pitchAccuracy',
        noteName: assessment.worstNoteName ?? undefined,
        string: figure.strings[0],
        startSeconds: figure.startSeconds,
        endSeconds: figure.endSeconds,
        phraseId: figure.phraseId ?? undefined,
        tendency: direction(assessment.meanSignedCents),
        figureKind: figure.kind,
        keyName: figure.localKey?.name,
        chordLabel: figure.chord?.label,
        strings: figure.strings,
        stringPairs: figure.stringPairs,
        fromPosition: figure.shift?.fromPosition,
        toPosition: figure.shift?.toPosition,
        finger: figure.shift?.finger,
        notesPerSecond: figure.notesPerSecond,
        midiSequence: figure.midiNotes,
        noteSequence: figure.noteNames,
        trillPair: figure.trill ? [figure.trill.lowerMidi, figure.trill.upperMidi] : undefined,
      },
    };

    // Two occurrences of the same problem are one issue; keep the worse one.
    const existing = byId.get(evidence.id);
    if (!existing || evidence.priority > existing.priority) byId.set(evidence.id, evidence);
  }

  return [...byId.values()];
}

// ── Phrase-shape moments ─────────────────────────────────────

/** A phrase this flat is being played, not shaped. */
const FLAT_PHRASE_MIN_NOTES = 6;

/**
 * Fills the `phrase` evidence kind, which the union has declared since L9 was
 * written but nothing ever emitted. Dynamics evidence used to arrive only as a
 * metric score, which is why the plan could never say *which* phrase went flat.
 */
export function buildPhraseMoments(session: AnalysisResult): PracticeEvidence[] {
  const features: PhraseFeatures[] = session.phraseFeatures ?? [];
  if (features.length < 2) return [];

  const flat = features.filter((f) => f.energy_shape === 'flat' && f.note_count >= FLAT_PHRASE_MIN_NOTES);
  // One flat phrase in a piece is a choice; most of them is a habit.
  if (flat.length === 0 || flat.length / features.length < 0.5) return [];

  const worst = flat.reduce((a, b) => (b.note_count > a.note_count ? b : a));
  return [{
    id: 'phrase:flat_shape',
    kind: 'phrase',
    metricKey: 'dynamicControl',
    title: 'Phrase shape',
    reason: `${flat.length} of your ${features.length} phrases came out flat — same volume from first note to last${pieceSuffix(session)}. The longest one starts at ${formatTime(worst.start_t)}.`,
    contrast: `${Math.round((flat.length / features.length) * 100)}% of phrases had no rise or fall at all.`,
    evidenceSummary: `${flat.length}/${features.length} phrases classified flat; longest ${worst.note_count} notes.`,
    priority: 84 + Math.min(flat.length * 3, 15),
    confidence: clamp01(features.length / 6),
    supportsLive: true,
    requiresMic: true,
    requiresCamera: false,
    measurementAvailable: true,
    sourceSessionId: session.sessionId,
    sourceRecordedAt: session.recordedAt,
    sessionCount: 1,
    target: {
      metricKey: 'dynamicControl',
      startSeconds: worst.start_t,
      endSeconds: worst.end_t,
      phraseId: worst.id,
      figureKind: 'phrase',
    },
  }];
}

/** Every musical moment for one session. */
export function buildMusicalMoments(session: AnalysisResult): PracticeEvidence[] {
  const context = session.musicalContext;
  return [
    ...(context ? buildFigureMoments(context, session) : []),
    ...buildPhraseMoments(session),
  ];
}
