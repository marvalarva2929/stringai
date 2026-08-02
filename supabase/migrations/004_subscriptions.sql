-- Subscriptions: RevenueCat-backed `pro` entitlement, a server-enforced free
-- daily analysis cap, and the two security fixes those depend on.
--
-- Tiers: free (3 analyses/day, upload only, no Claude coaching) and pro
-- (unlimited). The 7-day App Store trial grants `pro`, so there is no separate
-- trial tier — trial_ends_at is display-only.

-- ── entitlement columns ──────────────────────────────────────
alter table public.profiles
  add column if not exists rc_customer_id         text,
  add column if not exists entitlement            text not null default 'free'
                                                  check (entitlement in ('free', 'pro')),
  add column if not exists entitlement_expires_at timestamptz,
  add column if not exists trial_ends_at          timestamptz,
  add column if not exists analyses_used_today    int  not null default 0,
  add column if not exists analyses_count_date    date not null default current_date;

-- Backfill from the legacy tier column. `subscription_tier` is kept for one
-- release (settings.tsx and services/auth.ts still read it) and dropped later.
update public.profiles
   set entitlement = 'pro'
 where subscription_tier in ('monthly', 'annual')
   and entitlement = 'free';


-- ── FIX 1: profiles was client-writable, including subscription_tier ──
--
-- RLS is row-level, not column-level: the "profiles: own update" policy let any
-- authenticated user UPDATE any column of their own row — including
-- subscription_tier, and now entitlement. A one-line PostgREST call granted
-- free Pro. The row policy still applies; this narrows *which columns* it can
-- reach. service_role (the RevenueCat webhook) is unaffected.
revoke update on public.profiles from authenticated, anon;

grant update (display_name, instrument, skill_level, weekly_goal_minutes)
  on public.profiles to authenticated;


-- ── FIX 2: quota consumption that can actually reject ────────
--
-- increment_free_analyses(p_user_id) was security definer and took the user id
-- as a parameter, so any authenticated caller could burn *another* user's quota
-- by passing their uuid. It also incremented unconditionally and returned void,
-- so it could never enforce a cap. Replaced by an argument-less function that
-- reads auth.uid() and returns whether the analysis is allowed.
drop function if exists public.increment_free_analyses(uuid);

create or replace function public.consume_analysis()
returns boolean as $$
declare
  v_user_id uuid := auth.uid();
  v_ent     text;
  v_expires timestamptz;
  v_used    int;
  v_date    date;
begin
  if v_user_id is null then
    return false;  -- unauthenticated: the client meters guests locally
  end if;

  -- FOR UPDATE serializes two devices analyzing at the same instant; without it
  -- both read used=2 and both write 3, yielding 4 analyses on a 3/day cap.
  select entitlement, entitlement_expires_at, analyses_used_today, analyses_count_date
    into v_ent, v_expires, v_used, v_date
    from public.profiles
   where id = v_user_id
     for update;

  if not found then
    return false;
  end if;

  -- An expired pro row is a free row until the webhook catches up.
  if v_ent = 'pro' and (v_expires is null or v_expires > now()) then
    return true;
  end if;

  -- Roll the counter over on read rather than on a schedule.
  if v_date < current_date then
    v_used := 0;
  end if;

  if v_used >= 3 then
    return false;
  end if;

  update public.profiles
     set analyses_used_today = v_used + 1,
         analyses_count_date = current_date
   where id = v_user_id;

  return true;
end;
$$ language plpgsql security definer set search_path = public;

revoke execute on function public.consume_analysis() from public, anon;
grant  execute on function public.consume_analysis() to authenticated;


-- Read-only view of today's usage, so the client can render "2 of 3 left"
-- without trusting its own cached counter. Named distinctly from the column it
-- reads to keep the body unambiguous.
create or replace function public.get_analyses_used_today()
returns int as $$
  select case
           when analyses_count_date < current_date then 0
           else analyses_used_today
         end
    from public.profiles
   where id = auth.uid();
$$ language sql stable security definer set search_path = public;

revoke execute on function public.get_analyses_used_today() from public, anon;
grant  execute on function public.get_analyses_used_today() to authenticated;
