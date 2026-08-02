// Account deletion — App Store Guideline 5.1.1(v) requires an in-app path for an
// account holder to permanently delete their account and associated data.
//
// The anon client cannot delete an auth user, so this runs under the service
// role: it verifies the caller's JWT, then deletes the auth user. Every table
// keyed on the user id (profiles, sessions, …) is set up with ON DELETE CASCADE
// from auth.users, so removing the auth user removes their rows too.
//
// Deploy:  supabase functions deploy delete-account
// (No extra secrets — reuses SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.)
//
// JWT verification is on by default, so only authenticated app users reach this
// handler.

import { createClient } from 'npm:@supabase/supabase-js@2';

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method not allowed' }), {
      status: 405,
      headers: { 'content-type': 'application/json' },
    });
  }

  const jwt = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  if (!jwt) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }

  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) {
    console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — cannot delete account.');
    return new Response(JSON.stringify({ error: 'server_misconfigured' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  // Resolve the caller from their JWT — never trust a user id from the body.
  const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
  if (userErr || !userData.user) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }

  const { error: deleteErr } = await admin.auth.admin.deleteUser(userData.user.id);
  if (deleteErr) {
    console.error('deleteUser failed:', deleteErr.message);
    return new Response(JSON.stringify({ error: 'delete_failed' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
});
