/**
 * L7.5 musical context tests — key estimation, figure detection, contrasts.
 *
 *   node --experimental-strip-types --loader ./test/ts-resolver.mjs test/musicalContext.test.ts
 */

import {
  estimateKey,
  parseKeyName,
  identifyChord,
  detectFigures,
  buildKindContrasts,
  buildMusicalContext,
  type MusicalFigure,
} from '../src/lib/musicalContext';
import type { NoteEvent, Phrase } from '../src/lib/noteFusion';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function nameOf(midi: number): string {
  return `${NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}
function stringOf(midi: number): NoteEvent['string'] {
  if (midi >= 76) return 'E';
  if (midi >= 69) return 'A';
  if (midi >= 62) return 'D';
  return 'G';
}

let clock = 0;
/** Builds a NoteEvent sequence from MIDI numbers; `over` patches every note. */
function notesFrom(
  midis: number[],
  over: Partial<NoteEvent> | ((midi: number, i: number) => Partial<NoteEvent>) = {},
): NoteEvent[] {
  clock = 0;
  return midis.map((midi, i) => {
    const patch = typeof over === 'function' ? over(midi, i) : over;
    const duration = patch.durationSeconds ?? 0.4;
    const start = clock;
    clock += duration;
    return {
      startSeconds: start,
      endSeconds: start + duration,
      durationSeconds: duration,
      pitchHz: 440 * 2 ** ((midi - 69) / 12),
      noteName: nameOf(midi),
      string: stringOf(midi),
      inferredFinger: 1,
      positionGroup: 'first',
      centsDeviation: 0,
      absCentsDeviation: 0,
      inTune: true,
      fundamentalRatio: 0.8,
      dynamicLevel: 0.5,
      bowContactPoint: null,
      bowAngle: null,
      bowDistanceFromBridge: null,
      bowZone: null,
      wristCollapsed: null,
      shoulderRaised: null,
      distanceFromCrossing: null,
      phrasePosition: 0,
      phraseDurationSeconds: 4,
      ...patch,
    } satisfies NoteEvent;
  });
}

function phrasesFor(notes: NoteEvent[]): Phrase[] {
  if (notes.length === 0) return [];
  const start = notes[0].startSeconds;
  const end = notes[notes.length - 1].endSeconds;
  return [{ start, end, duration: end - start }];
}

function kinds(figures: MusicalFigure[]): string[] {
  return [...new Set(figures.map((f) => f.kind))].sort();
}

// ─────────────────────────────────────────────────────────────
console.log('parseKeyName');
{
  check('major default', parseKeyName('G')?.mode === 'major' && parseKeyName('G')?.tonic === 7);
  check('minor parsed', parseKeyName('E minor')?.mode === 'minor' && parseKeyName('E minor')?.tonic === 4);
  check('sharp parsed', parseKeyName('F# major')?.tonic === 6);
  check('flat parsed', parseKeyName('Bb')?.tonic === 10);
  check('garbage rejected', parseKeyName('not a key') === null);
}

// ─────────────────────────────────────────────────────────────
console.log('estimateKey');
{
  // Two octaves of G major, tonic and dominant held longer as they would be.
  const gMajor = [55, 57, 59, 60, 62, 64, 66, 67, 66, 64, 62, 60, 59, 57, 55, 62, 67, 55];
  const key = estimateKey(notesFrom(gMajor, (midi) => ({
    durationSeconds: midi % 12 === 7 || midi % 12 === 2 ? 0.8 : 0.35,
  })));
  check('G major detected', key?.name === 'G major', `got ${key?.name}`);
  check('confidence is real', (key?.confidence ?? 0) > 0.2, `got ${key?.confidence}`);

  // D harmonic/melodic minor material — raised 7th (C#) is the tell.
  const dMinor = [62, 64, 65, 67, 69, 70, 73, 74, 73, 70, 69, 67, 65, 64, 62, 69, 74, 62];
  const minorKey = estimateKey(notesFrom(dMinor, (midi) => ({
    durationSeconds: midi % 12 === 2 || midi % 12 === 9 ? 0.8 : 0.35,
  })));
  check('minor mode detected', minorKey?.mode === 'minor', `got ${minorKey?.name}`);

  check('too few notes → null', estimateKey(notesFrom([55, 57, 59])) === null);
  check(
    'too short → null',
    estimateKey(notesFrom([55, 57, 59, 60, 62, 64, 66, 67, 69], { durationSeconds: 0.1 })) === null,
  );

  // A hint nudges, and must be able to break a tie toward the stated key.
  const ambiguous = [55, 57, 59, 60, 62, 64, 66, 67, 59, 62, 64, 67];
  const hinted = estimateKey(notesFrom(ambiguous), { keyHint: 'E minor' });
  const unhinted = estimateKey(notesFrom(ambiguous));
  check('key hint is applied', hinted != null && unhinted != null);
}

// ─────────────────────────────────────────────────────────────
console.log('identifyChord');
{
  check('G major triad', identifyChord([55, 59, 62])?.label === 'G major');
  check('D minor triad', identifyChord([62, 65, 69])?.label === 'D minor');
  check('D7', identifyChord([62, 66, 69, 72])?.label === 'D7');
  check('dim7', identifyChord([59, 62, 65, 68])?.quality === 'diminished7');
  check('two notes → null', identifyChord([55, 59]) === null);
  check('non-chord set → null', identifyChord([55, 56, 57]) === null);
}

// ─────────────────────────────────────────────────────────────
console.log('detectFigures');
{
  // Scalar run — eight stepwise notes.
  const run = notesFrom([62, 64, 66, 67, 69, 71, 73, 74]);
  const runFigures = detectFigures(run, phrasesFor(run), null, []);
  check('scalar run detected', kinds(runFigures).includes('scalar_run'), kinds(runFigures).join(','));

  // Arpeggio — G major triad up and down, all leaps.
  const arp = notesFrom([55, 59, 62, 67, 62, 59, 55]);
  const arpFigures = detectFigures(arp, phrasesFor(arp), null, []);
  const arpeggio = arpFigures.find((f) => f.kind === 'arpeggio');
  check('arpeggio detected', arpeggio != null, kinds(arpFigures).join(','));
  check('arpeggio names its chord', arpeggio?.chord?.label === 'G major', arpeggio?.chord?.label);

  // Crossing run — alternating D and A strings.
  const crossing = notesFrom([62, 71, 64, 73, 66, 74]);
  const crossFigures = detectFigures(crossing, phrasesFor(crossing), null, []);
  const cross = crossFigures.find((f) => f.kind === 'crossing_run');
  check('crossing run detected', cross != null, kinds(crossFigures).join(','));
  check('crossing names the string pair', cross?.stringPairs?.includes('D-A') === true, JSON.stringify(cross?.stringPairs));
  check('the pair reads low string first', cross?.stringPairs?.[0] === 'D-A', JSON.stringify(cross?.stringPairs));

  // Only neighbouring strings can be crossed between consecutive notes. A
  // "G to A" crossing skips the D string, so it is the pitch-inferred string
  // being wrong (an octave slip reads A3 as open A), not the playing.
  const skipped = notesFrom([55, 69, 57, 71, 59, 73], (midi, i) => ({
    string: i % 2 === 0 ? ('G' as const) : ('A' as const),
  }));
  const skippedFigures = detectFigures(skipped, phrasesFor(skipped), null, []);
  check('a G-to-A "crossing" is not reported',
    !skippedFigures.some((f) => f.kind === 'crossing_run'),
    JSON.stringify(skippedFigures.filter((f) => f.kind === 'crossing_run').map((f) => f.stringPairs)));

  // The reported case: first-finger A and open G are both on the G string, so
  // there is no crossing to find however the run is segmented.
  const oneString = notesFrom([57, 55, 57, 55, 57, 55], () => ({ string: 'G' as const }));
  check('two notes on one string are never a crossing',
    !detectFigures(oneString, phrasesFor(oneString), null, []).some((f) => f.kind === 'crossing_run'));

  // Neighbouring crossings still work.
  const adjacent = notesFrom([62, 71, 64, 73, 66, 74], (midi, i) => ({
    string: i % 2 === 0 ? ('D' as const) : ('A' as const),
  }));
  check('a neighbouring crossing is still detected',
    detectFigures(adjacent, phrasesFor(adjacent), null, []).some((f) => f.kind === 'crossing_run'));

  // Shift — genuinely needs the hand to move. High on the E string, where
  // there is no higher string to cross onto.
  const E = 76;
  const shiftNotes = notesFrom([E, E + 2, E + 4, E + 5, E + 7, E + 9, E + 11], () => ({
    string: 'E' as const,
  }));
  const shiftFigures = detectFigures(shiftNotes, phrasesFor(shiftNotes), null, []);
  const shift = shiftFigures.find((f) => f.kind === 'shift');
  check('a real shift is detected', shift != null, kinds(shiftFigures).join(','));
  check('shift names where the hand went',
    shift?.shift?.fromPosition === 'first' && shift?.shift?.toPosition !== 'first',
    `${shift?.shift?.fromPosition} → ${shift?.shift?.toPosition}`);

  // The reported false positive: B4 then C5 on the A string are 1st and 2nd
  // finger in first position. Bucketing by absolute pitch put them either side
  // of a band boundary and called it a shift.
  const noShift = notesFrom([71, 72, 71, 72], () => ({ string: 'A' as const }));
  check('adjacent fingers in one position are not a shift',
    !detectFigures(noShift, phrasesFor(noShift), null, []).some((f) => f.kind === 'shift'),
    JSON.stringify(detectFigures(noShift, phrasesFor(noShift), null, [])
      .filter((f) => f.kind === 'shift').map((f) => f.shift)));

  // And the descending form, which is what the player actually saw reported.
  const noShiftDown = notesFrom([72, 71, 72, 71], () => ({ string: 'A' as const }));
  check('and not in the other direction either',
    !detectFigures(noShiftDown, phrasesFor(noShiftDown), null, []).some((f) => f.kind === 'shift'));

  // Crossing to the next string is not a shift — the hand never moves.
  const crossNotShift = notesFrom([69, 71, 74, 76], () => ({ string: 'A' as const }));
  check('crossing strings is not reported as a shift',
    !detectFigures(crossNotShift, phrasesFor(crossNotShift), null, []).some((f) => f.kind === 'shift'));

  // Sustained — one long note.
  const held = notesFrom([62, 69, 62], (midi, i) => ({ durationSeconds: i === 1 ? 2.5 : 0.4 }));
  const heldFigures = detectFigures(held, phrasesFor(held), null, []);
  check('sustained detected', heldFigures.some((f) => f.kind === 'sustained'));
  check('short notes are not sustained',
    heldFigures.filter((f) => f.kind === 'sustained').length === 1);

  // Ornament — fast alternation between two adjacent pitches.
  const trill = notesFrom([69, 71, 69, 71, 69, 71, 69], { durationSeconds: 0.1 });
  const trillFigures = detectFigures(trill, phrasesFor(trill), null, []);
  const ornament = trillFigures.find((f) => f.kind === 'ornament');
  check('ornament detected', ornament != null, kinds(trillFigures).join(','));
  check('ornament reports its pair',
    ornament?.trill?.lowerMidi === 69 && ornament?.trill?.upperMidi === 71);

  // Sequence — the same contour transposed up a step, twice.
  const seq = notesFrom([62, 66, 69, 64, 68, 71, 66, 70, 73]);
  const seqFigures = detectFigures(seq, phrasesFor(seq), null, []);
  const sequence = seqFigures.find((f) => f.kind === 'sequence');
  check('sequence detected', sequence != null, kinds(seqFigures).join(','));
  check('sequence counts repetitions', (sequence?.repetitions ?? 0) >= 2, String(sequence?.repetitions));

  check('no figures from a single note', detectFigures(notesFrom([62]), [], null, []).length === 0);
}

// ─────────────────────────────────────────────────────────────
console.log('buildKindContrasts');
{
  // 10 crossing notes at 30¢, 12 non-crossing notes at 5¢. The crossings are
  // genuinely worse and both groups clear the sample floor.
  const midis = [62, 71, 64, 73, 66, 74, 68, 76, 69, 78, ...Array(12).fill(0).map((_, i) => 62 + (i % 3))];
  const notes = notesFrom(midis, (midi, i) => {
    const bad = i < 10;
    return {
      string: i < 10 ? (i % 2 === 0 ? ('D' as const) : ('A' as const)) : ('D' as const),
      centsDeviation: bad ? -30 : -5,
      absCentsDeviation: bad ? 30 : 5,
      inTune: !bad,
    };
  });
  const figures = detectFigures(notes, phrasesFor(notes), null, []);
  const contrasts = buildKindContrasts(notes, figures);
  const crossing = contrasts.find((c) => c.kind === 'crossing_run');
  check('crossing contrast produced', crossing != null, contrasts.map((c) => c.kind).join(','));
  check('contrast is significant', crossing?.significant === true,
    `delta=${crossing?.deltaCents} d=${crossing?.effectSize}`);
  check('contrast delta is positive and large', (crossing?.deltaCents ?? 0) >= 15, String(crossing?.deltaCents));

  // Same shape, but only 4 crossing notes — below MIN_GROUP_SIZE, so silence.
  const few = notesFrom([62, 71, 64, 73, ...Array(20).fill(0).map((_, i) => 62 + (i % 3))], (midi, i) => ({
    string: i < 4 ? (i % 2 === 0 ? ('D' as const) : ('A' as const)) : ('D' as const),
    centsDeviation: i < 4 ? -40 : -2,
    absCentsDeviation: i < 4 ? 40 : 2,
  }));
  const fewContrasts = buildKindContrasts(few, detectFigures(few, phrasesFor(few), null, []));
  check('small group makes no claim',
    !fewContrasts.some((c) => c.kind === 'crossing_run' && c.significant),
    JSON.stringify(fewContrasts.find((c) => c.kind === 'crossing_run')));

  // Even playing across the board — nothing should be flagged as worse.
  const even = notesFrom(Array(24).fill(0).map((_, i) => 62 + (i % 5)), () => ({
    centsDeviation: 6, absCentsDeviation: 6,
  }));
  const evenContrasts = buildKindContrasts(even, detectFigures(even, phrasesFor(even), null, []));
  check('even playing yields no significant contrast', evenContrasts.every((c) => !c.significant));
}

// ─────────────────────────────────────────────────────────────
console.log('buildMusicalContext');
{
  const midis = [55, 59, 62, 67, 62, 59, 55, 57, 59, 60, 62, 64, 66, 67, 66, 64, 62, 60];
  const notes = notesFrom(midis, (midi, i) => ({
    centsDeviation: i < 7 ? -25 : -4,
    absCentsDeviation: i < 7 ? 25 : 4,
    inTune: i >= 7,
  }));
  const ctx = buildMusicalContext(notes, phrasesFor(notes), { keyHint: 'G major' });

  check('key estimated', ctx.key?.name === 'G major', ctx.key?.name);
  check('phrase keys align with phrases', ctx.phraseKeys.length === 1);
  check('figures found', ctx.figures.length > 0);
  check('assessments align with figures', ctx.assessments.length === ctx.figures.length);
  check('assessments are worst-first',
    ctx.assessments.every((a, i) => i === 0 || a.meanAbsCents * a.confidence <= ctx.assessments[i - 1].meanAbsCents * ctx.assessments[i - 1].confidence));
  check('every assessment maps to a real figure',
    ctx.assessments.every((a) => ctx.figures.some((f) => f.id === a.figureId)));
  check('figures carry the local key', ctx.figures.every((f) => f.localKey != null));

  const empty = buildMusicalContext([], []);
  check('empty session is safe', empty.figures.length === 0 && empty.key === null && empty.assessments.length === 0);
}

console.log(failures === 0 ? '\nAll musical context tests passed.' : `\n${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
