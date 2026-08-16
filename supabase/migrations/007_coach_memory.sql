-- 007 — Give the coach a memory, and one server-side view of the student.
--
-- Two problems this fixes.
--
-- 1. Chat had no memory. Messages lived in React state (app/chat.tsx) and were
--    lost on unmount, so every open started cold. Nothing anywhere recorded that
--    a conversation had happened, which also meant the post-session coach could
--    never take what the student said into account.
--
-- 2. The drill plan was never persisted. analyze.tsx strips `curatedBlocks` off
--    the feedback before writing it (deliberately — the plan is read from
--    useCuratedPlanStore, and a second copy on the session row could go stale).
--    That is right for *rendering the plan*, but it left the server unable to
--    tell chat what drills the student was given. `coach_plan` is a separate
--    column precisely so the plan keeps exactly one renderer: this copy is the
--    record of what we told them, not the plan itself.

-- ── The conversation ──────────────────────────────────────────
create table public.coach_messages (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null references public.profiles(id) on delete cascade,
  -- Which session the chat was opened from, when it was opened from one. Null
  -- for the standalone chat tab, which is about trends rather than one session.
  session_id text        references public.sessions(id) on delete set null,
  role       text        not null check (role in ('user', 'assistant')),
  content    text        not null,
  created_at timestamptz not null default now()
);

alter table public.coach_messages enable row level security;

-- Read your own history. Writes go through the Edge Function on the service
-- role, so there is deliberately no insert policy for clients: a user should not
-- be able to forge assistant turns, which the coach later reads as evidence.
create policy "coach_messages: own select"
  on public.coach_messages for select
  using (auth.uid() = user_id);

create policy "coach_messages: own delete"
  on public.coach_messages for delete
  using (auth.uid() = user_id);

-- The only access pattern: this user's most recent turns.
create index coach_messages_user_recent_idx
  on public.coach_messages (user_id, created_at desc);

-- ── The drill plan, as context ────────────────────────────────
alter table public.sessions
  add column if not exists coach_plan jsonb;

comment on column public.sessions.coach_plan is
  'The drill plan shown to the student, stored so chat can talk about it. Not the source of truth for rendering the plan — that stays in useCuratedPlanStore.';
