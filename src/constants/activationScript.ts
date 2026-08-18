/**
 * The coachmark scripts for the first-run activation walkthrough.
 *
 * Copy lives here for the same reason onboardingContent.ts exists: the wording
 * of a first-run flow gets rewritten far more often than its mechanics, and it
 * shouldn't mean editing a 2,900-line carousel to change a sentence.
 *
 * `targetId` refers to a view registered with useSpotlightTarget(). Steps run in
 * array order, one per screen-stage, and the user advances them by tapping —
 * they never have to find the right gesture to escape a tooltip.
 */

export interface SpotlightStep {
  id: string;
  /** Matches the id passed to useSpotlightTarget at the call site. */
  targetId: string;
  title: string;
  body: string;
  /** Preferred side for the tooltip. Falls back to whichever side fits. */
  placement?: 'above' | 'below';
  /** Cutout corner radius. Match the element's own so the hole hugs its shape. */
  radius?: number;
  /** Copy for the advance button. Defaults to 'Next', or 'Got it' on the last step. */
  cta?: string;
  /** Carousel page this step belongs on — the host scrolls there when it opens. */
  page?: number;
}

// ── The home screen ───────────────────────────────────────────
//
// The first thing after onboarding. Rather than a tour that describes the app,
// this walks the real home screen in the order a new player would use it:
// warm up, see where you stand, then record.

export const HOME_COACHMARKS: SpotlightStep[] = [
  {
    id: 'home.plan',
    targetId: 'home.plan',
    title: 'Start here every day',
    body: 'Your daily warm-up — a short set of drills rebuilt each morning from what your playing has actually needed. Run it before you practice.',
    placement: 'below',
    radius: 22,
  },
  {
    id: 'home.stats',
    targetId: 'home.stats',
    title: 'Your streak and your score',
    body: 'Days practiced in a row, and your average session score. Both move as you record — they are the fastest read on whether things are improving.',
    placement: 'below',
    radius: 22,
  },
  {
    id: 'home.record',
    targetId: 'home.record',
    title: 'Practice',
    body: "This is where the real feedback comes from. Play something you know and I'll tell you exactly what to fix. Let's do one now.",
    placement: 'above',
    radius: 18,
    cta: "Let's go",
  },
];

// ── The capture screen ────────────────────────────────────────
//
// Three steps across two phases: name the piece, then one step per recording
// method. Highlighting both method buttons at once said nothing about either.
//
// Every one of these advances on a tap. The walkthrough drives the screen
// itself — it never waits for the user to type a piece name or actually
// record, because those are the points the flow used to strand them.

export const PIECE_COACHMARKS: SpotlightStep[] = [
  {
    id: 'piece.search',
    targetId: 'piece.search',
    title: 'Say what you are playing',
    body: 'Name the piece before you record and I can track it over time — how it sounded last week, what it still needs.',
    placement: 'below',
    radius: 14,
    cta: 'Next',
  },
];

export const CAPTURE_COACHMARKS: SpotlightStep[] = [
  {
    id: 'capture.record',
    targetId: 'capture.record',
    title: 'Record in real time',
    body: 'Prop your phone where it can see your bow and your left hand, then play. You get live coaching while you go, and the full breakdown after.',
    placement: 'below',
    radius: 18,
  },
  {
    id: 'capture.upload',
    targetId: 'capture.upload',
    title: 'Or upload a video',
    body: 'Already have a clip on your phone? Pick it here and it gets the same analysis. Thirty seconds of playing is enough to work with.',
    placement: 'below',
    radius: 18,
    // Leads into the real diagnostic take, not the sample — so the CTA has to
    // promise the user's own playing rather than "an analysis" in the abstract.
    cta: "Let's hear you play",
  },
];

// ── The results carousel ──────────────────────────────────────
//
// Page indices track PAGES in ResultsCarousel.tsx:
//   0 celebration · 1 overview · 2 intonation · … · 9 chat
// A step that names a page scrolls the carousel there as it opens, so the
// walkthrough can't get out of sync with what's behind it.

const OVERVIEW_PAGE_INDEX = 1;
export { OVERVIEW_PAGE_INDEX };

// Every target here is either in the fixed bottom nav or in the title strip at
// the top of a page — i.e. always on screen. Pointing at something inside a
// page's own vertical scroll view risks a cutout over content below the fold.
export const CAROUSEL_COACHMARKS: SpotlightStep[] = [
  {
    id: 'carousel.score',
    targetId: 'carousel.score',
    title: 'Your session score',
    body: 'One number for the whole take, and one for each skill as you move through the cards. It moves as you play more — the direction matters, not the digit.',
    placement: 'below',
    radius: 12,
    page: OVERVIEW_PAGE_INDEX,
  },
  {
    id: 'carousel.video',
    targetId: 'carousel.video',
    title: 'Jump to any moment',
    body: 'Your recording sits at the top of every card. Tap a flagged moment below it and playback seeks straight there, so you hear exactly what I heard.',
    placement: 'below',
    radius: 12,
    page: OVERVIEW_PAGE_INDEX,
  },
  {
    id: 'carousel.dots',
    targetId: 'carousel.dots',
    title: 'One card per skill',
    body: 'Intonation, tone, rhythm, bow, posture — a card each, in that order. Swipe between them, or tap a dot to jump.',
    placement: 'above',
    radius: 14,
    page: OVERVIEW_PAGE_INDEX,
  },
  {
    id: 'carousel.next',
    targetId: 'carousel.next',
    title: 'Then go practice it',
    body: 'Work through the cards and this button turns into Practice on the last one. Everything you just saw becomes a short set of drills — let me show you.',
    placement: 'above',
    radius: 16,
    cta: 'Show me',
  },
];

// ── The practice plan ─────────────────────────────────────────

export const PRACTICE_COACHMARKS: SpotlightStep[] = [
  {
    id: 'practice.path',
    targetId: 'practice.path',
    title: 'Your drills',
    body: 'Each stop is one short exercise aimed at something specific from your recording. Play it and I grade the take.',
    placement: 'below',
    radius: 20,
  },
  {
    id: 'practice.start',
    targetId: 'practice.start',
    title: 'Start whenever you like',
    body: "That's the whole loop: warm up, record, see what to fix, drill it. Tap here when you're ready to play.",
    placement: 'above',
    radius: 18,
    cta: 'Got it',
  },
];
