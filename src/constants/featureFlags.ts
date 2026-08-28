/**
 * Bow calibration (the two-reference-clip flow). Gates the two places that
 * *enter* the flow:
 *
 *   • app/(tabs)/analyze.tsx      — "Ready" runs calibration before recording
 *   • app/practice/[id].tsx       — bowGeometry blocks detour via /practice/calibrate
 *
 * The pipeline treats calibration as optional (runSessionPipeline takes
 * `calibration: null`), so flipping this off just drops bow metrics back to
 * their uncalibrated behaviour.
 */
export const CALIBRATION_ENABLED = true;

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
export const FORCE_ONBOARDING = __DEV__ && true;
export const DEBUG_FORCE_PRO = __DEV__ && false;
