/**
 * Musical moment tests — figures become evidence with stable, content-based ids.
 *
 *   node --experimental-strip-types --loader ./test/ts-resolver.mjs test/musicalMoments.test.ts
 */

import { buildMusicalMoments, contrastSentence } from '../src/lib/musicalMoments';
import {
  sessionEvidenceFor,
  withoutStaleEvidence,
  EVIDENCE_VERSION,
  type PracticeEvidence,
} from '../src/lib/practiceEvidence';
import { buildMusicalContext } from '../src/lib/musicalContext';
import type { NoteEvent, Phrase } from '../src/lib/noteFusion';
import type { AnalysisResult } from '../src/types/analysis';
import type { PhraseFeatures } from '../src/lib/phraseFeatures';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const nameOf = (midi: number) => `${NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
const stringOf = (midi: number): NoteEvent['string'] =>
  midi >= 76 ? 'E' : midi >= 69 ? 'A' : midi >= 62 ? 'D' : 'G';

function notesFrom(
  midis: number[],
  over: (midi: number, i: number) => Partial<NoteEvent> = () => ({}),
): NoteEvent[] {
  let clock = 0;
  return midis.map((midi, i) => {
    const patch = over(midi, i);
    const duration = patch.durationSeconds ?? 0.4;
    const start = clock;
    clock += duration;
    return {
      startSeconds: start, endSeconds: start + duration, durationSeconds: duration,
      pitchHz: 440 * 2 ** ((midi - 69) / 12), noteName: nameOf(midi), string: stringOf(midi),
      inferredFinger: 1, positionGroup: 'first', centsDeviation: 0, absCentsDeviation: 0,
      inTune: true, fundamentalRatio: 0.8, dynamicLevel: 0.5, bowContactPoint: null,
      bowAngle: null, bowDistanceFromBridge: null, bowZone: null, wristCollapsed: null,
      shoulderRaised: null, distanceFromCrossing: null, phrasePosition: 0,
      phraseDurationSeconds: 4, ...patch,
    } satisfies NoteEvent;
  });
}

function phrasesFor(notes: NoteEvent[]): Phrase[] {
  if (notes.length === 0) return [];
  const start = notes[0].startSeconds;
  const end = notes[notes.length - 1].endSeconds;
  return [{ start, end, duration: end - start }];
}

function sessionFrom(
  notes: NoteEvent[],
  over: Partial<AnalysisResult> = {},
  keyHint?: string,
): AnalysisResult {
  return {
    sessionId: 'sess-1', userId: 'u', instrument: 'violin', durationSeconds: 30,
    recordedAt: '2026-08-08T10:00:00.000Z', overallScore: 70,
    metrics: [], audioMetrics: [], videoMetrics: [],
    noteEvents: notes,
    musicalContext: buildMusicalContext(notes, phrasesFor(notes), { keyHint }),
    ...over,
  } as AnalysisResult;
}

/** A take whose D→A crossings are badly out and whose other notes are fine. */
function crossingSession(sessionId = 'sess-1', pieceTitle?: string): AnalysisResult {
  const crossingMidis = [62, 71, 64, 73, 66, 74, 68, 76, 69, 78];
  const calmMidis = Array.from({ length: 14 }, (_, i) => 62 + (i % 3));
  const notes = notesFrom([...crossingMidis, ...calmMidis], (midi, i) => {
    const crossing = i < crossingMidis.length;
    return {
      string: crossing ? (i % 2 === 0 ? 'D' : 'A') : 'D',
      centsDeviation: crossing ? -32 : -4,
      absCentsDeviation: crossing ? 32 : 4,
      inTune: !crossing,
    };
  });
  return sessionFrom(notes, {
    sessionId,
    piece: pieceTitle ? { id: 'p1', title: pieceTitle, source: 'manual' } : undefined,
  });
}

// ─────────────────────────────────────────────────────────────
console.log('contrastSentence');
{
  check('absent contrast is silent', contrastSentence(null) === '');
  check('insignificant contrast is silent', contrastSentence({
    kind: 'crossing_run', label: 'crossing runs', inMeanAbsCents: 10, inNoteCount: 10,
    outMeanAbsCents: 9, outNoteCount: 10, deltaCents: 1, effectSize: 0.05, significant: false,
  }) === '');
  const line = contrastSentence({
    kind: 'crossing_run', label: 'crossing runs', inMeanAbsCents: 30, inNoteCount: 10,
    outMeanAbsCents: 6, outNoteCount: 14, deltaCents: 24, effectSize: 1.4, significant: true,
  });
  check('significant contrast names the gap and the sample',
    line.includes('24¢') && line.includes('crossing runs') && line.includes('10 notes vs 14'), line);
}

// ─────────────────────────────────────────────────────────────
console.log('buildMusicalMoments — crossing');
{
  const moments = buildMusicalMoments(crossingSession());
  const crossing = moments.find((m) => m.kind === 'figure_crossing');
  check('crossing moment produced', crossing != null, moments.map((m) => m.kind).join(','));
  // Pitch order, not alphabetical: a D↔A crossing reads "D-A" so the label
  // matches how a player thinks about it (low string first).
  check('id is content-based, not timestamped',
    crossing?.id === 'figure_crossing:D-A', crossing?.id);
  check('reason is a diagnosis, not a metric name',
    (crossing?.reason ?? '').includes('crossed') && /\d+¢/.test(crossing?.reason ?? ''), crossing?.reason);
  check('contrast present when measured', (crossing?.contrast ?? '').length > 0, crossing?.contrast);
  check('target carries the strings', crossing?.target.strings?.includes('A') === true);
  check('target carries the actual notes',
    (crossing?.target.noteSequence?.length ?? 0) >= 3, JSON.stringify(crossing?.target.noteSequence));
  check('target carries a window to replay',
    crossing?.target.startSeconds != null && crossing?.target.endSeconds != null);
  check('measurement is available', crossing?.measurementAvailable === true);
}

// ─────────────────────────────────────────────────────────────
console.log('the crossing named is a crossing that happened');
{
  // A passage over G, D and A crosses G-D and D-A. It never crosses G-A, and
  // the drill must not invent one from the outer edges of the strings touched
  // — that produced a "G-E crossing wave" for playing that only went G to D.
  const midis = [55, 62, 57, 64, 59, 66, 60, 67, 71, 74];
  const notes = notesFrom(midis, (midi, i) => ({
    // G, D alternating, then up onto the A string at the end.
    string: i >= 8 ? 'A' : (i % 2 === 0 ? 'G' : 'D'),
    centsDeviation: -30, absCentsDeviation: 30, inTune: false,
  }));
  const calm = notesFrom(Array.from({ length: 14 }, (_, i) => 62 + (i % 3)), () => ({
    string: 'D', centsDeviation: -3, absCentsDeviation: 3, inTune: true,
  }));
  const all = [...notes, ...calm].map((n, i) => ({ ...n, startSeconds: i * 0.4, endSeconds: i * 0.4 + 0.4 }));

  const moment = buildMusicalMoments(sessionFrom(all)).find((m) => m.kind === 'figure_crossing');
  check('a crossing moment is produced', moment != null);

  const CROSSED = ['G-D', 'D-A'];
  check('the id names a pair that was actually crossed',
    CROSSED.some((p) => moment?.id === `figure_crossing:${p}`), moment?.id);
  check('the title names the same pair',
    CROSSED.some((p) => moment?.title.startsWith(p.replace('-', '→'))), moment?.title);
  check('the reason names the same pair',
    CROSSED.some((p) => moment?.reason.includes(p.replace('-', '→'))), moment?.reason);
  check('it never claims a crossing that did not happen',
    !/G→A|G→E|D→E/.test(`${moment?.title} ${moment?.reason}`),
    `${moment?.title} | ${moment?.reason}`);

  // The target is what the exercise reads, so it must agree with the prose.
  check('the target carries the real pairs',
    (moment?.target.stringPairs ?? []).every((p) => CROSSED.includes(p)),
    JSON.stringify(moment?.target.stringPairs));
  check('the exercise would drill the pair the prose named',
    moment?.target.stringPairs?.[0] === moment?.id.replace('figure_crossing:', ''),
    `${moment?.target.stringPairs?.[0]} vs ${moment?.id}`);
  check('pairs read low string first',
    (moment?.target.stringPairs ?? []).every((p) => {
      const order = ['G', 'D', 'A', 'E'];
      const [a, b] = p.split('-');
      return order.indexOf(a) < order.indexOf(b);
    }), JSON.stringify(moment?.target.stringPairs));
}

// ─────────────────────────────────────────────────────────────
console.log('issue identity is stable across sessions');
{
  const a = buildMusicalMoments(crossingSession('sess-1', 'Gavotte'));
  const b = buildMusicalMoments(crossingSession('sess-2', 'Gavotte'));
  const aKey = a.find((m) => m.kind === 'figure_crossing')?.id;
  const bKey = b.find((m) => m.kind === 'figure_crossing')?.id;
  check('same problem yields the same id across sessions', aKey != null && aKey === bKey, `${aKey} vs ${bKey}`);
  check('source session is still recorded per occurrence',
    a.find((m) => m.kind === 'figure_crossing')?.sourceSessionId === 'sess-1'
    && b.find((m) => m.kind === 'figure_crossing')?.sourceSessionId === 'sess-2');
  check('piece title reaches the prose',
    (a.find((m) => m.kind === 'figure_crossing')?.reason ?? '').includes('Gavotte'));
}

// ─────────────────────────────────────────────────────────────
console.log('buildMusicalMoments — arpeggio names its harmony');
{
  // G major arpeggio played consistently under pitch, twice, plus calm notes.
  const arp = [55, 59, 62, 67, 62, 59, 55, 59, 62, 67];
  const calm = Array.from({ length: 12 }, (_, i) => 62 + (i % 2));
  const notes = notesFrom([...arp, ...calm], (midi, i) => ({
    centsDeviation: i < arp.length ? -28 : -3,
    absCentsDeviation: i < arp.length ? 28 : 3,
    inTune: i >= arp.length,
  }));
  const moments = buildMusicalMoments(sessionFrom(notes, {}, 'G major'));
  const arpeggio = moments.find((m) => m.kind === 'figure_intonation');
  check('arpeggio moment produced', arpeggio != null, moments.map((m) => m.kind).join(','));
  check('id names the chord', arpeggio?.id.includes('G-major') === true, arpeggio?.id);
  check('target carries the chord label', arpeggio?.target.chordLabel === 'G major', arpeggio?.target.chordLabel);
  check('target carries the key for the generator',
    arpeggio?.target.keyName === 'G major', arpeggio?.target.keyName);
}

// ─────────────────────────────────────────────────────────────
console.log('buildMusicalMoments — clean playing says nothing');
{
  const clean = notesFrom(
    [62, 71, 64, 73, 66, 74, 68, 76, ...Array.from({ length: 14 }, (_, i) => 62 + (i % 3))],
    (midi, i) => ({
      string: i < 8 ? (i % 2 === 0 ? 'D' : 'A') : 'D',
      centsDeviation: 3, absCentsDeviation: 3, inTune: true,
    }),
  );
  const moments = buildMusicalMoments(sessionFrom(clean));
  check('no moments from an in-tune take', moments.length === 0,
    moments.map((m) => `${m.kind}:${m.evidenceSummary}`).join(' | '));
}

// ─────────────────────────────────────────────────────────────
console.log('buildMusicalMoments — no musical context is safe');
{
  const bare = {
    sessionId: 's', userId: 'u', instrument: 'violin', durationSeconds: 10,
    recordedAt: '2026-08-08T10:00:00.000Z', overallScore: 70,
    metrics: [], audioMetrics: [], videoMetrics: [],
  } as AnalysisResult;
  check('missing context yields no moments', buildMusicalMoments(bare).length === 0);
}

// ─────────────────────────────────────────────────────────────
console.log('phrase-shape moments');
{
  function phraseFeature(id: number, shape: PhraseFeatures['energy_shape'], noteCount: number): PhraseFeatures {
    return {
      id, start_t: id * 5, end_t: id * 5 + 4, energy_shape: shape, peak_location: 0.5,
      bow_usage: null,
      intonation: { mean_error_cents: 3, variance: 4, stability: 'high' },
      vibrato_consistency: 0, timbre_variation: 10, note_count: noteCount, slur_count: 0,
    };
  }

  const mostlyFlat = buildMusicalMoments(sessionFrom([], {
    phraseFeatures: [
      phraseFeature(0, 'flat', 9), phraseFeature(1, 'flat', 12),
      phraseFeature(2, 'flat', 8), phraseFeature(3, 'arch', 10),
    ],
  }));
  const phrase = mostlyFlat.find((m) => m.kind === 'phrase');
  check('flat phrases produce a phrase moment', phrase != null);
  check('phrase moment targets dynamics', phrase?.metricKey === 'dynamicControl');
  check('phrase moment id is stable', phrase?.id === 'phrase:flat_shape');
  check('phrase moment points at the longest offender', phrase?.target.phraseId === 1, String(phrase?.target.phraseId));

  const mostlyShaped = buildMusicalMoments(sessionFrom([], {
    phraseFeatures: [
      phraseFeature(0, 'arch', 9), phraseFeature(1, 'late_peak', 12),
      phraseFeature(2, 'flat', 8), phraseFeature(3, 'arch', 10),
    ],
  }));
  check('one flat phrase is a choice, not a habit',
    !mostlyShaped.some((m) => m.kind === 'phrase'));

  check('too few phrases to judge',
    !buildMusicalMoments(sessionFrom([], { phraseFeatures: [phraseFeature(0, 'flat', 9)] }))
      .some((m) => m.kind === 'phrase'));
}

// ─────────────────────────────────────────────────────────────
console.log('frozen evidence from an older analysis is not trusted');
{
  const session = crossingSession();
  const correct = buildMusicalMoments(session).find((m) => m.kind === 'figure_crossing');

  // A session analysed before the crossing fix froze a finding naming a pair
  // the player never crossed. Re-opening the results must not serve it back.
  const stale: PracticeEvidence = {
    ...correct!,
    id: 'figure_crossing:G-E',
    title: 'G→E crossings',
    reason: 'At 0:00 you crossed G→E and the pitch drifted flat.',
  };
  const staleSession = { ...session, sessionEvidence: [stale], evidenceVersion: 1 } as AnalysisResult;

  const served = sessionEvidenceFor(staleSession);
  check('stale evidence is recomputed, not served',
    !served.some((e) => e.id === 'figure_crossing:G-E'),
    JSON.stringify(served.map((e) => e.id)));
  check('and the recomputed finding is correct',
    served.some((e) => e.id === correct!.id), JSON.stringify(served.map((e) => e.id)));

  // Current-version evidence is trusted as-is — that freeze is what keeps the
  // results screen and the practice plan describing the same issues.
  const current = { ...session, sessionEvidence: [stale], evidenceVersion: EVIDENCE_VERSION } as AnalysisResult;
  check('current-version evidence is used as frozen',
    sessionEvidenceFor(current).some((e) => e.id === 'figure_crossing:G-E'));

  // Nothing to recompute from: the stale copy beats an empty screen.
  const bare = { sessionEvidence: [stale], evidenceVersion: 1 } as AnalysisResult;
  check('unrecomputable stale evidence is kept rather than lost',
    sessionEvidenceFor(bare).length === 1);
}

// ─────────────────────────────────────────────────────────────
console.log('history evidence that cannot be recomputed drops stale findings');
{
  const base = buildMusicalMoments(crossingSession());
  const crossing = base.find((m) => m.kind === 'figure_crossing')!;
  const pitchIssue: PracticeEvidence = { ...crossing, id: 'pitch_note:C#', kind: 'pitch_note' };

  const kept = withoutStaleEvidence([crossing, pitchIssue], EVIDENCE_VERSION);
  check('current evidence is untouched', kept.length === 2);

  const pruned = withoutStaleEvidence([crossing, pitchIssue], 1);
  check('a stale figure finding is dropped',
    !pruned.some((e) => e.kind === 'figure_crossing'), JSON.stringify(pruned.map((e) => e.kind)));
  check('kinds that did not change are kept',
    pruned.some((e) => e.kind === 'pitch_note'), JSON.stringify(pruned.map((e) => e.kind)));
  check('unstamped legacy evidence is treated as stale',
    withoutStaleEvidence([crossing], undefined).length === 0);
}

console.log(failures === 0 ? '\nAll musical moment tests passed.' : `\n${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
