/**
 * The two pitch detectors must agree about what counts as a note.
 *
 *   node --experimental-strip-types --loader ./test/ts-resolver.mjs test/detectorParity.test.ts
 *
 * The app detects pitch twice, in two languages, on two audio paths:
 *
 *   • modules/mic-pitch/ios/YinDetector.swift — the streaming tuner, reading an
 *     AVAudioEngine tap.
 *   • src/services/dsp.ts — the grader, reading the recorded WAV of a take.
 *
 * When their gates drift apart the app contradicts itself in the worst possible
 * way: the tuner shows the player a note, they play it into an exercise, and the
 * exercise tells them it heard nothing. That is not a cosmetic inconsistency —
 * it teaches the player the app is broken.
 *
 * It had drifted. dsp.ts required clarity > 0.85 (it returned null whenever YIN's
 * difference function never dipped below the absolute threshold, where the Swift
 * version falls back to the global minimum) and gated RMS at 0.01 against the
 * native 0.003. Everything in between — most real violin tone, which carries bow
 * noise — was a confident note on the tuner and silence to the grader.
 *
 * These checks are cheap insurance against that happening again.
 */

import { readFileSync } from 'node:fs';
import { detectPitches, yinWindow, CLARITY_GATE, RMS_NOISE_GATE } from '../src/services/dsp';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const SR = 44100;

// ── the gates themselves ─────────────────────────────────────────────────────
console.log('\nGate parity with the native detector:');
{
  const swift = readFileSync('modules/mic-pitch/ios/YinDetector.swift', 'utf8');
  const numberAfter = (label: string): number | null => {
    const m = new RegExp(`${label}:\\s*Float\\s*=\\s*([0-9.]+)`).exec(swift);
    return m ? Number(m[1]) : null;
  };

  const swiftClarity = numberAfter('clarityGate');
  const swiftRms = numberAfter('rmsGate');
  const swiftThreshold = numberAfter('threshold');

  check(
    'YinDetector.swift still declares the gates this test reads',
    swiftClarity !== null && swiftRms !== null && swiftThreshold !== null,
    `clarityGate=${swiftClarity} rmsGate=${swiftRms} threshold=${swiftThreshold}`,
  );
  check(
    'clarity gate matches the native clarityGate',
    swiftClarity === CLARITY_GATE,
    `swift=${swiftClarity} ts=${CLARITY_GATE}`,
  );
  check(
    'RMS gate matches the native rmsGate',
    swiftRms === RMS_NOISE_GATE,
    `swift=${swiftRms} ts=${RMS_NOISE_GATE}`,
  );
  check(
    'the native detector still falls back to the global minimum',
    /if bestTau < 0\s*\{[\s\S]{0,200}?greatestFiniteMagnitude/.test(swift),
    'YinDetector.swift no longer has the no-dip fallback that dsp.ts mirrors',
  );
}

// ── behaviour: the band that used to vanish ──────────────────────────────────
console.log('\nTone the grader used to drop:');

/** A bowed note: harmonic stack, bow noise, slow amplitude wobble. */
function bowedNote(freqHz: number, durS: number, amp: number, noise: number): Float32Array {
  const n = Math.floor(SR * durS);
  const out = new Float32Array(n);
  const harm = [1, 0.5, 0.33, 0.22, 0.14, 0.09];
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff - 0.5;
  };
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = Math.min(1, t / 0.04) * Math.min(1, (durS - t) / 0.05);
    let v = 0;
    for (let h = 0; h < harm.length; h++) v += harm[h] * Math.sin(2 * Math.PI * freqHz * (h + 1) * t);
    v /= 2.28;
    // Bow noise scales with the note, as friction does.
    out[i] = amp * env * (v * (1 + 0.05 * Math.sin(2 * Math.PI * 4.5 * t)) + noise * rand());
  }
  return out;
}

const voicedFraction = (buf: Float32Array): number => {
  const frames = detectPitches(buf, SR);
  if (frames.length === 0) return 0;
  return frames.filter((f) => f.frequency !== null).length / frames.length;
};

{
  // Quiet playing. The old RMS gate of 0.01 sat above the level YinDetector.swift
  // documents as already rejecting genuine notes.
  const quiet = bowedNote(440, 1.2, 0.02, 0.08);
  const frac = voicedFraction(quiet);
  check('a quiet A4 is voiced', frac > 0.6, `voiced fraction ${frac.toFixed(2)}`);
}

{
  // Audible bow noise — a real beginner tone, and the case that motivated the fix.
  // This noise level is chosen so that *no* frame trips YIN's absolute threshold:
  // every voiced frame here comes from the global-minimum fallback, so the check
  // fails outright if that fallback is ever removed again. (At lighter noise some
  // frames still lock, and the old detector limped by.)
  const rough = bowedNote(392, 1.2, 0.25, 0.8);
  const frac = voicedFraction(rough);
  check('a noisy-but-real G4 is voiced', frac > 0.8, `voiced fraction ${frac.toFixed(2)}`);

  const voiced = detectPitches(rough, SR).filter((f) => f.frequency !== null);
  check(
    'and it is the fallback carrying it — the band the grader used to lose',
    voiced.length > 0 && voiced.every((f) => f.locked === false),
    `${voiced.filter((f) => f.locked).length}/${voiced.length} frames locked (expected 0)`,
  );
}

{
  // Whatever we voice, we must voice at a believable pitch — the fallback picks a
  // global minimum, which on a harmonic-rich string can land an octave low.
  const rough = bowedNote(440, 1.2, 0.25, 0.45);
  const voiced = detectPitches(rough, SR).filter((f) => f.frequency !== null);
  const nearTarget = voiced.filter((f) => Math.abs(1200 * Math.log2(f.frequency! / 440)) < 60).length;
  check(
    'voiced frames land on the played pitch, not an octave off',
    voiced.length > 0 && nearTarget / voiced.length > 0.8,
    `${nearTarget}/${voiced.length} frames within 60¢ of A4`,
  );
}

{
  // The fallback must not turn noise into notes.
  const n = Math.floor(SR * 1.0);
  const hiss = new Float32Array(n);
  let seed = 999;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    hiss[i] = (seed / 0x7fffffff - 0.5) * 0.3;
  }
  const frac = voicedFraction(hiss);
  check('broadband hiss stays unvoiced', frac < 0.05, `voiced fraction ${frac.toFixed(3)}`);
}

// ── provenance: locked vs fallback ───────────────────────────────────────────
console.log('\nPitch provenance:');
{
  const clean = bowedNote(440, 0.6, 0.4, 0.0);
  const frames = detectPitches(clean, SR).filter((f) => f.frequency !== null);
  const lockedCount = frames.filter((f) => f.locked).length;
  check(
    'a clean tone locks on the absolute threshold, not the fallback',
    frames.length > 0 && lockedCount / frames.length > 0.9,
    `${lockedCount}/${frames.length} locked`,
  );
}

{
  // `locked` is what lets tone analysis keep treating an unlocked frame as
  // aperiodic (see toneAnalysis.extractToneFrameFeatures) while the grader still
  // gets a pitch out of it.
  const silence = new Float32Array(2048);
  const r = yinWindow(silence, 0, 1024, SR);
  check('silence reports no pitch and no lock', r.frequency === null && r.locked === false);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll detector parity checks passed');
