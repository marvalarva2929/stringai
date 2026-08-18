/**
 * Holistic sequence scoring — a take is a score out of 100, not a clean sweep.
 *
 *   node --experimental-strip-types --loader ./test/ts-resolver.mjs test/sequenceScore.test.ts
 */

import {
  scoreSequence,
  intonationScoreFor,
  timingScoreFor,
  passMarkFor,
  scoreBand,
  WRONG_NOTE_CENTS,
} from '../src/lib/sequenceScore';
import { scoreHistoryFor, type PracticeAttempt } from '../src/lib/practiceAttempts';
import { buildSequenceWav, sequencePreviewSeconds } from '../src/lib/sequenceWav';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const OPTS = { centsThreshold: 10, passMark: 75 };
const note = (cents: number | null, offsetMs: number | null = 0) =>
  ({ label: 'D4', centsDeviation: cents, offsetMs });

// ─────────────────────────────────────────────────────────────
console.log('intonation is a curve, not a gate');
{
  check('inside tolerance is full marks', intonationScoreFor(8, 10) === 100);
  check('exactly at tolerance is full marks', intonationScoreFor(10, 10) === 100);
  check('a wrong note scores zero', intonationScoreFor(WRONG_NOTE_CENTS, 10) === 0);
  check('undetected scores zero', intonationScoreFor(null, 10) === 0);

  // The whole point: 12¢ and 40¢ are different, and a gate cannot say so.
  const near = intonationScoreFor(12, 10);
  const far = intonationScoreFor(40, 10);
  check('a near miss scores well', near > 85, String(near));
  check('a far miss scores poorly', far < 35, String(far));
  check('the curve is monotonic', near > far);
  check('direction does not matter', intonationScoreFor(-25, 10) === intonationScoreFor(25, 10));
}

// ─────────────────────────────────────────────────────────────
console.log('timing');
{
  check('dead on the click is full marks', timingScoreFor(0, 120) === 100);
  check('inside tolerance is full marks', timingScoreFor(-100, 120) === 100);
  check('badly late scores zero', timingScoreFor(500, 120) === 0);
  check('early and late are treated alike', timingScoreFor(-250, 120) === timingScoreFor(250, 120));
  // Unmeasurable timing is unknown, not bad.
  check('no timing data yields null', timingScoreFor(null, 120) === null);
}

// ─────────────────────────────────────────────────────────────
console.log('one imperfect note does not sink a take');
{
  // Eight notes: seven dead on, one 8¢ off — which the old evaluator failed.
  const notes = [...Array(7).fill(0).map(() => note(2)), note(8)];
  const result = scoreSequence(notes, 8, OPTS);
  check('a near-perfect take scores high', result.score >= 95, String(result.score));
  check('and passes', result.passed === true, `${result.score}`);
  check('all eight count as clean', result.cleanCount === 8, String(result.cleanCount));

  // One genuinely bad note in an otherwise good scale still scores well — the
  // score is a gradient — but it does not pass. Passing a tuning drill means
  // every note was in tune; a single note 45¢ out is audibly not.
  const oneBad = [...Array(7).fill(0).map(() => note(3)), note(45)];
  const partial = scoreSequence(oneBad, 8, OPTS);
  check('one bad note does not pass, however good the rest was', partial.passed === false, String(partial.score));
  check('but the score still reflects the good notes', partial.score >= 80, String(partial.score));
  check('and it costs something', partial.score < result.score, `${partial.score} vs ${result.score}`);
  check('the offending note is identifiable for a follow-up drill',
    partial.notes.filter((n) => !n.clean).length === 1,
    String(partial.notes.filter((n) => !n.clean).length));
}

// ─────────────────────────────────────────────────────────────
console.log('a bad take fails');
{
  const bad = Array(8).fill(0).map(() => note(45));
  const result = scoreSequence(bad, 8, OPTS);
  check('consistently far off fails', result.passed === false, String(result.score));
  check('score reflects it', result.score < 60, String(result.score));

  const wrongNotes = Array(8).fill(0).map(() => note(300));
  const wrong = scoreSequence(wrongNotes, 8, OPTS);
  check('all wrong notes scores near zero for pitch', wrong.intonation === 0, String(wrong.intonation));
  check('wrong notes are counted', wrong.wrongNoteCount === 8, String(wrong.wrongNoteCount));
}

// ─────────────────────────────────────────────────────────────
console.log('timing counts, but pitch counts more');
{
  const notes = Array(8).fill(0).map(() => note(2, 0));
  const perfect = scoreSequence(notes, 8, OPTS);

  const lateButInTune = scoreSequence(Array(8).fill(0).map(() => note(2, 600)), 8, OPTS);
  check('bad timing lowers the score', lateButInTune.score < perfect.score);
  check('but in-tune notes still score well overall',
    lateButInTune.score >= 70, String(lateButInTune.score));

  const onTimeButFlat = scoreSequence(Array(8).fill(0).map(() => note(45, 0)), 8, OPTS);
  check('bad pitch costs more than bad timing',
    onTimeButFlat.score < lateButInTune.score,
    `${onTimeButFlat.score} vs ${lateButInTune.score}`);

  // No beat data at all: unknown timing must not be scored as bad timing.
  const noTiming = scoreSequence(Array(8).fill(0).map(() => note(2, null)), 8, OPTS);
  check('missing timing data is not punished', noTiming.timing === null && noTiming.score >= 95,
    `${noTiming.score}`);
}

// ─────────────────────────────────────────────────────────────
console.log('completeness');
{
  const short = scoreSequence(Array(4).fill(0).map(() => note(2)), 8, OPTS);
  check('playing half the notes is penalised', short.completeness === 50, String(short.completeness));
  // Completeness multiplies rather than adding: half an exercise cannot score
  // in the nineties however well the half went.
  check('and it halves the score', short.score <= 55, String(short.score));

  const over = scoreSequence(Array(12).fill(0).map(() => note(2)), 8, OPTS);
  check('extra notes are penalised too', over.completeness < 100, String(over.completeness));

  const missing = scoreSequence([note(2), note(null), note(2), note(2)], 4, OPTS);
  check('undetected notes are counted', missing.missingCount === 1, String(missing.missingCount));
}

// ─────────────────────────────────────────────────────────────
console.log('the bar scales with the coach');
{
  check('guided is reachable', passMarkFor('guided') < passMarkFor('balanced'));
  check('advanced is demanding', passMarkFor('advanced') > passMarkFor('balanced'));

  // Sits between the two bars: comfortably fine for a beginner, not for someone
  // being held to an advanced standard.
  // Now that passing means "every note inside tolerance", the coach level shows
  // up as the tolerance itself (centsFor: 15/20/25), not as a score bar. Playing
  // consistently 18¢ off is fine for a beginner and not for an advanced player.
  const decent = Array(8).fill(0).map(() => note(18));
  const guided = scoreSequence(decent, 8, { centsThreshold: 25, passMark: passMarkFor('guided') });
  const advanced = scoreSequence(decent, 8, { centsThreshold: 15, passMark: passMarkFor('advanced') });
  check('the same playing can pass guided and not advanced',
    guided.passed && !advanced.passed, `guided=${guided.passed} advanced=${advanced.passed}`);
}

// ─────────────────────────────────────────────────────────────
console.log('a high score does not excuse a wrong note');
{
  // Seven perfect notes and one played a semitone out. The score is high, and
  // the take still must not pass: forgiving intonation is the point of scoring,
  // forgiving a different note is not.
  const oneWrong = [...Array(7).fill(0).map(() => note(2)), note(100)];
  const result = scoreSequence(oneWrong, 8, OPTS);
  check('the score reflects that most of it was good', result.score >= 80, String(result.score));
  check('but the take is disqualified', result.passed === false);
  check('and says why', result.disqualifiedReason === 'wrong_notes', result.disqualifiedReason);

  // A longer drill still gets room on the *disqualification* rule (one fumble in
  // twenty is not "wrong notes"), but it does not pass — the note is not clean.
  const longOneWrong = [...Array(19).fill(0).map(() => note(2)), note(100)];
  const long = scoreSequence(longOneWrong, 20, OPTS);
  check('a long sequence is not disqualified by a single fumble',
    long.disqualifiedReason === undefined, String(long.disqualifiedReason));
  check('but one unclean note still blocks the pass', long.passed === false, String(long.score));

  const undetected = [...Array(7).fill(0).map(() => note(2)), note(null)];
  check('an undetected note also disqualifies',
    scoreSequence(undetected, 8, OPTS).disqualifiedReason === 'missing_notes');

  const short = Array(6).fill(0).map(() => note(2));
  check('a short take is disqualified on count',
    scoreSequence(short, 8, OPTS).disqualifiedReason === 'note_count');
  check('and cannot score in the nineties',
    scoreSequence(short, 8, OPTS).score < 80, String(scoreSequence(short, 8, OPTS).score));

  check('a clean take is not disqualified',
    scoreSequence(Array(8).fill(0).map(() => note(2)), 8, OPTS).disqualified === false);
}

// ─────────────────────────────────────────────────────────────
console.log('score bands');
{
  check('90+ is excellent', scoreBand(92) === 'excellent');
  check('75-89 is good', scoreBand(80) === 'good');
  check('55-74 needs attention', scoreBand(60) === 'needs_attention');
  check('below 55 is critical', scoreBand(40) === 'critical');
}

// ─────────────────────────────────────────────────────────────
console.log('score history tracks one drill over time');
{
  const attempt = (day: number, score: number, blockId = 'crossing_wave:x'): PracticeAttempt => ({
    at: `2026-08-${String(day).padStart(2, '0')}T10:00:00.000Z`,
    planId: 'p', blockId, blockType: 'crossing_wave', blockTitle: 'D→A wave',
    issueIds: ['figure_crossing:A-D'], pieceId: 'p1', score,
  });
  // Store order is newest-first.
  const log = [attempt(15, 88), attempt(8, 79), attempt(1, 71), attempt(3, 95, 'other')];

  const history = scoreHistoryFor(log, 'crossing_wave:x');
  check('history is oldest-first', history?.scores.join(',') === '71,79,88', history?.scores.join(','));
  check('improvement is latest minus first', history?.improvement === 17, String(history?.improvement));
  check('best is the highest', history?.best === 88, String(history?.best));
  check('latest is the most recent', history?.latest === 88, String(history?.latest));
  check('another drill is not mixed in', history?.scores.includes(95) === false);

  check('one attempt has no improvement yet',
    scoreHistoryFor([attempt(1, 71)], 'crossing_wave:x')?.improvement === null);
  check('a drill never attempted has no history',
    scoreHistoryFor(log, 'never-done') === null);
  check('self-reported attempts (no score) are skipped',
    scoreHistoryFor([{ ...attempt(1, 0), score: undefined }], 'crossing_wave:x') === null);
}

// ─────────────────────────────────────────────────────────────
console.log('sequence preview audio');
{
  const wav = buildSequenceWav([62, 64, 66], 60);
  check('renders a RIFF/WAVE file',
    String.fromCharCode(...wav.slice(0, 4)) === 'RIFF'
    && String.fromCharCode(...wav.slice(8, 12)) === 'WAVE');

  // Three notes at 60 BPM is three seconds of audio at 22050 Hz, 16-bit.
  const dataBytes = new DataView(wav.buffer).getUint32(40, true);
  check('length matches the tempo', Math.abs(dataBytes / 2 / 22050 - 3) < 0.05,
    String(dataBytes / 2 / 22050));
  check('faster tempo is shorter',
    new DataView(buildSequenceWav([62, 64, 66], 120).buffer).getUint32(40, true) < dataBytes);
  check('duration helper agrees', Math.abs(sequencePreviewSeconds(3, 60) - 3) < 0.001);

  // Silence would mean the preview plays nothing.
  const samples = new Int16Array(wav.buffer, 44, dataBytes / 2);
  check('audio is not silent', samples.some((v) => Math.abs(v) > 1000));
  // A gap between notes is what makes a sequence audible as separate notes.
  const beatSamples = 22050;
  check('notes are separated by a gap',
    Math.abs(samples[beatSamples - 200]) < Math.abs(samples[Math.floor(beatSamples * 0.3)]));

  check('no notes yields an empty-but-valid file', buildSequenceWav([], 60).length >= 44);
}

console.log(failures === 0 ? '\nAll sequence score tests passed.' : `\n${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
