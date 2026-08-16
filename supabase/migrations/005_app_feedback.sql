-- In-app feedback, collected by the gated review prompt.
--
-- The review flow asks "Enjoying StringAI?" before it ever touches
-- SKStoreReviewController. A positive answer goes to the App Store; a negative
-- one lands here instead. That's the whole point of gating: the three review
-- prompts iOS allows per year get spent on people who are happy, and the people
-- who aren't get a channel that can actually tell us why.

create table if not exists public.app_feedback (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users(id) on delete set null,
  message     text not null check (char_length(message) between 1 and 4000),
  -- Where the prompt fired from: 'activation_complete', 'practice_complete', …
  context     text,
  app_version text,
  created_at  timestamptz not null default now()
);

create index if not exists app_feedback_created_at_idx
  on public.app_feedback (created_at desc);

alter table public.app_feedback enable row level security;

-- Insert-only, and only as yourself. There is deliberately no select policy:
-- feedback is write-once from the client and read exclusively through the
-- dashboard / service_role. A user has no reason to read anyone's rows here,
-- including their own.
drop policy if exists "app_feedback: insert own" on public.app_feedback;
create policy "app_feedback: insert own"
  on public.app_feedback for insert
  to authenticated
  with check (auth.uid() = user_id);
