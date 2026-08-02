/**
 * Live coaching engine test harness.
 *
 *   node --experimental-strip-types --loader ./test/ts-resolver.mjs test/liveCoach.test.ts
 *   (or: npm run test:livecoach)
 *
 * The detectors matter, but the scheduler matters more: this overlay is shown to
 * someone two metres away who cannot dismiss it. So these checks are mostly
 * about restraint — that cues wait out the grace period, hold the screen long
 * enough to read, don't repeat inside their cooldown, don't stack, don't praise
 * a player whose wrist is collapsed, and stay silent when nobody is playing.
 */

import { createLiveCoach, COACH_WINDOW_S, PITCH_HZ, type LiveSnapshot, type CueId } from '../src/lib/liveCoach';
import { POSE, type FrameKeypoints, type Landmark } from '../src/lib/poseScoring';
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

// ─── Synthetic signal builders ───────────────────────────────────────────────

const POSE_FPS = 15;
const BOW_FPS = 10;
const TICK_S = 0.25;

function lm(x: number, y: number): Landmark {
  return { x, y, z: 0, visibility: 1 };
}

interface PoseOpts {
  /** Collapse the violin-arm wrist (angle ≈ 104° instead of ≈ 180°). */
  wristCollapsed?: boolean;
  /** Drop the bow elbow below the ARM_TOO_LOW_THRESHOLD of 0.22. */
  elbowLow?: boolean;
  /** Push the shoulders past THRESHOLDS.posture.shoulderDiff (0.05). */
  shouldersUneven?: boolean;
  /** Only the bow (right) arm in frame — the violin arm is out of view, as a
   *  front-facing camera routinely leaves it. */
  bowArmOnly?: boolean;
}

function poseFrame(timestamp: number, opts: PoseOpts = {}): FrameKeypoints {
  const pose: Landmark[] = new Array(33).fill({ x: 0, y: 0, z: 0, visibility: 0 });
  pose[POSE.RIGHT_SHOULDER] = lm(0.30, 0.30);
  pose[POSE.RIGHT_ELBOW] = lm(0.25, opts.elbowLow ? 0.60 : 0.40);
  pose[POSE.RIGHT_WRIST] = lm(0.22, 0.50);
  if (!opts.bowArmOnly) {
    pose[POSE.LEFT_SHOULDER] = lm(0.70, opts.shouldersUneven ? 0.40 : 0.30);
    pose[POSE.LEFT_ELBOW] = lm(0.70, 0.50);
    pose[POSE.LEFT_WRIST] = lm(0.75, 0.45);
    // Collinear with elbow→wrist reads as a straight wrist; bent back does not.
    pose[POSE.LEFT_INDEX_TIP] = opts.wristCollapsed ? lm(0.72, 0.40) : lm(0.80, 0.40);
  }
  return { timestamp, poseLandmarks: pose, leftHandLandmarks: null, rightHandLandmarks: null };
}

function poseWindow(t: number, opts: PoseOpts = {}): FrameKeypoints[] {
  const frames: FrameKeypoints[] = [];
  for (let ts = Math.max(0, t - COACH_WINDOW_S); ts <= t; ts += 1 / POSE_FPS) {
    frames.push(poseFrame(ts, opts));
  }
  return frames;
}

/** One bow frame with the contact point at `u` (0 = frog, 1 = tip). */
function bowFrame(timestamp: number, u: number, angleOffsetDeg = 0): RawBowFrame {
  // Rotate the stick around its centre so bowAngle tracks angleOffsetDeg.
  const rad = (angleOffsetDeg * Math.PI) / 180;
  const baseRad = Math.atan2(-0.2, 0.4);
  const half = 0.22;
  const cx = 0.5, cy = 0.5;
  const dx = half * Math.cos(baseRad + rad);
  const dy = half * Math.sin(baseRad + rad);
  return {
    timestamp,
    frogX: cx - dx, frogY: cy - dy, frogVisible: true,
    tipX: cx + dx, tipY: cy + dy, tipVisible: true,
    contactX: cx, contactY: cy, contactVisible: true,
    confidence: 0.9,
    bowPosT: u,
  };
}

/** Bow frames over the trailing window, contact position driven by uAt(t). */
function bowWindow(t: number, uAt: (ts: number) => number, angleAt: (ts: number) => number = () => 0): RawBowFrame[] {
  const frames: RawBowFrame[] = [];
  for (let ts = Math.max(0, t - COACH_WINDOW_S); ts <= t; ts += 1 / BOW_FPS) {
    frames.push(bowFrame(ts, uAt(ts), angleAt(ts)));
  }
  return frames;
}

/** Triangle wave between lo and hi with the given period — a bowing pattern. */
function stroke(lo: number, hi: number, periodS: number) {
  return (ts: number) => {
    const phase = (ts % periodS) / periodS;
    const tri = phase < 0.5 ? phase * 2 : 2 - phase * 2;
    return lo + (hi - lo) * tri;
  };
}

const RING = COACH_WINDOW_S * PITCH_HZ;

interface Audio { pitchHz: (number | null)[]; rms: number[]; clarity: number[]; }

/** A pitch/rms/clarity ring that is voiced but deliberately unremarkable — no praise, no fix. */
function neutralAudio(): Audio {
  // ~15 cents sharp: outside the in-tune band, well inside the "sharp" band.
  const hz = 440 * Math.pow(2, 15 / 1200);
  return {
    pitchHz: Array.from({ length: RING }, () => hz),
    // Alternating loudness keeps the even-tone CV above its threshold.
    rms: Array.from({ length: RING }, (_, i) => (i % 2 === 0 ? 0.05 : 0.12)),
    // A clean tone — high clarity, so no scratch/thin cue.
    clarity: Array.from({ length: RING }, () => 0.9),
  };
}

function silentAudio(): Audio {
  return {
    pitchHz: Array.from({ length: RING }, () => null),
    rms: Array.from({ length: RING }, () => 0),
    clarity: Array.from({ length: RING }, () => 0),
  };
}

/** A steadily-held note with a real vibrato oscillation (rate Hz, depth cents). */
function vibratoAudio(rateHz = 5.0, depthCents = 22): Audio {
  return {
    pitchHz: Array.from({ length: RING }, (_, i) => {
      const tSec = i / PITCH_HZ;
      const cents = depthCents * Math.sin(2 * Math.PI * rateHz * tSec);
      return 440 * Math.pow(2, cents / 1200);
    }),
    rms: Array.from({ length: RING }, () => 0.08),
    clarity: Array.from({ length: RING }, () => 0.9),
  };
}

/** Voiced but rough (low clarity) at a given loudness — scratchy when loud, thin when quiet. */
function roughAudio(rms: number): Audio {
  const hz = 440;
  return {
    pitchHz: Array.from({ length: RING }, () => hz),
    rms: Array.from({ length: RING }, () => rms),
    clarity: Array.from({ length: RING }, () => 0.2),
  };
}

interface ScenarioOpts {
  pose?: PoseOpts;
  uAt?: (ts: number) => number;
  angleAt?: (ts: number) => number;
  audio?: () => Audio;
  noPose?: boolean;
}

function snapshotAt(t: number, opts: ScenarioOpts = {}): LiveSnapshot {
  const audio = (opts.audio ?? neutralAudio)();
  return {
    t,
    poseFrames: opts.noPose ? [] : poseWindow(t, opts.pose),
    // A steady mid-bow hold: no direction changes, so no bow judgement fires.
    bowFrames: bowWindow(t, opts.uAt ?? (() => 0.5), opts.angleAt),
    pitchHz: audio.pitchHz,
    rms: audio.rms,
    clarity: audio.clarity,
  };
}

/** Runs the coach from 0 to untilS, returning each cue at the moment it appeared. */
function run(untilS: number, optsAt: (t: number) => ScenarioOpts = () => ({})): Array<{ t: number; id: CueId }> {
  const coach = createLiveCoach();
  const shown: Array<{ t: number; id: CueId }> = [];
  let last: CueId | null = null;
  for (let t = 0; t <= untilS + 1e-9; t += TICK_S) {
    const cue = coach.tick(snapshotAt(t, optsAt(t)));
    const id = cue?.id ?? null;
    if (id && id !== last) shown.push({ t: Math.round(t * 100) / 100, id });
    last = id;
  }
  return shown;
}

// ─────────────────────────────────────────────────────────────
console.log('\nGrace period');
{
  const shown = run(3.5, () => ({ pose: { wristCollapsed: true } }));
  check('no fix cue before the grace period ends', shown.length === 0,
    `got ${shown.map((s) => `${s.id}@${s.t}`).join(', ')}`);
}

console.log('\nA cue holds the screen, then clears');
{
  const coach = createLiveCoach();
  const opts: ScenarioOpts = { pose: { wristCollapsed: true } };
  let firstShownAt: number | null = null;
  let clearedAt: number | null = null;
  for (let t = 0; t <= 12; t += TICK_S) {
    const cue = coach.tick(snapshotAt(t, opts));
    if (cue && firstShownAt === null) firstShownAt = t;
    if (firstShownAt !== null && !cue && clearedAt === null) clearedAt = t;
  }
  check('a fix eventually fires', firstShownAt !== null, 'never fired');
  check('it fires at the end of the grace period', firstShownAt !== null && firstShownAt >= 4 && firstShownAt < 5,
    `fired at ${firstShownAt}`);
  check('it stays up long enough to read', clearedAt !== null && firstShownAt !== null && clearedAt - firstShownAt >= 2.8,
    `held for ${clearedAt !== null && firstShownAt !== null ? (clearedAt - firstShownAt).toFixed(2) : '?'}s`);
}

console.log('\nCooldown');
{
  const shown = run(30, () => ({ pose: { wristCollapsed: true } }));
  const wrist = shown.filter((s) => s.id === 'wrist_collapsed');
  check('a persistent fault is not repeated constantly', wrist.length === 2,
    `shown ${wrist.length} times: ${wrist.map((s) => s.t).join(', ')}`);
  check('the repeat waits out the 20s cooldown', wrist.length === 2 && wrist[1].t - wrist[0].t >= 20,
    wrist.length === 2 ? `gap was ${(wrist[1].t - wrist[0].t).toFixed(2)}s` : 'only fired once');
}

console.log('\nOne cue at a time');
{
  // Wrist, elbow and shoulders all wrong at once.
  const shown = run(12, () => ({ pose: { wristCollapsed: true, elbowLow: true, shouldersUneven: true } }));
  check('competing fixes are shown one after another, not stacked', shown.length >= 2,
    `got ${shown.length}`);
  const ids = shown.map((s) => s.id);
  check('round-robin — the second cue is a different fault', ids[0] !== ids[1],
    `got ${ids.join(', ')}`);
  const gaps = shown.slice(1).map((s, i) => s.t - shown[i].t);
  check('cues are spaced by at least the global interval', gaps.every((g) => g >= 6),
    `gaps: ${gaps.map((g) => g.toFixed(2)).join(', ')}`);
}

console.log('\nSetup problems preempt');
{
  const coach = createLiveCoach();
  let showing: CueId | null = null;
  for (let t = 0; t <= 5; t += TICK_S) {
    showing = coach.tick(snapshotAt(t, { pose: { wristCollapsed: true } }))?.id ?? null;
  }
  check('a fix is on screen', showing === 'wrist_collapsed', `got ${showing}`);
  // The player steps out of frame while that fix is still within its display time.
  const preempted = coach.tick(snapshotAt(5.25, { noPose: true }))?.id ?? null;
  check('losing the player preempts it immediately', preempted === 'no_pose', `got ${preempted}`);
}

console.log('\nSetup cues persist until resolved');
{
  const coach = createLiveCoach();
  let gaps = 0;
  let seen = false;
  for (let t = 0; t <= 15; t += TICK_S) {
    const cue = coach.tick(snapshotAt(t, { noPose: true }));
    if (cue?.id === 'no_pose') seen = true;
    else if (seen) gaps++;
  }
  check('the setup cue fires', seen);
  check('it never blinks off while unresolved', gaps === 0, `blank for ${gaps} ticks`);

  // Once the player steps back in, it clears and normal coaching resumes.
  let cleared = false;
  for (let t = 15.25; t <= 18; t += TICK_S) {
    if (coach.tick(snapshotAt(t)) === null) cleared = true;
  }
  check('it clears once the player is back in frame', cleared);
}

console.log('\nOne arm out of frame is tolerated');
{
  // A front-facing camera routinely loses the violin arm. That must NOT be read
  // as the player leaving the shot — "get in frame" only fires when neither arm
  // is visible.
  const shown = run(14, () => ({ pose: { bowArmOnly: true } }));
  check('one visible arm does not trip get-in-frame',
    !shown.some((s) => s.id === 'no_pose'),
    `got ${shown.map((s) => s.id).join(', ')}`);
}

console.log('\nBow distribution');
{
  // Short strokes camped in the upper half — the classic "not using the bow" fault.
  const shown = run(14, () => ({ uAt: stroke(0.72, 0.92, 1.6) }));
  const ids = shown.map((s) => s.id);
  check('camping at the tip is called out', ids.includes('camped_upper') || ids.includes('short_bow'),
    `got ${ids.join(', ') || 'nothing'}`);
  check('no praise while the bow is camped', !ids.some((id) => id === 'full_bow' || id === 'steady_bow'),
    `got ${ids.join(', ')}`);
}

console.log('\nFull-bow praise');
{
  const shown = run(14, () => ({ uAt: stroke(0.08, 0.94, 2.4) }));
  const ids = shown.map((s) => s.id);
  check('whole-bow strokes earn praise', ids.includes('full_bow') || ids.includes('steady_bow'),
    `got ${ids.join(', ') || 'nothing'}`);
  check('no bow fix fired', !ids.some((id) => id === 'short_bow' || id === 'camped_upper' || id === 'camped_lower'),
    `got ${ids.join(', ')}`);
}

console.log('\nPraise is suppressed while anything needs fixing');
{
  // Same whole-bow strokes as above, but the violin wrist is collapsed.
  const shown = run(14, () => ({ uAt: stroke(0.08, 0.94, 2.4), pose: { wristCollapsed: true } }));
  const ids = shown.map((s) => s.id);
  check('the fix is shown', ids.includes('wrist_collapsed'), `got ${ids.join(', ') || 'nothing'}`);
  check('no praise slips through', !ids.some((id) => id === 'full_bow' || id === 'steady_bow' || id === 'in_tune'),
    `got ${ids.join(', ')}`);
}

console.log('\nSilence');
{
  const shown = run(14, () => ({ uAt: stroke(0.08, 0.94, 2.4), audio: silentAudio }));
  check('nothing is judged while the room is quiet', shown.length === 0,
    `got ${shown.map((s) => s.id).join(', ')}`);
}

console.log('\nIntonation');
{
  const flat = (): Audio => ({
    // 40 cents flat, held steady — unambiguously under the note.
    pitchHz: Array.from({ length: RING }, () => 440 * Math.pow(2, -40 / 1200)),
    rms: Array.from({ length: RING }, () => 0.08),
    clarity: Array.from({ length: RING }, () => 0.9),
  });
  const shown = run(10, () => ({ audio: flat }));
  check('a sustained flat note is called out', shown.some((s) => s.id === 'pitch_flat'),
    `got ${shown.map((s) => s.id).join(', ') || 'nothing'}`);

  const inTune = (): Audio => ({
    pitchHz: Array.from({ length: RING }, () => 440),
    rms: Array.from({ length: RING }, (_, i) => (i % 2 === 0 ? 0.05 : 0.12)),
    clarity: Array.from({ length: RING }, () => 0.9),
  });
  const praised = run(10, () => ({ audio: inTune }));
  check('a sustained in-tune note is praised', praised.some((s) => s.id === 'in_tune'),
    `got ${praised.map((s) => s.id).join(', ') || 'nothing'}`);
}

console.log('\nVibrato praise is earned, not automatic');
{
  // A real, sustained vibrato oscillation should be praised…
  const praised = run(10, () => ({ audio: () => vibratoAudio(5.0, 22) }));
  check('a genuine vibrato is praised', praised.some((s) => s.id === 'good_vibrato'),
    `got ${praised.map((s) => s.id).join(', ') || 'nothing'}`);

  // …but a plain, steady note (the neutral ~15¢-sharp hold) must NOT be — this
  // is the false-positive the detector rewrite is meant to kill.
  const plain = run(14);
  check('a plain steady note is not called vibrato', !plain.some((s) => s.id === 'good_vibrato'),
    `got ${plain.map((s) => s.id).join(', ')}`);
}

console.log('\nSound quality');
{
  // Rough tone, loud → over-pressure → scratchy.
  const scratchy = run(10, () => ({ audio: () => roughAudio(0.12) }));
  check('a loud rough tone is called scratchy', scratchy.some((s) => s.id === 'tone_scratchy'),
    `got ${scratchy.map((s) => s.id).join(', ') || 'nothing'}`);
  check('scratchy is not also flagged thin', !scratchy.some((s) => s.id === 'tone_thin'),
    `got ${scratchy.map((s) => s.id).join(', ')}`);

  // Rough tone, quiet → under-pressure → thin.
  const thin = run(10, () => ({ audio: () => roughAudio(0.03) }));
  check('a quiet rough tone is called thin', thin.some((s) => s.id === 'tone_thin'),
    `got ${thin.map((s) => s.id).join(', ') || 'nothing'}`);

  // A clean tone (the neutral hold, clarity 0.9) must not trip either cue.
  const clean = run(14);
  check('a clean tone triggers no sound-quality cue',
    !clean.some((s) => s.id === 'tone_scratchy' || s.id === 'tone_thin'),
    `got ${clean.map((s) => s.id).join(', ')}`);
}

console.log('\nReset');
{
  const coach = createLiveCoach();
  for (let t = 0; t <= 6; t += TICK_S) coach.tick(snapshotAt(t, { pose: { wristCollapsed: true } }));
  coach.reset();
  check('reset clears the showing cue', coach.tick(snapshotAt(0, { pose: { wristCollapsed: true } })) === null);
}

// ─────────────────────────────────────────────────────────────
console.log('');
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('All live coach checks passed');
