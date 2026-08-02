import type { MetricKey, PlayerCategory } from '../types/analysis';
import type { SkillLevel } from '../types/user';
import type { RankedPracticeEvidence } from './practiceRanking';
import type { BowGeometryTarget } from './bowGeometryEvaluator';
import { exercisesForMetric } from '../constants/exercises';
import { METRIC_META } from '../constants/metricMeta';

export type CoachIntensity = 'guided' | 'balanced' | 'advanced';

export type PracticeBlockType =
  | 'pitch_landing'
  | 'scale_lock'
  | 'vibrato'
  | 'bow_control'
  | 'rhythm'
  | 'tone'
  | 'phrase_repair'
  | 'review';

export type LiveSignal = 'pitch' | 'tone' | 'vibrato' | 'rhythm' | 'bow' | 'posture' | 'camera';

export interface PracticeEvidenceRef {
  evidenceId: string;
  title: string;
  reason: string;
  sourceSessionId?: string;
  startSeconds?: number;
  endSeconds?: number;
}

export interface PracticeLiveMode {
  label: string;
  signals: LiveSignal[];
  requiresMic: boolean;
  requiresCamera: boolean;
  status: 'ready' | 'limited' | 'unavailable';
  unavailableReason?: string;
}

export interface PracticeSuccessCriteria {
  summary: string;
  targetStreak?: number;
  repetitions?: number;
  centsThreshold?: number;
  durationSeconds?: number;
}

/**
 * Which pure evaluator (src/lib/*Evaluator.ts) the runner calls to judge a
 * captured take, and the thresholds it judges against. Optional on
 * PracticeBlock so unmigrated blocks keep the self-report result screen.
 */
export type EvaluatorId = 'pitchLanding' | 'vibrato' | 'bowGeometry' | 'toneFault' | 'dynamicsShape';

export interface PitchLandingEvaluatorParams {
  evaluatorId: 'pitchLanding';
  centsThreshold: number;
  requiredStreak: number;
  minConfidence?: number;
}

export interface VibratoEvaluatorParams {
  evaluatorId: 'vibrato';
  minRateHz?: number;
  maxRateHz?: number;
  minDepthCents?: number;
  maxDepthCents?: number;
  minDurationSeconds?: number;
  requiredSuccesses: number;
}

export interface ToneFaultEvaluatorParams {
  evaluatorId: 'toneFault';
  disallowedFaults?: Exclude<import('../types/analysis').ToneFault, 'clean'>[];
  requiredCleanFraction: number;
  minConfidence?: number;
}

export interface BowGeometryEvaluatorParams {
  evaluatorId: 'bowGeometry';
  target: BowGeometryTarget;
}

export interface DynamicsShapeEvaluatorParams {
  evaluatorId: 'dynamicsShape';
  target: import('./dynamicsEvaluator').DynamicsShapeTarget;
}

export interface HoldEvaluatorParams {
  evaluatorId: 'hold';
  centsThreshold: number;
  minDurationSeconds: number;
  minFractionInTolerance: number;
  requiredSuccesses: number;
  minConfidence?: number;
}

export interface ScaleEvaluatorParams {
  evaluatorId: 'scale';
  scaleName: string;
  centsThreshold: number;
  minConfidence?: number;
  /** Octave-specific MIDI note of the flagged issue, so the judged sequence is
   *  rooted in the same register the instructions point to (see scaleNoteSequence). */
  rootMidiNote?: number;
}

export interface RhythmEvaluatorParams {
  evaluatorId: 'rhythm';
  /** Click track starts here — seeded from the player's own detected tempo when
   *  available (see PracticeEvidenceTarget.bpmEst), otherwise a generic default. */
  startBpm: number;
  minBpm: number;
  maxBpm: number;
  /** Clicks per take. */
  beatCount: number;
  /** Max onset offset from its click, in ms, to count as on-time. */
  toleranceMs: number;
  requiredOnTimeFraction: number;
  minConfidence?: number;
}

export type EvaluatorParams =
  | PitchLandingEvaluatorParams
  | VibratoEvaluatorParams
  | ToneFaultEvaluatorParams
  | BowGeometryEvaluatorParams
  | DynamicsShapeEvaluatorParams
  | HoldEvaluatorParams
  | ScaleEvaluatorParams
  | RhythmEvaluatorParams;

export interface PracticeTarget {
  metricKey: MetricKey;
  pitchClass?: string;
  midiNote?: number;
  noteName?: string;
  string?: string;
  finger?: number;
  scaleName?: string;
  tendency?: string;
  startSeconds?: number;
  endSeconds?: number;
}

export interface PracticeBlock {
  id: string;
  type: PracticeBlockType;
  title: string;
  subtitle: string;
  reason: string;
  estimatedMinutes: number;
  coachIntensity: CoachIntensity;
  instructions: string[];
  target: PracticeTarget;
  liveMode: PracticeLiveMode;
  successCriteria: PracticeSuccessCriteria;
  /** How the runner judges a captured take. Absent = self-report fallback. */
  evaluator?: EvaluatorParams;
  fallbackCriteria: string;
  coachPromptContext: string;
  evidenceRefs: PracticeEvidenceRef[];
}

export interface PracticeBlockBuildOptions {
  playerCategory?: PlayerCategory | null;
  weeklyGoalMinutes?: number | null;
  skillLevel?: SkillLevel;
  /** True when at least one session has been analyzed. Distinguishes a genuine
   *  cold start (show the record-a-baseline prompt) from a clean session with no
   *  flagged issues (show maintenance work, not "record your first session"). */
  hasAnalyzedSessions?: boolean;
}

export function coachIntensityFor(
  playerCategory?: PlayerCategory | null,
  weeklyGoalMinutes?: number | null,
): CoachIntensity {
  if (playerCategory === 'foundation') return 'guided';
  if ((weeklyGoalMinutes ?? 0) >= 60) return 'advanced';
  return 'balanced';
}

export function targetBlockCount(weeklyGoalMinutes?: number | null): number {
  const minutes = weeklyGoalMinutes ?? 30;
  if (minutes <= 15) return 2;
  if (minutes <= 30) return 3;
  return 4;
}

export function targetPlanMinutes(weeklyGoalMinutes?: number | null): number {
  const minutes = weeklyGoalMinutes ?? 30;
  if (minutes <= 15) return 10;
  if (minutes <= 30) return 18;
  return 28;
}

/**
 * Two blocks describe the same drill, so evidence for one corroborates the other.
 * Only `pitch_landing` distinguishes by target: a second bad note is worth its own
 * drill, whereas a second scale or a second bow drill is the same work twice.
 */
function sameBlockIdentity(a: PracticeBlock, b: PracticeBlock): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'pitch_landing') return a.target.pitchClass === b.target.pitchClass;
  return true;
}

/** Fold `refs` into `block`, skipping evidence it already cites. */
function attachEvidence(block: PracticeBlock, refs: PracticeEvidenceRef[]): void {
  for (const ref of refs) {
    if (!block.evidenceRefs.some((existing) => existing.evidenceId === ref.evidenceId)) {
      block.evidenceRefs.push(ref);
    }
  }
}

export function buildPracticeBlocks(
  ranked: RankedPracticeEvidence[],
  options: PracticeBlockBuildOptions = {},
): PracticeBlock[] {
  const maxBlocks = targetBlockCount(options.weeklyGoalMinutes);
  const intensity = coachIntensityFor(options.playerCategory, options.weeklyGoalMinutes);
  const blocks: PracticeBlock[] = [];
  const usedMetrics = new Set<MetricKey>();

  for (const evidence of ranked) {
    const next = blocksForEvidence(evidence, intensity, options);
    for (const candidate of next) {
      // Never `continue` without first folding the evidence somewhere. Three
      // agreeing bow tests used to collapse into one drill citing only the
      // weakest of them, discarding the two that explained the cause.
      const twin = blocks.find((block) => sameBlockIdentity(block, candidate));
      if (twin) {
        attachEvidence(twin, candidate.evidenceRefs);
        continue;
      }

      const metricTaken =
        candidate.type !== 'scale_lock' && usedMetrics.has(candidate.target.metricKey) && blocks.length > 0;

      // Evidence the analyzer could not actually measure may corroborate an
      // existing block but must never seed a technique drill of its own — that
      // is how an empty vibratoAnalysis produced a full "Custom Vibrato Trainer".
      // A `review` block is the one exception: it *is* the "we couldn't measure
      // this, look at it manually" fallback.
      const canSeed = evidence.measurementAvailable || candidate.type === 'review';

      if (!canSeed || metricTaken || blocks.length >= maxBlocks) {
        const host = blocks.find((block) => block.target.metricKey === candidate.target.metricKey);
        if (host) attachEvidence(host, candidate.evidenceRefs);
        continue;
      }

      blocks.push({ ...candidate, evidenceRefs: [...candidate.evidenceRefs] });
      usedMetrics.add(candidate.target.metricKey);
    }
  }

  if (blocks.length === 0) {
    return options.hasAnalyzedSessions
      ? maintenanceBlocks(intensity, options.weeklyGoalMinutes)
      : starterBlocks(intensity, options.weeklyGoalMinutes);
  }
  return blocks;
}

function blocksForEvidence(
  evidence: RankedPracticeEvidence,
  intensity: CoachIntensity,
  options: PracticeBlockBuildOptions,
): PracticeBlock[] {
  if (!evidence.measurementAvailable && evidence.requiresCamera) {
    return [reviewBlock(evidence, intensity, 'Live camera data is not reliable yet for this target.')];
  }

  switch (evidence.kind) {
    case 'pitch_note':
    case 'pitch_tendency':
      return [
        pitchLandingBlock(evidence, intensity),
        scaleLockBlock(evidence, intensity, options.skillLevel),
      ];
    case 'intonation_stability':
      return [pitchHoldBlock(evidence, intensity)];
    case 'vibrato':
      return [vibratoBlock(evidence, intensity)];
    case 'bow_pattern':
      return [bowControlBlock(evidence, intensity)];
    case 'rhythm':
      return [rhythmBlock(evidence, intensity)];
    case 'tone':
      if (evidence.target.faultType === 'thin') return [toneFaultBlock(evidence, intensity, 'thin')];
      if (evidence.target.faultType === 'scratch' || evidence.target.faultType === 'rasp') {
        return [toneFaultBlock(evidence, intensity, 'pressure')];
      }
      return [toneBlock(evidence, intensity)];
    case 'phrase':
      return [phraseRepairBlock(evidence, intensity)];
    case 'metric_fallback':
    default:
      return [reviewBlock(evidence, intensity)];
  }
}

function ref(evidence: RankedPracticeEvidence): PracticeEvidenceRef {
  return {
    evidenceId: evidence.id,
    title: evidence.title,
    reason: evidence.evidenceSummary,
    sourceSessionId: evidence.sourceSessionId,
    startSeconds: evidence.target.startSeconds,
    endSeconds: evidence.target.endSeconds,
  };
}

function blockBase(
  evidence: RankedPracticeEvidence,
  type: PracticeBlockType,
  intensity: CoachIntensity,
): Pick<PracticeBlock, 'id' | 'type' | 'coachIntensity' | 'reason' | 'target' | 'evidenceRefs'> {
  return {
    id: `${type}:${evidence.id}`,
    type,
    coachIntensity: intensity,
    reason: evidence.reason,
    target: {
      metricKey: evidence.metricKey,
      pitchClass: evidence.target.pitchClass,
      midiNote: evidence.target.midiNote,
      noteName: evidence.target.noteName,
      string: evidence.target.string,
      finger: evidence.target.finger,
      tendency: evidence.target.tendency,
      startSeconds: evidence.target.startSeconds,
      endSeconds: evidence.target.endSeconds,
    },
    evidenceRefs: [ref(evidence)],
  };
}

function pitchLandingBlock(evidence: RankedPracticeEvidence, intensity: CoachIntensity): PracticeBlock {
  const target = evidence.target.pitchClass ?? evidence.target.noteName ?? 'target note';
  const cents = intensity === 'advanced' ? 8 : intensity === 'balanced' ? 10 : 12;
  // Consecutive landings, so the streak is the whole point — but it compounds:
  // at 7-in-a-row a single slip late in the take voids everything before it.
  // 3-5 still demonstrates control without making one miss cost the take.
  const streak = intensity === 'advanced' ? 5 : intensity === 'balanced' ? 4 : 3;
  return {
    ...blockBase(evidence, 'pitch_landing', intensity),
    title: `${target} Landing Trainer`,
    subtitle: 'Live pitch attacks',
    estimatedMinutes: intensity === 'guided' ? 6 : 5,
    instructions: [
      `Play ${target} by itself with a clean attack.`,
      'Stop the bow after each attempt and reset the finger before playing again.',
      `If the note keeps landing ${evidence.target.tendency ?? 'out of tune'}, slow down and place the finger before starting the bow.`,
    ],
    liveMode: {
      label: 'Mic checks pitch on every attack',
      signals: ['pitch', 'tone'],
      requiresMic: true,
      requiresCamera: false,
      status: 'ready',
    },
    successCriteria: {
      summary: `Land ${target} within +/-${cents} cents ${streak} times in a row.`,
      targetStreak: streak,
      repetitions: streak,
      centsThreshold: cents,
    },
    evaluator: { evaluatorId: 'pitchLanding', centsThreshold: cents, requiredStreak: streak },
    fallbackCriteria: `If live pitch confidence is low, play ${target} 10 times against a tuner drone and only count clean attacks.`,
    coachPromptContext: `Coach ${target} pitch landings. Focus on one adjustment at a time and use the evidence: ${evidence.evidenceSummary}`,
  };
}

function scaleLockBlock(
  evidence: RankedPracticeEvidence,
  intensity: CoachIntensity,
  skillLevel?: SkillLevel,
): PracticeBlock {
  const target = evidence.target.pitchClass ?? evidence.target.noteName ?? 'target note';
  const scaleName = scaleForPitch(target, skillLevel);
  const cents = intensity === 'advanced' ? 10 : 12;
  return {
    ...blockBase(evidence, 'scale_lock', intensity),
    title: `${scaleName} Scale Lock-In`,
    subtitle: 'One note per metronome click',
    estimatedMinutes: intensity === 'advanced' ? 8 : 6,
    instructions: [
      `Warm up the ${scaleName} scale slowly on your own first, especially around ${target}.`,
      'When you record, a metronome click paces the take — play the note shown on screen on each click, with a clear stop before the next.',
      'Keep the bow speed even so pitch and tone are judged from a stable sound.',
    ],
    target: {
      ...blockBase(evidence, 'scale_lock', intensity).target,
      scaleName,
    },
    liveMode: {
      label: 'Metronome-paced, mic checks each scale degree',
      signals: ['pitch', 'tone'],
      requiresMic: true,
      requiresCamera: false,
      status: 'ready',
    },
    successCriteria: {
      summary: `Play the ${scaleName} scale in tempo, keeping all but a note or two inside +/-${cents} cents.`,
      repetitions: 1,
      centsThreshold: cents,
    },
    evaluator: { evaluatorId: 'scale', scaleName, centsThreshold: cents, rootMidiNote: evidence.target.midiNote },
    fallbackCriteria: `If live note detection is uncertain, play ${scaleName} with a drone and pause on ${target} for two full bows.`,
    coachPromptContext: `Coach a scale lock exercise around ${target}. Keep feedback specific to intonation and tone stability.`,
    evidenceRefs: [ref(evidence)],
  };
}

function pitchHoldBlock(evidence: RankedPracticeEvidence, intensity: CoachIntensity): PracticeBlock {
  const target = evidence.target.noteName ?? evidence.target.pitchClass ?? 'the target note';
  const seconds = intensity === 'advanced' ? 8 : 6;
  return {
    ...blockBase(evidence, 'pitch_landing', intensity),
    title: `${target} Long-Tone Hold`,
    subtitle: 'Steady center line',
    estimatedMinutes: 5,
    instructions: [
      `Hear the target note and check your string is in tune first.`,
      `Start the take, then hold ${target} steady on a slow full bow.`,
      'Keep the left hand relaxed and avoid correcting after the sound starts.',
      `The recording stops on its own after ${seconds}s — just hold through it.`,
    ],
    liveMode: {
      label: 'Mic watches pitch drift',
      signals: ['pitch', 'tone'],
      requiresMic: true,
      requiresCamera: false,
      status: 'ready',
    },
    successCriteria: {
      summary: `Hold ${target} steady for the full ${seconds}s — recording stops automatically.`,
      repetitions: 1,
      durationSeconds: seconds,
    },
    evaluator: {
      evaluatorId: 'hold',
      centsThreshold: 15,
      minDurationSeconds: seconds,
      minFractionInTolerance: 0.75,
      requiredSuccesses: 1,
    },
    fallbackCriteria: `If pitch tracking drops out, use a tuner in strobe mode and repeat ${target} until the needle stays calm.`,
    coachPromptContext: `Coach pitch stability on ${target}; separate left-hand drift from bow-pressure wobble.`,
  };
}

function vibratoBlock(evidence: RankedPracticeEvidence, intensity: CoachIntensity): PracticeBlock {
  const seconds = intensity === 'advanced' ? 8 : 5;
  return {
    ...blockBase(evidence, 'vibrato', intensity),
    title: 'Custom Vibrato Trainer',
    subtitle: 'Rate, depth, and continuity',
    estimatedMinutes: intensity === 'guided' ? 7 : 6,
    instructions: [
      'Choose a comfortable sustained note, preferably 2nd or 3rd finger.',
      'Start the note straight, then add vibrato without changing bow speed.',
      'Keep the motion continuous through the whole bow instead of pulsing only at the start.',
    ],
    liveMode: {
      label: 'Mic estimates vibrato rate and depth',
      signals: ['pitch', 'vibrato', 'tone'],
      requiresMic: true,
      requiresCamera: false,
      status: 'ready',
    },
    successCriteria: {
      summary: `Maintain 4-7 Hz vibrato with consistent depth for 2 held notes of ${seconds}s.`,
      repetitions: 2,
      durationSeconds: seconds,
    },
    evaluator: {
      evaluatorId: 'vibrato',
      minDurationSeconds: seconds,
      requiredSuccesses: 2,
    },
    fallbackCriteria: 'If live vibrato confidence is low, practice silent wrist waves in rhythm, then record one sustained-note attempt.',
    coachPromptContext: `Coach vibrato using the prior evidence: ${evidence.evidenceSummary}`,
  };
}

function bowControlBlock(evidence: RankedPracticeEvidence, intensity: CoachIntensity): PracticeBlock {
  const unavailable = !evidence.measurementAvailable;
  return {
    ...blockBase(evidence, 'bow_control', intensity),
    title: bowTitle(evidence.metricKey),
    subtitle: 'Camera-guided bow check',
    estimatedMinutes: intensity === 'guided' ? 7 : 6,
    instructions: [
      'Play slow open-string bows while the camera watches the bow path.',
      'Reset at the frog and tip before repeating.',
      bowInstruction(evidence.metricKey),
    ],
    liveMode: {
      label: unavailable ? 'Camera evidence needed' : 'Camera checks bow geometry',
      signals: ['bow', 'camera'],
      requiresMic: false,
      requiresCamera: true,
      status: unavailable ? 'unavailable' : 'ready',
      unavailableReason: unavailable ? 'Bow detector data was unavailable in recent sessions.' : undefined,
    },
    successCriteria: {
      summary: bowSuccess(evidence.metricKey, intensity),
      repetitions: intensity === 'advanced' ? 8 : 5,
    },
    evaluator: unavailable ? undefined : { evaluatorId: 'bowGeometry', target: bowGeometryTarget(evidence.metricKey) },
    fallbackCriteria: 'If camera tracking is unavailable, record from the player side and review whether the bow stays parallel to the bridge.',
    coachPromptContext: `Coach bow control from camera evidence. Prior finding: ${evidence.evidenceSummary}`,
  };
}

function rhythmBlock(evidence: RankedPracticeEvidence, intensity: CoachIntensity): PracticeBlock {
  // Seed the click track at the tempo the player actually struggled at when
  // we have it (evidence.target.bpmEst, from their flagged session); otherwise
  // fall back to an intensity-scaled generic starting tempo.
  const detected = evidence.target.bpmEst;
  const startBpm = detected
    ? Math.round(Math.min(160, Math.max(44, detected)))
    : intensity === 'advanced' ? 88 : intensity === 'balanced' ? 76 : 66;
  const minBpm = Math.max(40, startBpm - 30);
  const maxBpm = Math.min(176, startBpm + 40);
  const beatCount = intensity === 'advanced' ? 10 : intensity === 'balanced' ? 8 : 6;
  const toleranceMs = intensity === 'advanced' ? 80 : intensity === 'balanced' ? 110 : 150;

  return {
    ...blockBase(evidence, 'rhythm', intensity),
    title: 'Metronome Grid Repair',
    subtitle: 'Lock one note to the click',
    estimatedMinutes: 5,
    instructions: [
      'The app plays a click track — play one note on every click, nothing fancier yet.',
      `Starts at ${startBpm} BPM. Nail it and the tempo climbs; miss it and it eases back down.`,
      'Once the click feels automatic, bring back the original notes at the tempo you landed on.',
    ],
    liveMode: {
      label: 'App plays the click and grades your timing against it',
      signals: ['rhythm'],
      requiresMic: true,
      requiresCamera: false,
      status: 'ready',
    },
    successCriteria: {
      summary: `Land ${Math.round(beatCount * 0.75)} of ${beatCount} clicks within ${toleranceMs}ms, starting at ${startBpm} BPM.`,
      repetitions: beatCount,
    },
    evaluator: { evaluatorId: 'rhythm', startBpm, minBpm, maxBpm, beatCount, toleranceMs, requiredOnTimeFraction: 0.75 },
    fallbackCriteria: 'If click detection is noisy, clap along with an external metronome at the same tempo before playing it.',
    coachPromptContext: `Coach rhythm repair against a click track starting at ${startBpm} BPM. Evidence: ${evidence.evidenceSummary}`,
  };
}

function toneBlock(evidence: RankedPracticeEvidence, intensity: CoachIntensity): PracticeBlock {
  return {
    ...blockBase(evidence, 'tone', intensity),
    title: 'Tone Contact Check',
    subtitle: 'Clean sound before speed',
    estimatedMinutes: 5,
    instructions: [
      'Play slow open-string bows and listen for a clean, centered sound.',
      'Change only one variable at a time: bow speed, arm weight, or contact point.',
      'Repeat the best-sounding stroke until it is reproducible.',
    ],
    liveMode: {
      label: 'Mic checks tone cleanliness',
      signals: ['tone', 'pitch'],
      requiresMic: true,
      requiresCamera: false,
      status: 'ready',
    },
    successCriteria: {
      summary: 'Produce 5 clean long bows without scratch, thin tone, or delayed note speech.',
      repetitions: 5,
    },
    evaluator: { evaluatorId: 'toneFault', requiredCleanFraction: 0.7 },
    fallbackCriteria: 'If tone detection is uncertain, record three open-string bows and compare the cleanest one to the others.',
    coachPromptContext: `Coach tone quality with acoustic evidence: ${evidence.evidenceSummary}`,
  };
}

// Fine-grained tone drills for the two fault families classifyFrames can
// actually tell apart (see toneAnalysis.ts) — everything else still falls
// back to the generic toneBlock above.
function toneFaultBlock(evidence: RankedPracticeEvidence, intensity: CoachIntensity, fault: 'thin' | 'pressure'): PracticeBlock {
  const base = toneBlock(evidence, intensity);
  if (fault === 'thin') {
    return {
      ...base,
      title: 'Bow Weight Trainer',
      instructions: [
        'Play slow open-string bows and listen for a full, centered sound.',
        'Add a little arm weight or slow the bow if the tone feels thin or airy.',
        'Repeat the best-sounding stroke until it is reproducible.',
      ],
      successCriteria: { summary: 'Produce 5 clean long bows with no thin tone.', repetitions: 5 },
      evaluator: { evaluatorId: 'toneFault', disallowedFaults: ['thin'], requiredCleanFraction: 0.7 },
    };
  }
  return {
    ...base,
    title: 'Pressure Release Trainer',
    instructions: [
      'Play slow open-string bows starting with slightly more pressure than usual.',
      'Ease the arm weight until the scratch or roughness clears.',
      'Repeat the cleared stroke until it is reproducible without pressing.',
    ],
    successCriteria: { summary: 'Produce 5 clean long bows with no scratch or rasp.', repetitions: 5 },
    evaluator: { evaluatorId: 'toneFault', disallowedFaults: ['scratch', 'rasp'], requiredCleanFraction: 0.7 },
  };
}

function phraseRepairBlock(evidence: RankedPracticeEvidence, intensity: CoachIntensity): PracticeBlock {
  return {
    ...blockBase(evidence, 'phrase_repair', intensity),
    title: 'Phrase Repair Loop',
    subtitle: 'Musical shape with technical control',
    estimatedMinutes: intensity === 'advanced' ? 8 : 6,
    instructions: [
      'Play only the flagged phrase window.',
      'First pass: simplify rhythm and focus on the target issue.',
      'Second pass: restore musical shape without losing the technical fix.',
    ],
    liveMode: {
      label: 'Mic checks phrase-level change',
      signals: ['pitch', 'tone', 'rhythm'],
      requiresMic: true,
      requiresCamera: false,
      status: 'limited',
    },
    successCriteria: {
      summary: 'Complete 3 phrase repetitions with the flagged issue reduced each time.',
      repetitions: 3,
    },
    fallbackCriteria: 'If phrase tracking is limited, loop the timestamped phrase from the last recording and compare takes.',
    coachPromptContext: `Coach phrase repair. Evidence: ${evidence.evidenceSummary}`,
  };
}

function reviewBlock(
  evidence: RankedPracticeEvidence,
  intensity: CoachIntensity,
  unavailableReason?: string,
): PracticeBlock {
  const exercise = exercisesForMetric(evidence.metricKey)[0];
  const label = METRIC_META[evidence.metricKey]?.label ?? evidence.metricKey;
  return {
    ...blockBase(evidence, 'review', intensity),
    title: exercise?.title ?? `${label} Review`,
    subtitle: 'Targeted drill',
    estimatedMinutes: 5,
    instructions: exercise
      ? [exercise.focus, exercise.instructions]
      : [`Practice ${label.toLowerCase()} slowly and record one check-in take.`],
    liveMode: {
      label: unavailableReason ? 'Review mode' : 'Live check when available',
      signals: evidence.requiresCamera ? ['camera'] : ['pitch'],
      requiresMic: evidence.requiresMic,
      requiresCamera: evidence.requiresCamera,
      status: unavailableReason ? 'limited' : 'ready',
      unavailableReason,
    },
    successCriteria: {
      summary: exercise ? `Complete ${exercise.duration} of focused work, then record one check-in take.` : 'Complete one focused drill and record a check-in take.',
      repetitions: 1,
    },
    fallbackCriteria: 'Use the written drill, then run a normal analysis session to refresh the plan.',
    coachPromptContext: `Coach a fallback drill for ${label}. Evidence: ${evidence.evidenceSummary}`,
  };
}

/**
 * Shown when the player HAS analyzed sessions but nothing was flagged — a clean
 * session. Reinforcement, not the cold-start "record your first take" prompt.
 */
function maintenanceBlocks(intensity: CoachIntensity, weeklyGoalMinutes?: number | null): PracticeBlock[] {
  const short = (weeklyGoalMinutes ?? 30) <= 15;
  const tone: PracticeBlock = {
    id: 'maintenance:tone',
    type: 'tone',
    title: 'Long-Tone Tune-Up',
    subtitle: 'Keep the sound centered',
    reason: 'Nothing was flagged last session — hold the standard with slow, clean bows.',
    estimatedMinutes: 5,
    coachIntensity: intensity,
    instructions: [
      'Play slow whole bows on each open string.',
      'Listen for an even, centered sound from frog to tip.',
      'Add first-position notes only once the open strings ring cleanly.',
    ],
    target: { metricKey: 'toneQuality' },
    liveMode: {
      label: 'Mic checks tone cleanliness',
      signals: ['tone', 'pitch'],
      requiresMic: true,
      requiresCamera: false,
      status: 'ready',
    },
    successCriteria: {
      summary: 'Produce 5 clean, even long bows with steady tone.',
      repetitions: 5,
    },
    evaluator: { evaluatorId: 'toneFault', requiredCleanFraction: 0.7 },
    fallbackCriteria: 'If tone tracking is uncertain, record three open-string bows and compare the cleanest.',
    coachPromptContext: 'Coach a maintenance long-tone session; the player had no flagged issues, so reinforce good habits.',
    evidenceRefs: [],
  };
  if (short) return [tone];
  return [
    tone,
    {
      ...tone,
      id: 'maintenance:scale',
      type: 'scale_lock',
      title: 'Scale Refresh',
      subtitle: 'Reinforce clean intonation',
      reason: 'A clean session is the moment to stretch — run a familiar scale and keep every note in tune.',
      estimatedMinutes: 6,
      instructions: [
        'Warm up the G major scale slowly on your own first.',
        'When you record, a metronome click paces the take — play the note shown on screen on each click, with a clear stop before the next.',
        'Keep the bow speed even so pitch and tone are judged from a stable sound.',
      ],
      target: { metricKey: 'pitchAccuracy', scaleName: 'G major' },
      successCriteria: { summary: 'Complete the scale, keeping all but a note or two in tune.', repetitions: 1, centsThreshold: 12 },
      evaluator: { evaluatorId: 'scale', scaleName: 'G major', centsThreshold: 12 },
      coachPromptContext: 'Coach a maintenance scale for a player with no flagged issues; reinforce and gently extend.',
    },
  ];
}

function starterBlocks(intensity: CoachIntensity, weeklyGoalMinutes?: number | null): PracticeBlock[] {
  const short = (weeklyGoalMinutes ?? 30) <= 15;
  const base: PracticeBlock = {
    id: 'starter:first-analysis',
    type: 'review',
    title: 'First Analysis Baseline',
    subtitle: 'Record before the app personalizes',
    reason: 'No analyzed sessions are available yet, so the fastest next step is to capture a baseline.',
    estimatedMinutes: short ? 5 : 8,
    coachIntensity: intensity,
    instructions: [
      'Record 30-60 seconds of comfortable playing.',
      'Use a passage you can repeat later so progress is comparable.',
      'Keep the full instrument and bow arm in frame if using video.',
    ],
    target: { metricKey: 'pitchAccuracy' },
    liveMode: {
      label: 'Normal recording analysis',
      signals: ['pitch', 'tone', 'camera'],
      requiresMic: true,
      requiresCamera: false,
      status: 'ready',
    },
    successCriteria: {
      summary: 'Complete one clean baseline recording so the next plan can target exact notes and techniques.',
      repetitions: 1,
    },
    fallbackCriteria: 'If video is inconvenient, record audio-only practice and use pitch/tone feedback first.',
    coachPromptContext: 'Guide the user through their first baseline recording.',
    evidenceRefs: [],
  };

  if (short) return [base];
  return [
    base,
    {
      ...base,
      id: 'starter:open-string-tone',
      type: 'tone',
      title: 'Open String Tone Check',
      subtitle: 'Simple live-ready warmup',
      reason: 'Open strings create clean pitch and tone data before note-specific recommendations exist.',
      estimatedMinutes: 5,
      instructions: [
        'Play four slow bows on open D or A.',
        'Keep the bow speed even from frog to tip.',
        'Listen for a centered sound before adding left-hand notes.',
      ],
      target: { metricKey: 'toneQuality' },
      liveMode: {
        label: 'Mic checks tone cleanliness',
        signals: ['tone', 'pitch'],
        requiresMic: true,
        requiresCamera: false,
        status: 'ready',
      },
      successCriteria: {
        summary: 'Play 4 clean open-string bows with steady volume and no scratch.',
        repetitions: 4,
      },
      evaluator: { evaluatorId: 'toneFault', requiredCleanFraction: 0.7 },
      coachPromptContext: 'Coach a simple open-string tone warmup.',
    },
  ];
}

function scaleForPitch(pitchClass: string, skillLevel?: SkillLevel): string {
  const letter = pitchClass.replace(/[^A-G#b]/g, '');
  if (letter.startsWith('A') || letter === 'C#' || letter === 'E') return 'A major';
  if (letter.startsWith('D') || letter === 'F#') return skillLevel === 'advanced' ? 'D melodic minor' : 'D major';
  if (letter.startsWith('G') || letter === 'B') return 'G major';
  if (letter.startsWith('E')) return 'E minor';
  return 'D major';
}

function bowTitle(metricKey: MetricKey): string {
  if (metricKey === 'bowAngle') return 'Parallel Bow Trainer';
  if (metricKey === 'bowPlacement') return 'Contact Point Trainer';
  if (metricKey === 'bowArmLevel') return 'String-Level Arm Trainer';
  if (metricKey === 'bowDistribution') return 'Full-Bow Distribution Trainer';
  return 'Bow Control Trainer';
}

function bowInstruction(metricKey: MetricKey): string {
  if (metricKey === 'bowAngle') return 'Aim for a bow path parallel to the bridge across the full stroke.';
  if (metricKey === 'bowPlacement') return 'Keep the contact point in the normal lane between bridge and fingerboard.';
  if (metricKey === 'bowArmLevel') return 'Set the elbow height before each string change.';
  if (metricKey === 'bowDistribution') return 'Use the frog, middle, and tip instead of staying in one small zone.';
  return 'Keep the bow path quiet and repeatable.';
}

function bowSuccess(metricKey: MetricKey, intensity: CoachIntensity): string {
  const reps = intensity === 'advanced' ? 8 : 5;
  if (metricKey === 'bowDistribution') return `Use at least 70% of the bow across ${reps} slow strokes.`;
  if (metricKey === 'bowAngle') return `Keep bow angle controlled for ${reps} slow strokes.`;
  if (metricKey === 'bowPlacement') return `Keep contact point in the normal lane for ${reps} slow strokes.`;
  if (metricKey === 'bowArmLevel') return `Pre-set the arm level correctly on ${reps} string changes.`;
  return `Complete ${reps} controlled bow strokes with stable camera tracking.`;
}

// Placeholder thresholds — need calibrating against real footage before shipping.
function bowGeometryTarget(metricKey: MetricKey): BowGeometryTarget {
  if (metricKey === 'bowAngle') return { signal: 'bowAngle', minValue: -15, maxValue: 15, requiredGoodFraction: 0.7 };
  if (metricKey === 'bowPlacement') return { signal: 'stringPos', minValue: 0.35, maxValue: 0.65, requiredGoodFraction: 0.7 };
  if (metricKey === 'bowDistribution') return { signal: 'bowDistribution', minRobustRange: 0.6 };
  return { signal: 'bowAngle', minValue: -15, maxValue: 15, requiredGoodFraction: 0.7 };
}
