// RevenueCat → Supabase entitlement sync.
//
// RevenueCat is the source of truth for whether a user has paid. This function
// mirrors that onto profiles.entitlement, which is what consume_analysis and
// analyze-feedback actually enforce. Without it the server never learns about a
// purchase, and a paying user would still be metered as free.
//
// Deploy:  supabase functions deploy revenuecat-webhook
// Secret:  supabase secrets set REVENUECAT_WEBHOOK_SECRET=<random string>
//
// RevenueCat has no user JWT, so verify_jwt = false in config.toml. The shared
// secret in the Authorization header IS the authentication — set the same value
// in the RevenueCat dashboard under Integrations → Webhooks → Authorization.

import { createClient } from 'npm:@supabase/supabase-js@2';

/** https://www.revenuecat.com/docs/integrations/webhooks/event-types-and-fields */
interface RevenueCatEvent {
  type: string;
  app_user_id: string;
  original_app_user_id?: string;
  expiration_at_ms?: number | null;
  period_type?: string; // NORMAL | TRIAL | INTRO | PROMOTIONAL
  entitlement_ids?: string[] | null;
}

const PRO_ENTITLEMENT_ID = 'pro';

// Events that mean "the user should have access right now". CANCELLATION is
// deliberately absent: a cancelled subscription stays active until it expires,
// and RevenueCat sends EXPIRATION when it actually lapses. Revoking on
// CANCELLATION would cut off a user who paid through the end of the period.
const GRANTING = new Set([
  'INITIAL_PURCHASE',
  'RENEWAL',
  'PRODUCT_CHANGE',
  'UNCANCELLATION',
  'NON_RENEWING_PURCHASE',
  'SUBSCRIPTION_EXTENDED',
]);

const REVOKING = new Set(['EXPIRATION', 'SUBSCRIPTION_PAUSED']);

/** Timing-safe compare so the secret can't be recovered byte-by-byte. */
function secretMatches(provided: string, expected: string): boolean {
  const a = new TextEncoder().encode(provided);
  const b = new TextEncoder().encode(expected);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405 });
  }

  const expected = Deno.env.get('REVENUECAT_WEBHOOK_SECRET');
  if (!expected) {
    console.error('REVENUECAT_WEBHOOK_SECRET is not set — refusing all webhooks.');
    return new Response(JSON.stringify({ error: 'server misconfigured' }), { status: 500 });
  }
  const provided = req.headers.get('Authorization') ?? '';
  if (!secretMatches(provided, expected)) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }

  let event: RevenueCatEvent;
  try {
    event = (await req.json()).event;
  } catch {
    return new Response(JSON.stringify({ error: 'invalid JSON body' }), { status: 400 });
  }
  if (!event?.type || !event.app_user_id) {
    return new Response(JSON.stringify({ error: 'missing event fields' }), { status: 400 });
  }

  // We call Purchases.logIn(supabaseUserId), so app_user_id IS the profile id.
  // An anonymous purchase (never signed in) has an RC-generated id that matches
  // no profile; the update simply affects zero rows, and the client's own
  // customer-info listener still unlocks the app locally.
  const userId = event.app_user_id;
  if (!/^[0-9a-f-]{36}$/i.test(userId)) {
    return new Response(JSON.stringify({ ok: true, skipped: 'anonymous app_user_id' }), {
      headers: { 'content-type': 'application/json' },
    });
  }

  const grants =
    GRANTING.has(event.type) &&
    (!event.entitlement_ids || event.entitlement_ids.includes(PRO_ENTITLEMENT_ID));
  const revokes = REVOKING.has(event.type);

  // BILLING_ISSUE and CANCELLATION are informational: access persists until
  // EXPIRATION. Acknowledge them so RevenueCat stops retrying.
  if (!grants && !revokes) {
    return new Response(JSON.stringify({ ok: true, ignored: event.type }), {
      headers: { 'content-type': 'application/json' },
    });
  }

  const expiresAt = event.expiration_at_ms ? new Date(event.expiration_at_ms).toISOString() : null;
  const inTrial = event.period_type?.toUpperCase() === 'TRIAL';

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );

  // subscription_tier is deliberately not written: it can't express "pro" without
  // guessing monthly vs annual, nothing reads it for gating any more, and it is
  // dropped in a follow-up migration. `entitlement` is the only authority.
  const { error } = await admin
    .from('profiles')
    .update(
      grants
        ? {
            entitlement: 'pro',
            entitlement_expires_at: expiresAt,
            trial_ends_at: inTrial ? expiresAt : null,
            rc_customer_id: event.original_app_user_id ?? userId,
          }
        : {
            entitlement: 'free',
            entitlement_expires_at: null,
            trial_ends_at: null,
          },
    )
    .eq('id', userId);

  if (error) {
    // 5xx makes RevenueCat retry with backoff, which is what we want for a
    // transient DB error — the entitlement must not be silently dropped.
    console.error('entitlement update failed', { userId, type: event.type, error });
    return new Response(JSON.stringify({ error: 'update failed' }), { status: 500 });
  }

  return new Response(JSON.stringify({ ok: true, type: event.type, entitlement: grants ? 'pro' : 'free' }), {
    headers: { 'content-type': 'application/json' },
  });
});
