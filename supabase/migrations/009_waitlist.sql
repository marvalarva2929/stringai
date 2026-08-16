-- Pre-launch waitlist, collected by the marketing site.
--
-- The site is a static GitHub Pages build with no server of its own, so it
-- posts straight to PostgREST with the anon key. That is safe here only
-- because of the policy at the bottom: anon may insert and may not select.
-- Without the missing select policy the anon key would be a public dump of
-- every email we collect.
--
-- `source` is the whole reason this table earns its keep. Each campaign gets
-- its own link (?src=organic, ?src=talia, …) so the marketing tracker can tell
-- a creator's signups apart from the ones our own TikToks brought in. Without
-- it we would know the total and nothing else, which is the same as not
-- knowing.

-- citext needs the extension; harmless if another migration already added it.
-- Must run before the table below — it uses citext as a column type.
create extension if not exists citext;

create table if not exists public.waitlist (
  id         uuid primary key default gen_random_uuid(),
  email      citext not null,
  -- Campaign slug from the ?src= query param: 'organic', 'talia', 'suibian', …
  source     text,
  -- Standard UTM fields, kept separate so paid and organic can be sliced
  -- without parsing `source` by hand later.
  utm_source   text,
  utm_medium   text,
  utm_campaign text,
  referrer   text,
  created_at timestamptz not null default now()
);

-- One row per address. A second submit from the same person is a no-op rather
-- than an error the visitor has to understand (see the on_conflict in the
-- site's fetch call).
create unique index if not exists waitlist_email_key
  on public.waitlist (email);

create index if not exists waitlist_created_at_idx
  on public.waitlist (created_at desc);

create index if not exists waitlist_source_idx
  on public.waitlist (source);

alter table public.waitlist enable row level security;

-- Insert-only for anonymous visitors. There is deliberately NO select policy:
-- the anon key ships in the page source, so anything anon can read is public.
-- Read these rows through the dashboard or service_role only.
drop policy if exists "waitlist: anon insert" on public.waitlist;
create policy "waitlist: anon insert"
  on public.waitlist for insert
  to anon, authenticated
  with check (
    -- Cheap server-side sanity check so the table can't be filled with junk
    -- by anyone who opens devtools. Not validation — just a floor.
    char_length(email) between 3 and 254
    and position('@' in email) > 1
  );
