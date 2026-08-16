-- App Review demo account — Pro entitlement + populated practice history.
--
-- Apple App Review needs a working login (Guideline 2.1): nothing in StringAI
-- works signed out, so a reviewer without credentials sees a wall. This script
-- grants Pro and seeds enough history that Progress and Piece detail render
-- with real trend lines instead of empty states.
--
-- PREREQUISITE — the auth user must already exist, because `entitlement` is not
-- client-writable (migration 004 revoked UPDATE on profiles from `authenticated`
-- and re-granted only four display columns, so a user cannot self-grant Pro).
-- Create it first, one of:
--
--   • Dashboard → Authentication → Users → Add user
--     email: joshvigel+appreview@gmail.com
--     password: Legato-Scroll-7565
--     ☑ Auto Confirm User      ← required; the project has mailer_autoconfirm off,
--                                and an unconfirmed user cannot sign in
--
--   • or POST /auth/v1/admin/users with the service_role key and
--     {"email_confirm": true}
--
-- Then run this file in the SQL Editor (or `psql -f`). It is idempotent — safe
-- to re-run, and re-running resets the seeded history to a known state.
--
-- ⚠️ This grants Pro on the SERVER only. useEntitlementStore derives the client
-- tier from RevenueCat's CustomerInfo and never reads profiles.entitlement, so
-- the app will still show the paywall until the `pro` entitlement is also
-- granted to this user in the RevenueCat dashboard. See
-- store-assets/app-review-account.md for that step.

do $$
declare
  v_email    text := 'joshvigel+appreview@gmail.com';
  v_uid      uuid;
  v_piece    text := 'demo-piece-bach-amin';
  v_sess     text;
  v_day      int;
  v_score    int;
  v_prev     int;
  -- Six sessions over three weeks, trending upward so the progress chart has
  -- a story: a rough start, a dip, then steady improvement.
  v_scores   int[] := array[62, 58, 67, 71, 74, 81];
  v_days_ago int[] := array[19, 16, 12, 8, 4, 1];
  i          int;
begin
  select id into v_uid from auth.users where email = v_email;
  if v_uid is null then
    raise exception
      'Auth user % does not exist yet. Create it first (see the header of this file), then re-run.',
      v_email;
  end if;

  -- ── Pro entitlement ──────────────────────────────────────────
  -- entitlement is what the Edge Functions gate on. Note this only covers the
  -- server half: the client derives its tier from RevenueCat, so the reviewer
  -- also needs a promotional entitlement granted in the RevenueCat dashboard —
  -- without it they cannot get past the mandatory paywall. See
  -- store-assets/app-review-account.md.
  update public.profiles
     set entitlement            = 'pro',
         entitlement_expires_at = now() + interval '10 years',
         trial_ends_at          = null,
         display_name           = 'App Review',
         skill_level            = 'intermediate',
         instrument             = 'violin'
   where id = v_uid;

  -- ── A piece to hang the history on ───────────────────────────
  delete from public.sessions where user_id = v_uid;   -- cascades to metric_scores
  delete from public.pieces   where user_id = v_uid;

  insert into public.pieces (id, user_id, title, composer, source)
  values (v_piece, v_uid, 'Violin Concerto in A minor, BWV 1041 — I. Allegro',
          'J. S. Bach', 'imslp');

  -- ── Sessions + per-metric scores ─────────────────────────────
  for i in 1 .. array_length(v_scores, 1) loop
    v_sess  := 'demo-session-' || lpad(i::text, 2, '0');
    v_score := v_scores[i];
    v_day   := v_days_ago[i];
    v_prev  := case when i = 1 then null else v_scores[i - 1] end;

    insert into public.sessions
      (id, user_id, instrument, piece_id, duration_seconds, recorded_at, overall_score, overall_delta)
    values
      (v_sess, v_uid, 'violin',
       -- leave the two middle sessions unattached so the "General Practice"
       -- bucket on the Progress screen is populated too
       case when i in (3, 4) then null else v_piece end,
       360 + (i * 45), now() - (v_day || ' days')::interval, v_score,
       case when v_prev is null then null else v_score - v_prev end);

    insert into public.metric_scores (session_id, metric_key, score, delta)
    values
      (v_sess, 'pitchAccuracy',       v_score + 4, null),
      (v_sess, 'intonationStability', v_score - 6, null),
      (v_sess, 'toneQuality',         v_score + 1, null),
      (v_sess, 'rhythmAccuracy',      v_score + 7, null),
      (v_sess, 'bowSmoothness',       v_score - 3, null),
      (v_sess, 'bowAngle',            v_score - 8, null),
      (v_sess, 'bowDistribution',     v_score - 2, null),
      (v_sess, 'leftHandWrist',       v_score + 2, null),
      (v_sess, 'posture',             v_score + 5, null);
  end loop;

  raise notice 'App Review account ready: % (Pro, % sessions)', v_email, array_length(v_scores, 1);
end $$;

-- ── Verify ───────────────────────────────────────────────────
select p.email,
       p.entitlement,
       p.entitlement_expires_at,
       (select count(*) from public.sessions s where s.user_id = p.id) as sessions
  from public.profiles p
 where p.email = 'joshvigel+appreview@gmail.com';
