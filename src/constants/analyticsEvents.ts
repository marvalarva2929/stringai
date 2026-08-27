/**
 * The analytics event catalogue — the single source of truth for every event
 * name and enumerated parameter value the app reports.
 *
 * Why a catalogue instead of inline string literals: GA4 silently drops what it
 * dislikes. Event names over 40 characters, parameter names over 40, and values
 * over 100 are accepted by the SDK and then never appear in a report, with no
 * error anywhere. Centralising the names makes them reviewable in one place and
 * lets `test/analyticsUserProps.test.ts` assert the limits mechanically.
 *
 * Reserved names (`error`, `first_open`, `session_start`, `screen_view`,
 * `in_app_purchase`, `app_update`, `app_remove`, `user_engagement`, `ad_*`) may
 * not be used for custom events — hence `app_error` rather than `error`. Where
 * GA4 defines a *recommended* name we use it verbatim (`login`, `sign_up`,
 * `begin_checkout`, `purchase`) so the built-in monetisation and user-acquisition
 * reports populate without extra configuration.
 */

export const AnalyticsEvent = {
  // --- Onboarding ---------------------------------------------------------
  ONBOARDING_START: 'onboarding_start',
  ONBOARDING_STEP_VIEW: 'onboarding_step_view',
  ONBOARDING_STEP_COMPLETE: 'onboarding_step_complete',
  ONBOARDING_PERMISSION_RESULT: 'onboarding_permission_result',
  ONBOARDING_COMPLETE: 'onboarding_complete',
  SIGN_UP: 'sign_up', // GA4 recommended
  LOGIN: 'login', // GA4 recommended
  AUTH_FAILED: 'auth_failed',

  // --- Activation ---------------------------------------------------------
  ACTIVATION_START: 'activation_start',
  ACTIVATION_STEP: 'activation_step',
  ACTIVATION_DISMISSED: 'activation_dismissed',
  ACTIVATION_COMPLETE: 'activation_complete',
  COACHMARK_VIEW: 'coachmark_view',
  COACHMARK_SKIP: 'coachmark_skip',

  // --- Capture & analysis -------------------------------------------------
  ANALYSIS_FLOW_START: 'analysis_flow_start',
  PIECE_SELECTED: 'piece_selected',
  CAPTURE_METHOD_SELECTED: 'capture_method_selected',
  CAPTURE_GATE_BLOCKED: 'capture_gate_blocked',
  PERMISSION_RESULT: 'permission_result',
  RECORDING_STARTED: 'recording_started',
  RECORDING_STOPPED: 'recording_stopped',
  RECORDING_FAILED: 'recording_failed',
  UPLOAD_PICKER_OPENED: 'upload_picker_opened',
  UPLOAD_PICKER_CANCELLED: 'upload_picker_cancelled',
  ANALYSIS_STARTED: 'analysis_started',
  ANALYSIS_QUOTA_DENIED: 'analysis_quota_denied',
  ANALYSIS_COMPLETED: 'analysis_completed',
  ANALYSIS_FAILED: 'analysis_failed',
  ANALYSIS_DEGRADED: 'analysis_degraded',
  ANALYSIS_ABANDONED: 'analysis_abandoned',
  SESSION_SAVE_FAILED: 'session_save_failed',

  // --- Coaching (L10) -----------------------------------------------------
  COACHING_REQUESTED: 'coaching_requested',
  COACHING_SUCCEEDED: 'coaching_succeeded',
  COACHING_FAILED: 'coaching_failed',

  // --- Results ------------------------------------------------------------
  RESULTS_VIEWED: 'results_viewed',
  RESULTS_PAGE_VIEW: 'results_page_view',
  RESULTS_EXIT: 'results_exit',
  METRIC_DETAIL_OPEN: 'metric_detail_open',
  CHAT_OPENED: 'chat_opened',
  CHAT_MESSAGE_SENT: 'chat_message_sent',

  // --- Practice -----------------------------------------------------------
  PRACTICE_PLAN_VIEW: 'practice_plan_view',
  PRACTICE_BLOCK_START: 'practice_block_start',
  PRACTICE_BLOCK_COMPLETE: 'practice_block_complete',
  PRACTICE_BLOCK_RETAKE: 'practice_block_retake',
  PRACTICE_BLOCK_SKIP_TAKE: 'practice_block_skip_take',
  PRACTICE_BLOCK_SKIP: 'practice_block_skip',
  PRACTICE_PLAN_COMPLETE: 'practice_plan_complete',
  PRACTICE_PLAN_ABANDONED: 'practice_plan_abandoned',

  // --- Habit & retention --------------------------------------------------
  STREAK_EXTENDED: 'streak_extended',
  STREAK_BROKEN: 'streak_broken',
  STREAK_MILESTONE: 'streak_milestone',
  WEEKLY_GOAL_SET: 'weekly_goal_set',
  WEEKLY_GOAL_MET: 'weekly_goal_met',
  REMINDER_ENABLED: 'reminder_enabled',
  REMINDER_DISABLED: 'reminder_disabled',
  REMINDER_NOTIF_OPEN: 'reminder_notif_open',
  RESURRECTED: 'resurrected',

  // --- Monetisation -------------------------------------------------------
  PAYWALL_VIEW: 'paywall_view',
  PAYWALL_PLAN_SELECTED: 'paywall_plan_selected',
  PAYWALL_DISMISS: 'paywall_dismiss',
  BEGIN_CHECKOUT: 'begin_checkout', // GA4 recommended
  PURCHASE: 'purchase', // GA4 recommended — drives revenue reporting
  TRIAL_STARTED: 'trial_started',
  PURCHASE_CANCELLED: 'purchase_cancelled',
  PURCHASE_FAILED: 'purchase_failed',
  RESTORE_STARTED: 'restore_started',
  RESTORE_RESULT: 'restore_result',
  OFFERINGS_UNAVAILABLE: 'offerings_unavailable',
  MANAGE_SUBSCRIPTION_OPEN: 'manage_subscription_open',

  // --- Quality ------------------------------------------------------------
  REVIEW_PROMPT_SHOWN: 'review_prompt_shown',
  REVIEW_PROMPT_RESULT: 'review_prompt_result',
  FEEDBACK_SUBMITTED: 'feedback_submitted',
  SUPPORT_LINK_OPEN: 'support_link_open',

  // --- Errors -------------------------------------------------------------
  APP_ERROR: 'app_error',
} as const;

export type AnalyticsEventName = (typeof AnalyticsEvent)[keyof typeof AnalyticsEvent];

/**
 * The GA4 recommended events. Firebase gives these dedicated, strongly typed
 * loggers (`logPurchase`, `logBeginCheckout`, ...) and rejects them from the
 * generic custom-event call, so `track()` excludes them and services/analytics.ts
 * exposes a purpose-built function for each.
 */
export type TypedAnalyticsEventName =
  | typeof AnalyticsEvent.SIGN_UP
  | typeof AnalyticsEvent.LOGIN
  | typeof AnalyticsEvent.BEGIN_CHECKOUT
  | typeof AnalyticsEvent.PURCHASE;

export type CustomAnalyticsEventName = Exclude<AnalyticsEventName, TypedAnalyticsEventName>;

/**
 * Where a paywall was shown from.
 *
 * Since the app went subscription-only there is essentially one: the wall at
 * the end of activation, which every user meets. The in-app upsell sources
 * (quota walls, locked features, the tab star) are gone with the free tier —
 * there is no one inside the app left to upsell. `settings` survives for the
 * manage-subscription path.
 */
export type PaywallSource =
  | 'activation_gate'
  | 'settings'
  | 'unknown';

/** The stage of `processMedia` that threw. Mirrors its ordered steps. */
export type AnalysisFailureStage =
  | 'consume'
  | 'audio'
  | 'video'
  | 'pipeline'
  | 'assemble'
  | 'recording';

/**
 * A run that produced a result but not a trustworthy one — the paths where the
 * app silently substitutes mock metrics. Invisible before this instrumentation.
 */
export type AnalysisDegradedReason = 'not_wav' | 'no_video_frames' | 'persist_failed';

/** Which capture engine produced the recording. */
export type CaptureEngine = 'pose_camera' | 'expo_camera';

/** Runtime permissions the app asks for, including ATT. */
export type TrackedPermission =
  | 'camera'
  | 'microphone'
  | 'photo_library'
  | 'notifications'
  | 'att';

/**
 * `diagnostic` is the first-run scale take. Separated from `record` because its
 * conversion value is entirely different — it is the only analysis that happens
 * before the paywall, so its completion rate is the funnel's tightest coupling
 * to trial starts.
 */
export type AnalysisSource = 'record' | 'upload' | 'demo' | 'diagnostic';

export type SubscriptionPlan = 'monthly' | 'annual';

/** Bucket boundaries for the `streak_bkt` user property. */
export const STREAK_BUCKETS = [1, 3, 7, 14, 30] as const;

/** Bucket boundaries for the `session_count_bkt` user property. */
export const SESSION_COUNT_BUCKETS = [1, 2, 5, 10, 25] as const;

/** Streak lengths worth celebrating — emitted as `streak_milestone`. */
export const STREAK_MILESTONES = [3, 7, 14, 30, 60, 100] as const;

/** GA4 hard limits. Enforced by `src/services/analytics.ts` and asserted in tests. */
export const GA4_LIMITS = {
  EVENT_NAME: 40,
  PARAM_NAME: 40,
  PARAM_VALUE: 100,
  PARAMS_PER_EVENT: 25,
  USER_PROPERTY_NAME: 24,
  USER_PROPERTY_VALUE: 36,
  USER_PROPERTIES: 25,
} as const;
