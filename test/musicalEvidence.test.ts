/**
 * Musical evidence selection tests.
 *
 *   node --experimental-strip-types --loader ./test/ts-resolver.mjs test/musicalEvidence.test.ts
 *   (or: npm run test:musicalevidence)
 *
 * The payload this builds is the entire difference between "focus on dynamics"
 * and "the phrase at 0:48 peaked at the very end". Two properties matter most
 * and neither is visible from reading a model response:
 *
 *   1. Selection picks the phrases worth discussing. The previous behaviour
 *      took the first ten chronologically, which on a five-minute take is the
 *      warm-up and nothing else.
 *   2. Everything carries a timestamp, because the results UI seeks to them.
 */

import { buildMusicalEvidence, MAX_EVIDENCE_PHRASES, MAX_MOMENTS } from '../src/lib/musicalEvidence';
import type { PhraseFeatures } from '../src/lib/phraseFeatures';
import type { NoteEvent } from '../src/lib/noteFusion';

let failures = 0;

function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function phrase(over: Partial<PhraseFeatures> & { id: number }): PhraseFeatures {
  return {
    start_t: over.start_t ?? over.id * 5,
    end_t: over.end_t ?? over.id * 5 + 4,
    energy_shape: 'arch',
    peak_location: 0.5,
    bow_usage: null,
    intonation: { mean_error_cents: 0, variance: 4, stability: 'high' },
    vibrato_consistency: 0.5,
    timbre_variation: 100,
    note_count: 8,
    slur_count: 1,
    ...over,
  } as PhraseFeatures;
}

function note(over: Partial<NoteEvent> & { startSeconds: number }): NoteEvent {
  return {
    endSeconds: over.startSeconds + (over.durationSeconds ?? 0.5),
    durationSeconds: 0.5,
    pitchHz: 440,
    noteName: 'A4',
    string: 'A',
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
    wristCollapsed: false,
    shoulderRaised: false,
    distanceFromCrossing: 0,
    phrasePosition: 0.5,
    phraseDurationSeconds: 4,
    ...over,
  } as NoteEvent;
}

console.log('\nPhrase selection');

// Twelve phrases: the interesting ones are late, so chronological truncation
// would miss every one of them.
const manyPhrases = [
  ...Array.from({ length: 9 }, (_, i) => phrase({ id: i })), // unremarkable
  phrase({ id: 9, energy_shape: 'flat', dynamics: { shape: 'plateau', peak_pos: 0.5, peak_t: 47, slope_norm: 0, melodic_contour: false } }),
  phrase({ id: 10, intonation: { mean_error_cents: -20, variance: 900, stability: 'low' } }),
  phrase({ id: 11, energy_shape: 'early_peak' }),
];

const selected = buildMusicalEvidence({ phraseFeatures: manyPhrases, noteEvents: [] });

check('selection is capped', selected.phrases.length <= MAX_EVIDENCE_PHRASES,
  `got ${selected.phrases.length}`);

check('the flat phrase is selected even though it is 10th', (() => {
  return selected.phrases.some((p) => p.id === 9);
})(), selected.phrases.map((p) => p.id).join(','));

check('the unsteady-intonation phrase is selected', selected.phrases.some((p) => p.id === 10));
check('the early-peak phrase is selected', selected.phrases.some((p) => p.id === 11));

check('selected phrases are returned in playing order', (() => {
  const ids = selected.phrases.map((p) => p.start_t);
  return ids.every((v, i) => i === 0 || v >= ids[i - 1]);
})(), selected.phrases.map((p) => p.start_t).join(','));

check('every phrase says why it was picked', selected.phrases.every((p) => p.selected_for.length > 0));

check('the total is reported so the model knows this is a selection',
  selected.phrases_total === 12);

check('a shaped line is not treated as a fault', (() => {
  const shaped = phrase({
    id: 0,
    dynamics: { shape: 'melodic_contour', peak_pos: 0.9, peak_t: 3, slope_norm: 0.6, melodic_contour: true },
  });
  const flat = phrase({ id: 1, energy_shape: 'flat' });
  const res = buildMusicalEvidence({ phraseFeatures: [shaped, flat], noteEvents: [] });
  const shapedEntry = res.phrases.find((p) => p.id === 0);
  return shapedEntry?.selected_for.includes('shaped line') === true;
})());

console.log('\nTimestamps');

check('phrases carry start and end times', selected.phrases.every((p) =>
  typeof p.start_t === 'number' && typeof p.end_t === 'number' && p.end_t > p.start_t));

check('the dynamics peak time is carried through', (() => {
  const p = selected.phrases.find((x) => x.id === 9);
  return p?.peak_t === 47;
})());

console.log('\nMoments');

const notes = [
  note({ startSeconds: 1, centsDeviation: 5 }),                                  // fine
  note({ startSeconds: 12, centsDeviation: -45, inTune: false, noteName: 'F#5' }), // badly flat
  note({ startSeconds: 30, centsDeviation: 38, inTune: false, noteName: 'C#5' }),  // sharp
  note({ startSeconds: 44, durationSeconds: 3.5, dynamicLevel: 0.2, noteName: 'D5' }), // long + quiet
];
const withMoments = buildMusicalEvidence({ phraseFeatures: [], noteEvents: notes });

check('out-of-tune notes become moments', (() => {
  return withMoments.moments.some((m) => m.note === 'F#5' && m.reason.includes('flat'));
})(), JSON.stringify(withMoments.moments));

check('a sharp note is described as sharp',
  withMoments.moments.some((m) => m.note === 'C#5' && m.reason.includes('sharp')));

check('an in-tune ordinary note is not a moment',
  !withMoments.moments.some((m) => m.t === 1));

check('moments are in playing order', (() => {
  const ts = withMoments.moments.map((m) => m.t);
  return ts.every((v, i) => i === 0 || v >= ts[i - 1]);
})());

check('moments are capped', (() => {
  const lots = Array.from({ length: 40 }, (_, i) =>
    note({ startSeconds: i, centsDeviation: -40 - i, inTune: false }));
  return buildMusicalEvidence({ phraseFeatures: [], noteEvents: lots }).moments.length <= MAX_MOMENTS;
})());

console.log('\nTempo');

check('tempo carries intent alongside measurement', (() => {
  const res = buildMusicalEvidence({
    phraseFeatures: [],
    noteEvents: [],
    metronomeBpm: 96,
    rhythm: {
      bpmEst: 88.4, beatPeriodSeconds: 0.68, tendency: 'dragging', gridScore: 70,
      tempoDriftScore: 62, rushCount: 1, dragCount: 6, onGridCount: 20, totalNotes: 27,
      localBeatPeriods: [], localBeatTimestamps: [],
      flaggedRegions: [{ startSeconds: 20.2, endSeconds: 24.9, direction: 'dragged', deviationPct: 12.4, label: 'x' }],
      isRubato: false,
    },
  });
  return res.tempo?.bpm_estimate === 88
    && res.tempo?.intended_bpm === 96
    && res.tempo?.tendency === 'dragging'
    && res.tempo?.regions[0]?.start_t === 20.2;
})());

check('rubato is reported as an observation, not swallowed', (() => {
  const res = buildMusicalEvidence({
    phraseFeatures: [], noteEvents: [],
    rhythm: {
      bpmEst: 70, beatPeriodSeconds: 0.85, tendency: null, gridScore: 65, tempoDriftScore: 50,
      rushCount: 0, dragCount: 0, onGridCount: 0, totalNotes: 30,
      localBeatPeriods: [], localBeatTimestamps: [], flaggedRegions: [], isRubato: true,
    },
  });
  return res.tempo?.rubato === true;
})());

check('no rhythm analysis means no tempo section, not a crash',
  buildMusicalEvidence({ phraseFeatures: [], noteEvents: [] }).tempo === undefined);

console.log('\nKey');

check('a low-confidence key is withheld rather than asserted', (() => {
  const res = buildMusicalEvidence({
    phraseFeatures: [], noteEvents: [],
    musicalContext: {
      key: { tonic: 'G', mode: 'major', name: 'G major', confidence: 0.2 },
      phraseKeys: [], figures: [], contrasts: [], assessments: [],
    } as never,
  });
  return res.key === undefined && res.key_confidence === 0.2;
})());

check('a confident key is passed through', (() => {
  const res = buildMusicalEvidence({
    phraseFeatures: [], noteEvents: [],
    musicalContext: {
      key: { tonic: 'G', mode: 'major', name: 'G major', confidence: 0.9 },
      phraseKeys: [], figures: [], contrasts: [], assessments: [],
    } as never,
  });
  return res.key === 'G major';
})());

console.log('\nDegenerate input');

check('empty input produces an empty but valid payload', (() => {
  const res = buildMusicalEvidence({ phraseFeatures: [], noteEvents: [] });
  return res.phrases.length === 0 && res.moments.length === 0 && res.phrases_total === 0;
})());

if (failures > 0) {
  console.error(`\n${failures} failing check(s)`);
  process.exit(1);
}
console.log('\nAll musical evidence checks passed.');
