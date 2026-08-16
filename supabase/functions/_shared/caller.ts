/**
 * Resolves and authorises the caller.
 *
 * Was duplicated verbatim in both Edge Functions with a comment noting the
 * duplication was forced by Deno module isolation — it wasn't, `_shared/`
 * already existed. Shared now because both functions need more than a boolean:
 * server-side context loading and conversation storage are keyed by user id.
 *
 * Fails closed. Every unresolved case returns null, so a misconfigured env var
 * costs a 402 rather than an unmetered inference bill.
 */

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

export interface Caller {
  userId: string;
  /** Service-role client — bypasses RLS, so never hand it a client-supplied id. */
  admin: SupabaseClient;
}

export async function resolveProCaller(req: Request): Promise<Caller | null> {
  const jwt = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  if (!jwt) return null;

  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) return null;

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
  if (userErr || !userData.user) return null;

  const { data: profile, error: profileErr } = await admin
    .from('profiles')
    .select('entitlement, entitlement_expires_at')
    .eq('id', userData.user.id)
    .single();
  if (profileErr || !profile) return null;

  if (profile.entitlement !== 'pro') return null;
  if (profile.entitlement_expires_at && new Date(profile.entitlement_expires_at) <= new Date()) {
    return null;
  }

  return { userId: userData.user.id, admin };
}
