import { SkillLevel } from '../types/user';
import { PlayerCategory } from '../types/analysis';
import { IconSpec } from '../components/onboarding/OnboardingIcon';

// Single editable source for all onboarding copy: the welcome screen, goals,
// time/experience options, the instrument-setup checklist, the Pro upsell,
// and reminder presets/notification text. Change wording here only. Tile
// titles are kept short — they render in a 2-column icon grid with no room
// for a wrapped multi-line description.

export interface OptionDef {
  id: string;
  icon: IconSpec;
  title: string;
}

// ─────────────────────────────────────────────────────────────
// Welcome screen — the one screen that sells the app before asking anything.
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// Learning goals (multi-select)
// ─────────────────────────────────────────────────────────────

export const LEARNING_GOALS: OptionDef[] = [
  { id: 'fun_hobby', icon: { lib: 'ion', name: 'happy-outline' }, title: 'For Fun' },
  { id: 'favorite_songs', icon: { lib: 'ion', name: 'heart-outline' }, title: 'Favorite Songs' },
  { id: 'classical_technique', icon: { lib: 'ion', name: 'school-outline' }, title: 'Classical Technique' },
  { id: 'performance_prep', icon: { lib: 'ion', name: 'trophy-outline' }, title: 'Performance Prep' },
  { id: 'play_with_others', icon: { lib: 'ion', name: 'people-outline' }, title: 'Play With Others' },
  { id: 'daily_relaxation', icon: { lib: 'ion', name: 'leaf-outline' }, title: 'Relaxation' },
];

// ─────────────────────────────────────────────────────────────
// Daily practice time → weekly goal tier
// Mapped onto src/lib/weeklyGoal.ts GOAL_TIERS so weeklyGoalMinutes stays the
// single source of truth for WeeklyGoalCard / useDailyPracticePlan / goal.tsx.
// Tier sublabels: casual ~2min/day, regular ~5min/day, serious ~10min/day,
// intense ~20min/day.
// ─────────────────────────────────────────────────────────────

export interface DailyTimeOption extends OptionDef {
  weeklyTierId: 'casual' | 'regular' | 'serious' | 'intense';
  recommended?: boolean;
}

export const DAILY_TIME_OPTIONS: DailyTimeOption[] = [
  { id: 'five', icon: { lib: 'ion', name: 'time-outline' }, title: '5 min/day', weeklyTierId: 'regular' },
  { id: 'ten_fifteen', icon: { lib: 'ion', name: 'alarm-outline' }, title: '10–15 min/day', weeklyTierId: 'serious' },
  { id: 'twenty_plus', icon: { lib: 'ion', name: 'flame-outline' }, title: '20+ min/day', weeklyTierId: 'intense' },
  { id: 'flexible', icon: { lib: 'ion', name: 'partly-sunny-outline' }, title: 'Flexible', weeklyTierId: 'regular', recommended: true },
];

// ─────────────────────────────────────────────────────────────
// Experience level
// ─────────────────────────────────────────────────────────────

export interface ExperienceOption extends OptionDef {
  skillLevel: SkillLevel;
  playerCategory: PlayerCategory;
}

export const EXPERIENCE_LEVELS: ExperienceOption[] = [
  { id: 'complete_beginner', icon: { lib: 'mci', name: 'sprout-outline' }, title: 'Complete Beginner', skillLevel: 'beginner', playerCategory: 'foundation' },
  { id: 'beginner', icon: { lib: 'ion', name: 'book-outline' }, title: 'Beginner', skillLevel: 'beginner', playerCategory: 'foundation' },
  { id: 'intermediate', icon: { lib: 'ion', name: 'locate-outline' }, title: 'Intermediate', skillLevel: 'intermediate', playerCategory: 'refinement' },
  { id: 'advanced', icon: { lib: 'ion', name: 'ribbon-outline' }, title: 'Advanced', skillLevel: 'advanced', playerCategory: 'refinement' },
];

// ─────────────────────────────────────────────────────────────
// Instrument setup checklist
// ─────────────────────────────────────────────────────────────

export const VIOLIN_SIZES: OptionDef[] = [
  { id: 'full_4_4', icon: { lib: 'mci', name: 'violin' }, title: 'Full Size (4/4)' },
  { id: 'three_quarter', icon: { lib: 'mci', name: 'violin' }, title: '3/4 Size' },
  { id: 'half_or_smaller', icon: { lib: 'mci', name: 'violin' }, title: '1/2 or Smaller' },
  { id: 'not_sure', icon: { lib: 'ion', name: 'help-circle-outline' }, title: 'Not Sure' },
];

export const ACCESSORIES: OptionDef[] = [
  { id: 'bow', icon: { lib: 'ion', name: 'musical-note-outline' }, title: 'Bow' },
  { id: 'rosin', icon: { lib: 'mci', name: 'cube-outline' }, title: 'Rosin' },
  { id: 'tuner', icon: { lib: 'mci', name: 'tune' }, title: 'Tuner' },
  { id: 'shoulder_rest', icon: { lib: 'ion', name: 'body-outline' }, title: 'Shoulder Rest' },
];

export const HANDEDNESS_OPTIONS: OptionDef[] = [
  { id: 'right', icon: { lib: 'ion', name: 'hand-right-outline' }, title: 'Right-Handed' },
  { id: 'left', icon: { lib: 'ion', name: 'hand-left-outline' }, title: 'Left-Handed' },
];

export const FOCUS_OPTIONS: OptionDef[] = [
  { id: 'tone', icon: { lib: 'ion', name: 'musical-notes-outline' }, title: 'Tone Quality' },
  { id: 'speed', icon: { lib: 'ion', name: 'flash-outline' }, title: 'Speed & Agility' },
  { id: 'balanced', icon: { lib: 'mci', name: 'scale-balance' }, title: 'Balanced' },
];

// ─────────────────────────────────────────────────────────────
// Reminder time presets + notification copy
// ─────────────────────────────────────────────────────────────

export interface ReminderTimePreset {
  id: string;
  label: string;
  hour: number;
  minute: number;
}

export const REMINDER_TIME_PRESETS: ReminderTimePreset[] = [
  { id: 'morning', label: 'Morning · 8:00 AM', hour: 8, minute: 0 },
  { id: 'midday', label: 'Midday · 12:30 PM', hour: 12, minute: 30 },
  { id: 'evening', label: 'Evening · 5:30 PM', hour: 17, minute: 30 },
  { id: 'night', label: 'Night · 8:00 PM', hour: 20, minute: 0 },
];

export const REMINDER_NOTIFICATION = {
  title: 'Time to practice 🎻',
  body: "A few minutes today keeps your progress moving — let's warm up.",
};

// ─────────────────────────────────────────────────────────────
// Step copy
// ─────────────────────────────────────────────────────────────

export const STEP_COPY = {
  welcome: {
    title: 'String AI',
    subtitle: 'Your personal violin tutor',
    cta: 'Next',
  },
  goals: {
    title: 'What are your violin goals?',
    subtitle: 'Pick everything that applies.',
  },
  time: {
    title: 'How much time do you want to practice daily?',
    subtitle: "We'll set a weekly goal that fits your schedule.",
  },
  experience: {
    title: "What's your current violin experience?",
    subtitle: 'This helps us pitch feedback at the right level.',
  },
  violinSize: {
    title: 'What size is your violin?',
    subtitle: 'Most adults play full size (4/4).',
  },
  accessories: {
    title: 'What do you already have?',
    subtitle: 'Bow, rosin, tuner — whatever you have on hand.',
  },
  preferences: {
    title: 'A couple of preferences',
    subtitle: 'Helps us tailor posture and coaching cues.',
  },
  permissions: {
    title: 'Camera & Microphone',
    subtitle: 'StringAI needs these to analyze your playing and give personalized feedback.',
    reminderTitle: 'Daily practice reminder',
    reminderSubtitle: "We'll send one gentle nudge at a time you choose.",
  },
  account: {
    title: 'Save your progress',
    subtitle: 'Create an account to back up your sessions and access them anywhere.',
    closing: "Next: record a quick take so StringAI can calibrate your first session.",
    skip: 'Skip for now',
    cta: 'Create Account',
  },
};
