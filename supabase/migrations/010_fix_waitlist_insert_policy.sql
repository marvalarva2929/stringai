-- 009's insert policy inspects correctly (right roles, right WITH CHECK text,
-- right grants) but every real insert as anon/authenticated still throws
-- "new row violates row-level security policy" even for well-formed emails.
-- Recreating it from scratch to rule out a stale cached plan.
drop policy if exists "waitlist: anon insert" on public.waitlist;
create policy "waitlist: anon insert"
  on public.waitlist for insert
  to anon, authenticated
  with check (
    char_length(email) between 3 and 254
    and position('@' in email) > 1
  );
