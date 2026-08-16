/**
 * What shipped, and what's next.
 *
 * The point of showing this in-app is that StringAI is openly one person's
 * project, and a visible cadence is the difference between "half finished" and
 * "actively being built" — the same gap turns a missing feature from a reason
 * to cancel into a reason to stay and watch. It only works if it stays current:
 * a changelog whose newest entry is three months old argues the opposite of
 * what it is here to argue.
 *
 * Keep entries short and concrete, newest first, and written in terms of what
 * the player can now do rather than what changed in the code. Dates are ISO so
 * they sort and format predictably.
 */

export interface ChangelogEntry {
  /** ISO date, YYYY-MM-DD. */
  date: string;
  /** App version this shipped in, when it maps to one. */
  version?: string;
  changes: string[];
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    date: '2026-08-11',
    version: '1.0.0',
    changes: [
      'Your first session is now a real recording of your own playing, analysed on the spot — no more sample take.',
      'Account creation moved to after you subscribe, so nothing stands between you and your first analysis.',
      'Send Feedback in Settings now goes straight to me.',
      'Trial reminders lead with what you actually practised, not just the billing date.',
    ],
  },
];

/** What is being worked on next. Honest about order, silent about dates. */
export const UP_NEXT: string[] = [
  'Calibrating intonation detection against a library of real recordings',
  'Bow and posture scoring folded into your overall score once measurement is reliable',
  'Viola and cello support',
];
