-- The site now signs people up through join_waitlist() (011), not by
-- inserting into the table directly. Revoke anon/authenticated's direct
-- table access so join_waitlist() is the only path in, and drop the insert
-- policy from 009 that this replaces.
revoke all on public.waitlist from anon, authenticated;
drop policy if exists "waitlist: anon insert" on public.waitlist;
