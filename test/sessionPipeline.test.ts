/**
 * Session pipeline (L1–L9) smoke test.
 *
 *   node --experimental-strip-types --loader ./test/ts-resolver.mjs test/sessionPipeline.test.ts
 *   (or: npm run test:pipeline)
 *
 * Runs the full pure pipeline over a synthetic session — constant-pitch audio
 * with détaché bowing — and checks every layer produces plausible output and
 * that the no-bow/no-pose degradation path stays alive.
 */

import { runSessionPipeline } from '../src/lib/sessionPipeline';
import type { AudioAnalysisOutput, RawAudioSignals } from '../src/types/analysis';
import type { RawBowFrame } from '../src/types/signals';

let failures = 0;

function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const DURATION = 8.0;
const A4 = 440;

function makeAudioOutput(): AudioAnalysisOutput {
  const hop = 0.025;
  const n = Math.floor(DURATION / hop);
  const rawSignals: RawAudioSignals = {
    pitchFrames: Array.from({ length: n }, (_, i) => ({ frequency: A4, timestamp: i * hop })),
    rmsFrames: Array.from({ length: n }, (_, i) => ({ value: 0.3, timestamp: i * hop })),
    toneFrames: Array.from({ length: n }, (_, i) => ({ fundamentalRatio: 0.8, timestamp: i * hop })),
    spectralCentroidFrames: Array.from({ length: n }, (_, i) => ({ value: 1500, timestamp: i * hop })),
    brightnessFrames: Array.from({ length: n }, (_, i) => ({ value: 0.2, timestamp: i * hop })),
    onsetTimestamps: [],
    uncollapsedOnsetTimestamps: Array.from({ length: 15 }, (_, i) => (i + 1) * 0.5),
    sampleRate: 44100,
    duration: DURATION,
  };
  return {
    metrics: [],
    intonationAnalysis: {
      totalNoteEvents: 0, inTuneCount: 0, outOfTuneCount: 0, inTuneRate: 1,
      overallTendency: 'neutral', tendencyCents: 0, problemNotes: [],
      observationSummary: '', _score: 100,
    },
    intonationStabilityAnalysis: { assessedCount: 0, unsteadyCount: 0, avgDriftCents: 0, worstNotes: [] },
    vibratoAnalysis: { eligibleCount: 0, avgNoteScore: 0, notes: [] },
    rawSignals,
  };
}

/** Détaché bow: contact sweeps frog↔tip, reversing every 0.5s, at 10fps. */
function makeBowFrames(): RawBowFrame[] {
  const frames: RawBowFrame[] = [];
  for (let t = 0; t < DURATION; t += 0.1) {
    const phase = (t % 1.0) / 0.5;
    const u = phase <= 1 ? 0.2 + 0.6 * phase : 0.8 - 0.6 * (phase - 1);
    frames.push({
      timestamp: t,
      tipX: 0.8, tipY: 0.5, tipVisible: true,
      frogX: 0.2, frogY: 0.5, frogVisible: true,
      contactX: 0.2 + u * 0.6, contactY: 0.5, contactVisible: true,
      confidence: 0.9,
    });
  }
  return frames;
}

// ─────────────────────────────────────────────────────────────
console.log('\nFull pipeline on synthetic détaché session');
{
  const out = runSessionPipeline({
    audioOutput: makeAudioOutput(),
    poseFrames: [],
    bowFrames: makeBowFrames(),
    durationSeconds: DURATION,
    instrument: 'violin',
  });

  check('L2: multiple notes (bow splits repeated pitch)', out.noteEvents.length > 1,
    `got ${out.noteEvents.length}`);
  check('L2: notes carry bow contact point', out.noteEvents.some(n => n.bowContactPoint !== null));
  check('L3: bowDirection series populated',
    out.signals.bowDirection.points.some(p => p.v === 1) && out.signals.bowDirection.points.some(p => p.v === -1));
  check('L5: every note in exactly one group',
    out.noteGroups.reduce((s, g) => s + g.noteIds.length, 0) === out.noteEvents.length,
    `${out.noteGroups.length} groups over ${out.noteEvents.length} notes`);
  check('L6: at least one phrase', out.phrases.length >= 1, `got ${out.phrases.length}`);
  check('L7: features per phrase', out.phraseFeatures.length === out.phrases.length);
  check('L7: bow_usage present', out.phraseFeatures.every(f => f.bow_usage !== null));
  check('L8: findings array (no crash)', Array.isArray(out.findings));
  check('L9: assessment produced', typeof out.sessionAssessment.playerCategory === 'string');
  check('videoMetrics empty without pose frames', out.videoMetrics.length === 0);
}

console.log('\nDegradation: no bow, no pose');
{
  const out = runSessionPipeline({
    audioOutput: makeAudioOutput(),
    poseFrames: [],
    bowFrames: [],
    durationSeconds: DURATION,
    instrument: 'violin',
  });

  check('L2: single note (no bow corroboration → no splits)', out.noteEvents.length === 1,
    `got ${out.noteEvents.length}`);
  check('L5: groups typed other (no direction signal)', out.noteGroups.every(g => g.type === 'other'));
  check('L7: bow_usage null', out.phraseFeatures.every(f => f.bow_usage === null));
  check('L9: assessment still produced', typeof out.sessionAssessment.playerCategory === 'string');
}

console.log('\nCalibration: bow contact point is rescaled in session signals');
{
  const out = runSessionPipeline({
    audioOutput: makeAudioOutput(),
    poseFrames: [],
    bowFrames: makeBowFrames(),
    durationSeconds: DURATION,
    instrument: 'violin',
    calibration: {
      frogFraction: 0.2,
      tipFraction: 0.8,
      fingerboardFraction: 0.15,
      bridgeFraction: 0.85,
      calibratedAt: Date.now(),
    },
  });
  const values = out.signals.bowContactPoint.points
    .map((p) => p.v)
    .filter((v): v is number => v !== null);
  check('calibrated bow contact reaches near frog', Math.min(...values) < 0.05);
  check('calibrated bow contact reaches near tip', Math.max(...values) > 0.95);
}

// ─────────────────────────────────────────────────────────────
console.log('');
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('All session pipeline checks passed');
