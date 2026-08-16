-- Direct anon inserts into public.waitlist hit a row-level-security bug on
-- this project (INSERT is denied even for a policy of `with check (true)`,
-- reproduced on brand-new throwaway tables too — not specific to this table
-- or its policy). Rather than chase that further, the site now calls this
-- SECURITY DEFINER function instead of POSTing to the table directly. It
-- runs as its owner, so it is not subject to the same RLS path, and it does
-- its own validation since it bypasses the table's insert policy entirely.
create or replace function public.join_waitlist(
  p_email text,
  p_source text default null,
  p_utm_source text default null,
  p_utm_medium text default null,
  p_utm_campaign text default null,
  p_referrer text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_email is null or char_length(p_email) < 3 or char_length(p_email) > 254
     or position('@' in p_email) < 2 then
    raise exception 'invalid email';
  end if;

  insert into public.waitlist (email, source, utm_source, utm_medium, utm_campaign, referrer)
  values (p_email, p_source, p_utm_source, p_utm_medium, p_utm_campaign, p_referrer)
  on conflict (email) do nothing;
end;
$$;

revoke all on function public.join_waitlist(text, text, text, text, text, text) from public;
grant execute on function public.join_waitlist(text, text, text, text, text, text) to anon, authenticated;
