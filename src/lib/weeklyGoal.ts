import type { SessionSummary } from '../types/analysis';

// Weekly practice commitment tiers offered during onboarding and in the goal modal.
// Minutes are calibrated to recorded in-app practice (sessions are short clips),
// not total time spent with the instrument.
export interface GoalTier {
  id: string;
  label: string;
  minutes: number;
  sublabel: string;
  reinforcement: string;
}

export const GOAL_TIERS: GoalTier[] = [
  {
    id: 'casual',
    label: 'Casual',
    minutes: 15,
    sublabel: '~2 min a day',
    reinforcement: "Practice 15 min a week and you'll build a habit that sticks!",
  },
  {
    id: 'regular',
    label: 'Regular',
    minutes: 30,
    sublabel: '~5 min a day',
    reinforcement: "Practice 30 min a week and you'll hear real progress within a month!",
  },
  {
    id: 'serious',
    label: 'Serious',
    minutes: 60,
    sublabel: '~10 min a day',
    reinforcement: "Practice 60 min a week and you'll see amazing results!",
  },
  {
    id: 'intense',
    label: 'Intense',
    minutes: 120,
    sublabel: '~20 min a day',
    reinforcement: "120 min a week? That's how virtuosos are made!",
  },
];

export const RECOMMENDED_TIER_ID = 'regular';

// Monday 00:00 local time — Duolingo-style calendar week.
export function getWeekStart(now = new Date()): Date {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const day = start.getDay(); // 0 = Sunday
  const daysSinceMonday = (day + 6) % 7;
  start.setDate(start.getDate() - daysSinceMonday);
  return start;
}

export function minutesPracticedThisWeek(
  history: SessionSummary[],
  now = new Date(),
): number {
  const start = getWeekStart(now).getTime();
  const seconds = history
    .filter((s) => new Date(s.recordedAt).getTime() >= start)
    .reduce((sum, s) => sum + (s.durationSeconds || 0), 0);
  if (seconds === 0) return 0;
  // A first short clip still registers as 1 min so progress feels immediate.
  return Math.max(1, Math.round(seconds / 60));
}
