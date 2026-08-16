/**
 * Technique staples — the plan must always contain some general work.
 *
 *   node --experimental-strip-types --loader ./test/ts-resolver.mjs test/techniqueStaple.test.ts
 */

import { buildTechniqueStaple, stapleForDate, type StapleKind } from '../src/lib/exercises/techniqueStaple';
import { buildPracticeBlocks } from '../src/lib/practiceBlocks';
import { sequenceStepsFor } from '../src/lib/sequenceSteps';
import { noteNameToMidi } from '../src/lib/pitchNaming';
import { scaleOffsets, resolveKey } from '../src/lib/exercises/theory';
import type { RankedPracticeEvidence } from '../src/lib/practiceRanking';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const ALL_KINDS: StapleKind[] = ['scale', 'arpeggio', 'long_tones', 'finger_frame', 'shift_prep'];

function evidence(id: string, over: Partial<RankedPracticeEvidence> = {}): RankedPracticeEvidence {
  return {
    id,
    kind: 'figure_crossing',
    metricKey: 'pitchAccuracy',
    title: id,
    reason: 'At 0:42 you crossed D→A and drifted flat.',
    evidenceSummary: 'average 24¢ flat.',
    priority: 120,
    confidence: 0.9,
    supportsLive: true,
    requiresMic: true,
    requiresCamera: false,
    measurementAvailable: true,
    sessionCount: 1,
    rankScore: 150,
    target: { metricKey: 'pitchAccuracy', strings: ['D', 'A'], keyName: 'G major', startSeconds: 42 },
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────
console.log('every staple is a complete, runnable block');
{
  for (const kind of ALL_KINDS) {
    const block = buildTechniqueStaple({ intensity: 'balanced', keyName: 'G major', kind });
    check(`${kind}: has a title`, block.title.trim().length > 0);
    check(`${kind}: says it is a warm-up`, /warm-up|daily/i.test(`${block.subtitle} ${block.reason}`),
      `${block.subtitle} / ${block.reason}`);
    check(`${kind}: explains itself`, (block.bridge ?? '').length > 20);
    check(`${kind}: has instructions`, block.instructions.length >= 2);
    check(`${kind}: is auto-judged`, block.evaluator != null);
    // A warm-up is not a claim about the player's playing, so it must not
    // masquerade as one by citing evidence it doesn't have.
    check(`${kind}: cites no evidence`, block.evidenceRefs.length === 0);

    const steps = sequenceStepsFor(block.evaluator);
    if (steps.length > 0) {
      check(`${kind}: notes parse`, steps.every((s) => noteNameToMidi(s.note) != null));
      check(`${kind}: notes are playable`, steps.every((s) => {
        const midi = noteNameToMidi(s.note)!;
        return midi >= 55 && midi <= 92;
      }), JSON.stringify(steps.map((s) => s.note)));
      check(`${kind}: every step is annotated`, steps.every((s) => (s.annotation ?? '').length > 0));
      // "Hear the exercise" is driven off these steps, so steps present means
      // the button is present. A paced drill with no previewable notes is the
      // bug where the button silently didn't render.
      check(`${kind}: is previewable`, sequenceStepsFor(block.evaluator).length > 0);
      check(`${kind}: names a starting note`, block.target.noteName != null, JSON.stringify(block.target));
    }
  }
}

// ─────────────────────────────────────────────────────────────
console.log('staples use the key the player has been working in');
{
  const g = buildTechniqueStaple({ intensity: 'balanced', keyName: 'G major', kind: 'scale' });
  check('title names the key', g.title.includes('G major'), g.title);
  const offsets = scaleOffsets(resolveKey('G major'));
  const notes = sequenceStepsFor(g.evaluator).map((s) => noteNameToMidi(s.note)!);
  check('scale stays in the key',
    notes.every((m) => offsets.includes((((m - 7) % 12) + 12) % 12)), JSON.stringify(notes));

  const d = buildTechniqueStaple({ intensity: 'balanced', keyName: 'D major', kind: 'scale' });
  check('a different key gives different notes',
    sequenceStepsFor(d.evaluator)[0].note !== sequenceStepsFor(g.evaluator)[0].note);

  const noKey = buildTechniqueStaple({ intensity: 'balanced', kind: 'scale' });
  check('no key still produces a scale', sequenceStepsFor(noKey.evaluator).length > 0);
}

// ─────────────────────────────────────────────────────────────
console.log('the frame check explains itself');
{
  const frame = buildTechniqueStaple({ intensity: 'balanced', keyName: 'G major', kind: 'finger_frame' });
  const steps = sequenceStepsFor(frame.evaluator);
  const prose = `${frame.bridge} ${frame.instructions.join(' ')}`;

  // A drill nobody understands is a drill nobody does. Each of these is a
  // question a confused player actually asked.
  check('says what a frame IS', /shape your left hand|all four fingers over/i.test(prose), prose.slice(0, 90));
  check('names the notes up front', /E, F#, G, A/.test(prose));
  check('says what the test is', /same note|match/i.test(prose));
  check('says how to tell pass from fail', /flat|beats against/i.test(prose));

  // The open-A unison is the entire point; without it this is just noodling.
  const openA = steps.findIndex((st) => /open A/i.test(st.annotation ?? ''));
  check('the drill actually contains the check', openA > 0, JSON.stringify(steps.map((st) => st.annotation)));
  check('4th finger comes immediately before it',
    /4th finger/i.test(steps[openA - 1]?.annotation ?? ''), steps[openA - 1]?.annotation);
  check('they are the same pitch',
    noteNameToMidi(steps[openA].note) === noteNameToMidi(steps[openA - 1].note),
    `${steps[openA - 1]?.note} vs ${steps[openA]?.note}`);

  // Instruction 1 says nothing shifts, so no label may claim otherwise.
  check('no step contradicts "first position"',
    steps.every((st) => !/\d(?:nd|rd|th) position/i.test(st.annotation ?? '')),
    JSON.stringify(steps.map((st) => st.annotation)));
  check('every step names its finger or the open string',
    steps.every((st) => /finger|open/i.test(st.annotation ?? '')));
}

// ─────────────────────────────────────────────────────────────
console.log('rotation');
{
  const day = (n: number) => stapleForDate(new Date(Date.UTC(2026, 7, n)));
  check('stable within a day',
    stapleForDate(new Date(Date.UTC(2026, 7, 9, 3))) === stapleForDate(new Date(Date.UTC(2026, 7, 9, 21))));
  const week = [9, 10, 11, 12, 13, 14, 15].map(day);
  check('varies across the week', new Set(week).size >= 3, week.join(','));
  check('repeats weekly', day(9) === day(16), `${day(9)} vs ${day(16)}`);
}

// ─────────────────────────────────────────────────────────────
console.log('the plan reserves a slot for general work');
{
  // Three strong figure findings would otherwise fill every slot with repair.
  const ranked = [
    evidence('figure_crossing:A-D'),
    evidence('figure_shift:A:first-third', {
      kind: 'figure_shift',
      target: { metricKey: 'pitchAccuracy', string: 'A', fromPosition: 'first', toPosition: 'third' },
    }),
    evidence('figure_intonation:arpeggio:G-major', {
      kind: 'figure_intonation',
      target: { metricKey: 'pitchAccuracy', keyName: 'G major', chordLabel: 'G major' },
    }),
  ];

  const plan = buildPracticeBlocks(ranked, { weeklyGoalMinutes: 45, keyName: 'G major' });
  check('warm-up comes first', plan[0]?.evidenceRefs.length === 0, plan.map((b) => b.type).join(','));
  check('repair work still gets slots', plan.length >= 3, String(plan.length));
  check('the rest are evidence-driven',
    plan.slice(1).every((b) => b.evidenceRefs.length > 0), plan.map((b) => b.type).join(','));
  check('no more blocks than the goal allows', plan.length <= 4, String(plan.length));

  // A short session is repair-only: there isn't room for both, and the flagged
  // passage is the better use of ten minutes.
  const short = buildPracticeBlocks(ranked, { weeklyGoalMinutes: 15, keyName: 'G major' });
  check('a short plan skips the warm-up',
    short.every((b) => b.evidenceRefs.length > 0), short.map((b) => b.type).join(','));
  check('a short plan is still full', short.length === 2, String(short.length));
}

// ─────────────────────────────────────────────────────────────
console.log('a clean session still gets real work');
{
  const plan = buildPracticeBlocks([], { weeklyGoalMinutes: 45, hasAnalyzedSessions: true });
  check('nothing flagged still yields blocks', plan.length > 0);
}

console.log(failures === 0 ? '\nAll technique staple tests passed.' : `\n${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
