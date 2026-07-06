-- Weekly practice-time commitment chosen during onboarding (minutes per week).
-- Nullable: existing users and onboarding skippers simply have no goal set.
alter table public.profiles
  add column weekly_goal_minutes int
  check (weekly_goal_minutes is null or weekly_goal_minutes between 1 and 1000);
