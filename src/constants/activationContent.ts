/**
 * Copy for the first-run activation flow, kept here for the same reason
 * onboardingContent.ts exists: the wording of a first-run flow gets rewritten
 * far more often than the screens do. The coachmark scripts themselves live in
 * activationScript.ts, alongside their targeting.
 */

export const REVIEW_COPY = {
  title: 'Enjoying StringAI?',
  body: "You've just been through the whole loop — record, see what to fix, practice it. Worth telling us how that landed?",
  positive: 'Loving it',
  negative: 'Not really',

  feedbackTitle: 'What would make it better?',
  feedbackBody: "This goes straight to us, not to the App Store. Be blunt — it's more useful that way.",
  feedbackPlaceholder: 'What got in your way?',
  feedbackSend: 'Send',
  feedbackSkip: 'No thanks',
  feedbackThanks: 'Thanks — that helps.',
};
