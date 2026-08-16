-- 006 — Retire the free tier.
--
-- StringAI is subscription-only: the client shows a mandatory paywall at the
-- end of the activation flow, so there is no longer a metered free experience
-- to enforce. The daily-analysis quota introduced in 004 has no callers left.
--
-- Safe to drop rather than deprecate: this ships before the app is public, so
-- no row depends on any of it.

-- ── The quota RPCs ────────────────────────────────────────────
-- consume_analysis() was the server's only writer for the daily cap and
-- get_analyses_used_today() fed the "2 of 3 left" hint. Both are unreferenced
-- now; useEntitlementStore no longer talks to the database at all.
drop function if exists public.consume_analysis();
drop function if exists public.get_analyses_used_today();

-- ── The quota columns ─────────────────────────────────────────
alter table public.profiles
  drop column if exists analyses_used_today,
  drop column if exists analyses_count_date;

-- ── The legacy tier column ────────────────────────────────────
-- Superseded by `entitlement` in 004 (which backfilled from it) and unread
-- since. The client type dropped its @deprecated mirror in the same change.
alter table public.profiles
  drop column if exists subscription_tier;

-- Note: profiles.entitlement, entitlement_expires_at, trial_ends_at and
-- rc_customer_id all stay. The RevenueCat webhook still mirrors onto them and
-- the analyze-feedback / session-chat functions still gate on them, which is
-- what stops a client with a patched entitlement from spending Claude tokens.
