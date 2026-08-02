import type { CoachIntensity, PracticeBlock, PracticeBlockType, LiveSignal } from './practiceBlocks';
import { pitchClassInfo, noteNameToMidi } from './pitchNaming';

// Ionicons names used across practice UI. Kept as a local union so this copy
// module stays free of any UI-library imports.
export type IoniconName =
  | 'mic'
  | 'camera'
  | 'timer'
  | 'volume-high'
  | 'pulse'
  | 'flag'
  | 'repeat'
  | 'musical-note'
  | 'ellipse'
  | 'body'
  | 'radio-button-on';

export interface RunnerStep {
  eyebrow: string;
  title: string;
  body: string;
  callout: string;
  icon: IoniconName;
}

/**
 * One-line description of the concrete musical target of a block. When a MIDI
 * note is resolvable, uses the real fingering prose ("B3, 2nd finger on G
 * string") from referenceNote.ts instead of just the bare note name.
 */
export function targetLine(block: PracticeBlock): string {
  const { target } = block;
  const midi = target.midiNote ?? (target.noteName ? noteNameToMidi(target.noteName) : null);

  if (midi != null) {
    const parts = [pitchClassInfo(target.pitchClass ?? target.noteName ?? '', midi).description];
    if (target.scaleName) parts.push(target.scaleName);
    if (target.tendency) parts.push(target.tendency);
    return parts.join(' · ');
  }

  const parts: string[] = [];
  if (target.noteName || target.pitchClass) {
    parts.push(target.noteName ?? target.pitchClass!);
  }
  if (target.string) parts.push(`${target.string} string`);
  if (target.finger != null) parts.push(`finger ${target.finger === 0 ? 'open' : target.finger}`);
  if (target.scaleName) parts.push(target.scaleName);
  if (target.tendency) parts.push(target.tendency);
  return parts.length > 0 ? parts.join(' · ') : block.title;
}

/** The sound the player should be listening for, per block type. */
export function toneCue(block: PracticeBlock): string {
  switch (block.type) {
    case 'pitch_landing':
    case 'scale_lock':
      return 'a centered note attack';
    case 'vibrato':
      return 'a steady, even oscillation';
    case 'bow_control':
      return 'a smooth, controlled bow path';
    case 'tone':
      return 'a clean, open sound';
    case 'rhythm':
      return 'steady time on the beat';
    default:
      return 'a clear, repeatable sound';
  }
}

export function signalIcon(signal: LiveSignal | string): IoniconName {
  if (signal === 'camera' || signal === 'bow' || signal === 'posture') return 'camera';
  if (signal === 'rhythm') return 'timer';
  if (signal === 'tone') return 'volume-high';
  if (signal === 'vibrato') return 'pulse';
  return 'mic';
}

/** Accent color for a block type, used to tint its visual graphic tile. */
export function blockAccent(type: PracticeBlockType): string {
  switch (type) {
    case 'pitch_landing':
      return '#0284c7';
    case 'scale_lock':
      return '#0369a1';
    case 'vibrato':
      return '#7c3aed';
    case 'bow_control':
      return '#d97706';
    case 'rhythm':
      return '#0d9488';
    case 'tone':
      return '#db2777';
    case 'phrase_repair':
      return '#4f46e5';
    default:
      return '#475569';
  }
}

/** Icon representing a block on the path / in headers. */
export function blockIcon(type: PracticeBlockType): IoniconName {
  switch (type) {
    case 'vibrato':
      return 'pulse';
    case 'bow_control':
      return 'body';
    case 'rhythm':
      return 'timer';
    case 'tone':
      return 'volume-high';
    default:
      return 'musical-note';
  }
}

function coachCopyFor(coach: CoachIntensity): string {
  if (coach === 'guided') return 'Move slowly. Change one thing at a time.';
  if (coach === 'advanced') return 'Keep the reps efficient and judge the musical result, not just the count.';
  return 'Stay focused on the pass condition, then move on.';
}

/**
 * Turns a block's real `instructions[]` into ordered lesson steps for the
 * runner (replacing the previous 3 hard-coded templates). The final step frames
 * the live check using the block's own success/fallback criteria.
 */
export function buildRunnerSteps(block: PracticeBlock, coach: CoachIntensity): RunnerStep[] {
  const instructions = block.instructions.length > 0 ? block.instructions : [block.reason];
  const coachCopy = coachCopyFor(coach);
  const total = instructions.length;

  return instructions.map((instruction, i) => {
    const isLast = i === total - 1;
    const isFirst = i === 0;
    return {
      eyebrow: `Step ${i + 1} of ${total}`,
      title: isFirst ? 'Set the target' : isLast ? 'Ready your take' : `Rep ${i}`,
      body: instruction,
      callout: isLast
        ? block.liveMode.status === 'unavailable'
          ? block.fallbackCriteria
          : `Listen for ${toneCue(block)}, then record. Pass condition: ${block.successCriteria.summary}`
        : `${coachCopy} Target: ${targetLine(block)}.`,
      icon: isLast ? (block.liveMode.requiresCamera ? 'camera' : 'mic') : isFirst ? 'flag' : 'repeat',
    };
  });
}

/** Short coaching line shown in the coach bubble for the current step. */
export function coachHint(block: PracticeBlock, stepIndex: number, coach: CoachIntensity): string {
  const total = block.instructions.length || 1;
  if (stepIndex === 0) return 'Know the target note, string, and pass condition before the first bow stroke.';
  if (stepIndex >= total - 1) return block.coachPromptContext;
  if (coach === 'guided') return 'Keep the reps slow and repeat the same exact target until it is automatic.';
  return 'Do not add difficulty until the target is boringly repeatable.';
}
