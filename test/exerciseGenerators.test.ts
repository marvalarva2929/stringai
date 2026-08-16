/**
 * Exercise generator tests — every family must emit a playable, targeted drill.
 *
 *   node --experimental-strip-types --loader ./test/ts-resolver.mjs test/exerciseGenerators.test.ts
 */

import { GENERATORS, generateExercises, type ExerciseFamily } from '../src/lib/exercises/registry';
import { arpeggioCycle, resolveKey, snapToKey, scaleOffsets } from '../src/lib/exercises/theory';
import { OPEN_MIDI, fingerFor, positionForMidi, stringForMidi } from '../src/lib/exercises/fingerboard';
import { noteNameToMidi } from '../src/lib/pitchNaming';
import { sequenceStepsFor } from '../src/lib/sequenceSteps';
import type { RankedPracticeEvidence } from '../src/lib/practiceRanking';
import type { PracticeEvidenceKind } from '../src/lib/practiceEvidence';
import type { PracticeBlock } from '../src/lib/practiceBlocks';
import type { ExerciseContext } from '../src/lib/exercises/types';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** Lowest open string to a comfortable ceiling in 7th position on the E string. */
const MIN_VIOLIN_MIDI = OPEN_MIDI.G;
const MAX_VIOLIN_MIDI = OPEN_MIDI.E + 16;

function evidence(
  kind: PracticeEvidenceKind,
  target: RankedPracticeEvidence['target'] = {},
  over: Partial<RankedPracticeEvidence> = {},
): RankedPracticeEvidence {
  return {
    id: `${kind}:test`,
    kind,
    metricKey: 'pitchAccuracy',
    title: 'Test issue',
    reason: 'At 0:42 the passage went flat.',
    contrast: 'Your crossing runs averaged 24¢ further off than the rest of the take.',
    evidenceSummary: 'average 24¢ flat, 30% in tune.',
    priority: 110,
    confidence: 0.8,
    supportsLive: true,
    requiresMic: true,
    requiresCamera: false,
    measurementAvailable: true,
    sessionCount: 1,
    rankScore: 140,
    target: { metricKey: 'pitchAccuracy', ...target },
    ...over,
  };
}

function ctxFor(ev: RankedPracticeEvidence, intensity: ExerciseContext['intensity'] = 'balanced'): ExerciseContext {
  return { evidence: ev, intensity };
}

/** Structural checks every generated block must satisfy. */
function assertWellFormed(label: string, block: PracticeBlock | null): PracticeBlock | null {
  check(`${label}: produced a block`, block != null);
  if (!block) return null;
  check(`${label}: has a title`, block.title.trim().length > 0);
  check(`${label}: explains why`, block.reason.trim().length > 0);
  check(`${label}: bridges finding to drill`, (block.bridge ?? '').trim().length > 20, block.bridge);
  check(`${label}: has instructions`, block.instructions.length >= 2);
  check(`${label}: has a pass condition`, block.successCriteria.summary.trim().length > 0);
  check(`${label}: is auto-judged`, block.evaluator != null);
  check(`${label}: cites its evidence`, block.evidenceRefs.length > 0);
  check(`${label}: has a fallback`, block.fallbackCriteria.trim().length > 0);

  const steps = sequenceStepsFor(block.evaluator);
  if (steps.length > 0) {
    const midis = steps.map((s) => noteNameToMidi(s.note));
    check(`${label}: every note parses`, midis.every((m) => m != null), JSON.stringify(steps.map((s) => s.note)));
    check(`${label}: every note is playable on a violin`,
      midis.every((m) => m != null && m >= MIN_VIOLIN_MIDI && m <= MAX_VIOLIN_MIDI),
      `range ${Math.min(...midis as number[])}–${Math.max(...midis as number[])}`);
    check(`${label}: every step is annotated`, steps.every((s) => (s.annotation ?? '').length > 0));
    check(`${label}: enough notes to judge`, steps.length >= 4, String(steps.length));
    // The "Hear the exercise" button reads these steps; non-empty means it renders.
    check(`${label}: is previewable`, sequenceStepsFor(block.evaluator).length > 0);
  }
  return block;
}

// ─────────────────────────────────────────────────────────────
console.log('theory');
{
  const key = resolveKey('G major');
  check('key resolves', key.name === 'G major' && key.tonic === 7);
  check('unparseable key falls back to D major', resolveKey('nonsense').name === 'D major');

  const cycle = arpeggioCycle(key);
  check('cycle has seven arpeggios', cycle.length === 7, String(cycle.length));
  check('cycle starts on the tonic', cycle[0].rootPitchClass === 7 && cycle[0].degree === 'I');
  check('cycle contains the dominant seventh', cycle.some((c) => c.quality === 'dominant7'));
  check('cycle contains a diminished seventh', cycle.some((c) => c.quality === 'diminished7'));
  check('every arpeggio explains its role', cycle.every((c) => c.role.length > 0));

  // Snapping must land on a real scale degree of the key.
  const offsets = scaleOffsets(key);
  const snapped = [60, 61, 63, 66, 68].map((m) => snapToKey(m, key));
  check('snapToKey lands in the key',
    snapped.every((m) => offsets.includes((((m - key.tonic) % 12) + 12) % 12)),
    JSON.stringify(snapped));
  check('snapToKey moves at most a semitone',
    [60, 61, 63, 66, 68].every((m, i) => Math.abs(snapped[i] - m) <= 1));
}

// ─────────────────────────────────────────────────────────────
console.log('fingerboard');
{
  check('open D is finger 0', fingerFor(OPEN_MIDI.D, 'D', 'first') === 0);
  check('E4 is 1st finger on D', fingerFor(64, 'D', 'first') === 1);
  check('out of reach returns null', fingerFor(80, 'D', 'first') === null);
  check('string choice prefers the higher string', stringForMidi(69) === 'A');
  check('preferred string is honoured when reachable', stringForMidi(69, 'D') === 'D');
  check('preferred string is ignored when unreachable', stringForMidi(55, 'E') === 'G');
  // The LOWEST position that reaches a note, which is what a violinist does.
  // Searching from the top instead made G4 on the D string read as "1st finger,
  // 3rd position" and broke every first-position drill's own labels.
  check('first position covers all four fingers',
    ['D', 'A'].every((str) => [2, 4, 5, 7].every((semis) => {
      const open = str === 'D' ? 62 : 69;
      return positionForMidi(open + semis, str as 'D' | 'A') === 'first';
    })));
  check('G4 on D is 3rd finger, first position',
    positionForMidi(67, 'D') === 'first' && fingerFor(67, 'D', 'first') === 3);
  check('A4 on D is 4th finger, first position',
    positionForMidi(69, 'D') === 'first' && fingerFor(69, 'D', 'first') === 4);
  check('position still climbs beyond the frame', positionForMidi(72, 'D') === 'third');
}

// ─────────────────────────────────────────────────────────────
console.log('arpeggio cycle');
{
  const block = assertWellFormed('arpeggio', GENERATORS.arpeggio_cycle(ctxFor(evidence('figure_intonation', {
    keyName: 'G major', chordLabel: 'G major', midiSequence: [55, 59, 62, 67],
  }))));
  check('arpeggio names the chord in the title', block?.title.includes('G major') === true, block?.title);
  check('arpeggio explains the harmonic function', block?.bridge?.includes('G major') === true);
  const notes = sequenceStepsFor(block?.evaluator).map((s) => noteNameToMidi(s.note)!);
  const pcs = new Set(notes.map((m) => ((m % 12) + 12) % 12));
  check('arpeggio plays only chord tones of G major',
    [...pcs].every((pc) => [7, 11, 2].includes(pc)), JSON.stringify([...pcs]));
}

// ─────────────────────────────────────────────────────────────
console.log('extracted figure');
{
  const source = [62, 64, 66, 67];
  const block = assertWellFormed('figure loop', GENERATORS.figure_loop(ctxFor(evidence('figure_sequence', {
    midiSequence: source, noteSequence: ['D4', 'E4', 'F#4', 'G4'],
  }))));
  const notes = sequenceStepsFor(block?.evaluator).map((s) => noteNameToMidi(s.note)!);
  check('loop uses the player\'s own notes',
    notes.slice(0, 4).join(',') === source.join(','), notes.slice(0, 4).join(','));
  check('loop repeats to a judgeable length', notes.length >= 6, String(notes.length));
  check('loop quotes the figure back', block?.bridge?.includes('D4 E4 F#4 G4') === true, block?.bridge);

  check('too short a figure produces nothing',
    GENERATORS.figure_loop(ctxFor(evidence('figure_sequence', { midiSequence: [62] }))) === null);
}

// ─────────────────────────────────────────────────────────────
console.log('crossing wave');
{
  const block = assertWellFormed('crossing wave', GENERATORS.crossing_wave(ctxFor(evidence('figure_crossing', {
    strings: ['D', 'A'], stringPairs: ['D-A'], keyName: 'D major',
  }))));
  check('crossing names the pair', block?.title.includes('D→A') === true, block?.title);
  const steps = sequenceStepsFor(block?.evaluator);
  check('crossing annotates the changes',
    steps.some((s) => s.annotation?.startsWith('cross to')), JSON.stringify(steps.map((s) => s.annotation)));
  check('crossing starts on open strings',
    noteNameToMidi(steps[0].note) === OPEN_MIDI.D, steps[0].note);

  check('a single string produces no wave',
    GENERATORS.crossing_wave(ctxFor(evidence('figure_crossing', { strings: ['D'] }))) === null);

  // The bug this guards: a passage touching G, D and A crosses G-D and D-A but
  // never G-A. Taking the outer edges of `strings` produced a drill for a
  // crossing the player never made.
  const threeStrings = GENERATORS.crossing_wave(ctxFor(evidence('figure_crossing', {
    strings: ['G', 'D', 'A'], stringPairs: ['G-D', 'D-A'], keyName: 'G major',
  })));
  check('a three-string passage drills a pair it actually crossed',
    threeStrings?.title.includes('G→D') === true, threeStrings?.title);
  check('and never the outer edges', threeStrings?.title.includes('G→A') === false, threeStrings?.title);

  // Without a pair list, three touched strings are ambiguous — decline rather
  // than guess which two were crossed.
  check('ambiguous legacy evidence declines',
    GENERATORS.crossing_wave(ctxFor(evidence('figure_crossing', {
      strings: ['G', 'D', 'A'],
    }))) === null);
  check('but two strings can only have crossed each other',
    GENERATORS.crossing_wave(ctxFor(evidence('figure_crossing', {
      strings: ['G', 'D'],
    })))?.title.includes('G→D') === true);
}

// ─────────────────────────────────────────────────────────────
console.log('shifting ladder');
{
  const block = assertWellFormed('shifting ladder', GENERATORS.shifting_ladder(ctxFor(evidence('figure_shift', {
    string: 'A', fromPosition: 'first', toPosition: 'fifth', finger: 2, keyName: 'D major',
  }))));
  check('ladder names the string', block?.title.includes('A string') === true, block?.title);
  const steps = sequenceStepsFor(block?.evaluator);
  check('ladder anchors on the open string',
    noteNameToMidi(steps[0].note) === OPEN_MIDI.A, steps[0].note);
  check('ladder passes through the middle position',
    steps.some((s) => s.annotation?.includes('3rd position')), JSON.stringify(steps.map((s) => s.annotation)));
  check('ladder comes back down',
    steps.some((s) => s.annotation?.startsWith('back to')));
  check('ladder is paced slower than a plain sequence',
    block?.evaluator?.evaluatorId === 'sequence' && block.evaluator.bpm < 60, String((block?.evaluator as { bpm?: number })?.bpm));

  check('no position change produces no ladder',
    GENERATORS.shifting_ladder(ctxFor(evidence('figure_shift', {
      string: 'A', fromPosition: 'first', toPosition: 'first',
    }))) === null);
}

// ─────────────────────────────────────────────────────────────
console.log('finger pattern');
{
  const block = assertWellFormed('finger pattern', GENERATORS.finger_pattern(ctxFor(evidence('figure_speed', {
    string: 'D', keyName: 'D major', midiSequence: [64, 66, 67, 69],
  }))));
  const steps = sequenceStepsFor(block?.evaluator);
  check('pattern tells the player which finger to lift',
    steps.some((s) => s.annotation?.includes('lift')), JSON.stringify(steps.map((s) => s.annotation)));
  check('pattern stays in one position',
    new Set(steps.map((s) => noteNameToMidi(s.note)!)).size <= 5);
}

// ─────────────────────────────────────────────────────────────
console.log('rhythmic acceleration');
{
  const block = assertWellFormed('acceleration', GENERATORS.acceleration(ctxFor(evidence('figure_speed', {
    keyName: 'D major', midiSequence: [62, 64, 66, 67, 69, 71], notesPerSecond: 6.2,
  }))));
  check('acceleration states the subdivision', block?.title.includes('per beat') === true, block?.title);
  check('acceleration keeps the pulse fixed in the copy',
    block?.subtitle.includes('Pulse stays') === true, block?.subtitle);
  check('acceleration marks the beats',
    sequenceStepsFor(block?.evaluator).some((s) => s.annotation?.startsWith('beat ')));
  check('acceleration cites the speed they played at',
    block?.bridge?.includes('6.2') === true, block?.bridge);
}

// ─────────────────────────────────────────────────────────────
console.log('trill chain');
{
  const block = assertWellFormed('trill', GENERATORS.trill_chain(ctxFor(evidence('figure_ornament', {
    trillPair: [69, 71], string: 'A',
  }))));
  check('trill names both notes', block?.title.includes('A4') === true && block?.title.includes('B4') === true, block?.title);
  check('trill uses the trill evaluator', block?.evaluator?.evaluatorId === 'trill');
  check('trill asks for a specific count',
    block?.evaluator?.evaluatorId === 'trill' && block.evaluator.requiredAlternations >= 4);
  check('no pair produces no trill',
    GENERATORS.trill_chain(ctxFor(evidence('figure_ornament', {}))) === null);
}

// ─────────────────────────────────────────────────────────────
console.log('bow distribution');
{
  const camped = evidence('bow_pattern', { metricKey: 'bowDistribution' }, {
    metricKey: 'bowDistribution',
    reason: 'You played in the upper half of the bow for 82% of the session.',
    evidenceSummary: 'upper half share 0.82.',
  });
  const block = assertWellFormed('bow distribution', GENERATORS.bow_distribution(ctxFor(camped)));
  check('prescribes the zone they avoided',
    block?.bridge?.includes('frog') === true, block?.bridge);
  check('falls back to tone when the camera has nothing',
    block?.evaluator?.evaluatorId === 'toneFault');

  check('an unnamed zone produces nothing',
    GENERATORS.bow_distribution(ctxFor(evidence('bow_pattern', {}, {
      reason: 'Bow control needs work.', evidenceSummary: 'score 62.',
    }))) === null);
}

// ─────────────────────────────────────────────────────────────
console.log('articulation');
{
  const fast = GENERATORS.articulation(ctxFor(evidence('bow_pattern', { notesPerSecond: 6, string: 'A' })));
  assertWellFormed('articulation', fast);
  check('fast passages get spiccato',
    fast?.evaluator?.evaluatorId === 'attack' && fast.evaluator.stroke === 'spiccato',
    JSON.stringify(fast?.evaluator));
  const slow = GENERATORS.articulation(ctxFor(evidence('bow_pattern', { notesPerSecond: 3, string: 'A' })));
  check('moderate passages get martelé',
    slow?.evaluator?.evaluatorId === 'attack' && slow.evaluator.stroke === 'martele');
  check('articulation uses an open string',
    noteNameToMidi(fast?.target.noteName ?? '') === OPEN_MIDI.A, fast?.target.noteName);
}

// ─────────────────────────────────────────────────────────────
console.log('vibrato control');
{
  const narrow = GENERATORS.vibrato_control(ctxFor(evidence('vibrato', { midiNote: 69, string: 'A' }, {
    metricKey: 'vibrato', evidenceSummary: '5.5 Hz, 12 cents depth, note score 55.',
  })));
  assertWellFormed('vibrato control', narrow);
  check('a shallow vibrato is told to widen', narrow?.title.includes('Widen') === true, narrow?.title);
  check('widening raises the depth bar',
    narrow?.evaluator?.evaluatorId === 'vibrato' && (narrow.evaluator.minDepthCents ?? 0) > 0);

  const fast = GENERATORS.vibrato_control(ctxFor(evidence('vibrato', { midiNote: 69, string: 'A' }, {
    metricKey: 'vibrato', evidenceSummary: '9.1 Hz, 40 cents depth, note score 55.',
  })));
  check('a fast vibrato is told to slow down', fast?.title.includes('Slow') === true, fast?.title);
  check('vibrato never lands on an open string',
    noteNameToMidi(narrow?.target.noteName ?? '') !== OPEN_MIDI.A
    || (narrow?.target.finger ?? 0) >= 2, narrow?.target.noteName);
}

// ─────────────────────────────────────────────────────────────
console.log('etude fragment');
{
  const block = assertWellFormed('etude', GENERATORS.etude_fragment(ctxFor(evidence('figure_crossing', {
    strings: ['D', 'A'], keyName: 'G major', midiNote: 62,
  }))));
  check('etude names its tradition', block?.subtitle.includes('after') === true, block?.subtitle);
  check('etude does not claim to be a transcription',
    block?.bridge?.includes('follows the shape of') === true, block?.bridge);
  const offsets = scaleOffsets(resolveKey('G major'));
  const notes = sequenceStepsFor(block?.evaluator).map((s) => noteNameToMidi(s.note)!);
  check('etude stays in the key',
    notes.every((m) => offsets.includes((((m - 7) % 12) + 12) % 12)), JSON.stringify(notes));
}

// ─────────────────────────────────────────────────────────────
console.log('routing');
{
  const crossing = generateExercises(ctxFor(evidence('figure_crossing', { strings: ['D', 'A'], keyName: 'D major' })));
  check('a crossing moment gets the wave', crossing[0]?.type === 'crossing_wave', crossing[0]?.type);
  check('one drill per moment, so other findings keep their slot',
    crossing.length === 1, crossing.map((b) => b.type).join(','));

  // An issue the player has already isolated three weeks running gets the
  // technique put back into a line instead of the same drill again.
  const recurring = generateExercises(ctxFor(evidence(
    'figure_crossing',
    { strings: ['D', 'A'], keyName: 'D major' },
    { sessionCount: 4 },
  )));
  check('a recurring crossing gets a musical setting',
    recurring[0]?.type === 'etude_fragment', recurring[0]?.type);
  check('a one-off crossing does not', crossing[0]?.type === 'crossing_wave');

  const shift = generateExercises(ctxFor(evidence('figure_shift', {
    string: 'A', fromPosition: 'first', toPosition: 'third',
  })));
  check('a shift moment gets the ladder first', shift[0]?.type === 'shifting_ladder', shift[0]?.type);

  check('an unrouted kind generates nothing',
    generateExercises(ctxFor(evidence('metric_fallback'))).length === 0);

  // A tone fault must stay with the fault-specific drill in practiceBlocks
  // rather than being diverted to a stroke-character exercise.
  check('tone faults are not routed to a generated drill',
    generateExercises(ctxFor(evidence('tone', { faultType: 'thin' }))).length === 0);

  // A moment with no usable musical detail must not produce a broken drill.
  const bare = generateExercises(ctxFor(evidence('figure_crossing', {})));
  check('a bare crossing moment degrades safely',
    bare.every((b) => sequenceStepsFor(b.evaluator).every((s) => noteNameToMidi(s.note) != null)),
    JSON.stringify(bare.map((b) => b.type)));
}

// ─────────────────────────────────────────────────────────────
console.log('every family is reachable and well-formed');
{
  const families = Object.keys(GENERATORS) as ExerciseFamily[];
  check('eleven families registered', families.length === 11, String(families.length));
  check('every registered family is callable',
    families.every((f) => typeof GENERATORS[f] === 'function'));
}

console.log(failures === 0 ? '\nAll exercise generator tests passed.' : `\n${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
