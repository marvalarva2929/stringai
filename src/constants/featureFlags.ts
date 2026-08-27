/**
 * Bow calibration (the two-reference-clip flow). Gates the three places that
 * depend on it:
 *
 *   • app/(tabs)/analyze.tsx      — "Ready" runs calibration before recording
 *   • app/practice/[id].tsx       — bowGeometry blocks detour via /practice/calibrate
 *   • src/lib/bowGeometryEvaluator.ts — stringPos/bowDistribution refuse to grade
 *
 * Off since beta: the two reference holds failed to read the bow far more often
 * than they succeeded ("Couldn't get a clean bow-position reading…"), and a step
 * that mostly fails in front of a player holding a violin two metres from the
 * phone costs more than the precision it buys. The pipeline treats calibration
 * as optional (runSessionPipeline takes `calibration: null`), so this just drops
 * bow metrics back to their uncalibrated behaviour — and the evaluator gate
 * above must follow the flag, or bow drills become unpassable.
 */
export const CALIBRATION_ENABLED = false;

/**
 * Debug only — forced off outside __DEV__ so a release build can never ship
 * with these on, even if someone flips the literal below and forgets.
 *
 * FORCE_ONBOARDING shows the onboarding carousel on every cold launch, even
 * after it has been completed (the completion flag persists in AsyncStorage,
 * which is why onboarding normally never reappears on a device).
 *
 * DEBUG_FORCE_PRO treats the local entitlement as Pro so every gate
 * (live recording, chat coaching, curated exercises, quota) is unlocked.
 */
// `__DEV__` is injected by the React Native bundler and is simply absent under
// the plain-node test runner. This module is imported by src/lib code that the
// tests exercise directly (bowGeometryEvaluator), so reading it bare would make
// every one of those tests fail on module load.
const DEV = typeof __DEV__ !== 'undefined' && __DEV__;

export const FORCE_ONBOARDING = DEV && true;
export const DEBUG_FORCE_PRO = DEV && false;
