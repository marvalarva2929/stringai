-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- ── profiles ─────────────────────────────────────────────────
-- NOTE: Disable "Enable email confirmations" in Supabase Dashboard →
-- Authentication → Settings for the MVP so users are logged in
-- immediately after sign-up.
create table public.profiles (
  id                 uuid        references auth.users(id) on delete cascade primary key,
  email              text        not null,
  display_name       text,
  instrument         text        not null default 'violin',
  skill_level        text        not null default 'beginner'
                                 check (skill_level in ('beginner', 'intermediate', 'advanced')),
  free_analyses_used int         not null default 0,
  subscription_tier  text        not null default 'free'
                                 check (subscription_tier in ('free', 'monthly', 'annual')),
  created_at         timestamptz not null default now()
);

alter table public.profiles enable row level security;
create policy "profiles: own select" on public.profiles for select using (auth.uid() = id);
create policy "profiles: own insert" on public.profiles for insert with check (auth.uid() = id);
create policy "profiles: own update" on public.profiles for update using (auth.uid() = id);

-- Auto-create a profile row when a user registers.
-- Runs as a privileged trigger so it works regardless of whether
-- email confirmation is enabled (no client session required at insert time).
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email);
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- Atomic free-analyses increment (avoids read-modify-write race).
create or replace function public.increment_free_analyses(p_user_id uuid)
returns void as $$
  update public.profiles
  set free_analyses_used = free_analyses_used + 1
  where id = p_user_id;
$$ language sql security definer;


-- ── pieces ───────────────────────────────────────────────────
create table public.pieces (
  id               text        not null primary key,
  user_id          uuid        references auth.users(id) on delete cascade not null,
  title            text        not null,
  composer         text,
  source           text        not null default 'imslp',
  imslp_id         text,
  pdf_storage_path text,
  created_at       timestamptz not null default now()
);

alter table public.pieces enable row level security;
create policy "pieces: own select" on public.pieces for select using (auth.uid() = user_id);
create policy "pieces: own insert" on public.pieces for insert with check (auth.uid() = user_id);
create policy "pieces: own delete" on public.pieces for delete using (auth.uid() = user_id);


-- ── sessions ─────────────────────────────────────────────────
create table public.sessions (
  id               text        not null primary key,
  user_id          uuid        references public.profiles(id) on delete cascade not null,
  instrument       text        not null,
  piece_id         text        references public.pieces(id) on delete set null,
  duration_seconds int         not null,
  recorded_at      timestamptz not null,
  overall_score    int         not null,
  overall_delta    int,
  created_at       timestamptz not null default now()
);

alter table public.sessions enable row level security;
create policy "sessions: own select" on public.sessions for select using (auth.uid() = user_id);
create policy "sessions: own insert" on public.sessions for insert with check (auth.uid() = user_id);


-- ── metric_scores ─────────────────────────────────────────────
create table public.metric_scores (
  id                 bigserial   primary key,
  session_id         text        references public.sessions(id) on delete cascade not null,
  metric_key         text        not null,
  score              int         not null,
  delta              int,
  flagged_timestamps jsonb       not null default '[]'
);

alter table public.metric_scores enable row level security;
create policy "metric_scores: own select" on public.metric_scores
  for select using (
    exists (select 1 from public.sessions s where s.id = session_id and s.user_id = auth.uid())
  );
create policy "metric_scores: own insert" on public.metric_scores
  for insert with check (
    exists (select 1 from public.sessions s where s.id = session_id and s.user_id = auth.uid())
  );


-- ── milestones ────────────────────────────────────────────────
create table public.milestones (
  id             bigserial   primary key,
  user_id        uuid        references public.profiles(id) on delete cascade not null,
  metric_key     text,
  milestone_type text        not null,
  value          numeric,
  achieved_at    timestamptz not null default now()
);

alter table public.milestones enable row level security;
create policy "milestones: own select" on public.milestones for select using (auth.uid() = user_id);
create policy "milestones: own insert" on public.milestones for insert with check (auth.uid() = user_id);


-- ── indexes ───────────────────────────────────────────────────
create index idx_sessions_user_id      on public.sessions(user_id, recorded_at desc);
create index idx_sessions_piece_id     on public.sessions(piece_id);
create index idx_metric_scores_session on public.metric_scores(session_id);
create index idx_milestones_user_id    on public.milestones(user_id, achieved_at desc);
create index idx_pieces_user_id        on public.pieces(user_id, created_at desc);
