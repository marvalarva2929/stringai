/* StringAI waitlist signup — static site, calls the join_waitlist() RPC.
 *
 * The anon key below is meant to be public. What keeps the table safe is that
 * anon has no direct table access at all — only EXECUTE on join_waitlist(),
 * a SECURITY DEFINER function (supabase/migrations/011_waitlist_join_rpc.sql)
 * that validates the email and does the insert itself. Do not grant anon
 * direct insert/select on public.waitlist.
 */
(function () {
  'use strict';

  var SUPABASE_URL = 'https://bwsjgacrzcnycpzqytpy.supabase.co';
  var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ3c2pnYWNyemNueWNwenF5dHB5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI5Mzk3NTYsImV4cCI6MjA5ODUxNTc1Nn0.n3sDZXx6i3agoPGlDEBwvFhzm-LZ2wi_ak7GLYjeVK0';

  var form = document.getElementById('waitlist-form');
  if (!form) return;

  var input = document.getElementById('waitlist-email');
  var button = document.getElementById('waitlist-submit');
  var status = document.getElementById('waitlist-status');
  var configured =
    SUPABASE_URL.indexOf('YOUR-PROJECT-REF') === -1 &&
    SUPABASE_ANON_KEY.indexOf('YOUR-ANON-KEY') === -1;

  function say(message, kind) {
    status.textContent = message;
    status.className = 'waitlist-status ' + (kind || '');
  }

  // Which campaign sent them. ?src= is the short form we hand to creators;
  // utm_* is what ad platforms append on their own. Keep both — they disagree
  // often enough that collapsing them loses real signal.
  function attribution() {
    var q = new URLSearchParams(window.location.search);
    return {
      source: q.get('src') || q.get('utm_source') || 'direct',
      utm_source: q.get('utm_source'),
      utm_medium: q.get('utm_medium'),
      utm_campaign: q.get('utm_campaign'),
      // Truncated: some referrers arrive absurdly long and the column is text.
      referrer: document.referrer ? document.referrer.slice(0, 500) : null
    };
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();

    var email = input.value.trim();
    if (!email || email.indexOf('@') < 1) {
      say('That email address does not look right.', 'error');
      input.focus();
      return;
    }

    if (!configured) {
      say('The waitlist is not connected yet — email joshvigel@gmail.com instead.', 'error');
      return;
    }

    button.disabled = true;
    say('Adding you…');

    var attr = attribution();
    var payload = {
      p_email: email,
      p_source: attr.source,
      p_utm_source: attr.utm_source,
      p_utm_medium: attr.utm_medium,
      p_utm_campaign: attr.utm_campaign,
      p_referrer: attr.referrer
    };

    fetch(SUPABASE_URL + '/rest/v1/rpc/join_waitlist', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
        Authorization: 'Bearer ' + SUPABASE_ANON_KEY
      },
      body: JSON.stringify(payload)
    })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        form.reset();
        say("You're on the list.", 'ok');
        button.textContent = 'Done';
      })
      .catch(function () {
        say('That did not go through. Try again, or email joshvigel@gmail.com.', 'error');
        button.disabled = false;
      });
  });
})();
