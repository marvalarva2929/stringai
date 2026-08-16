/**
 * Entitlement rule tests.
 *
 *   node --experimental-strip-types --loader ./test/ts-resolver.mjs test/entitlements.test.ts
 *   (or: npm run test:entitlements)
 *
 * Two properties matter here. Trial must be indistinguishable from paid — a
 * rule that treated a trialing user as unsubscribed would show them the paywall
 * they just bought their way past. And introTrialDays must never invent a
 * number: the paywall renders "Start a {n}-Day Free Trial" straight from it, so
 * a wrong answer is a promise the App Store will not honour.
 */

import {
  entitlementFromCustomerInfo,
  freeEntitlement,
  introTrialDays,
  isPro,
  requiresSubscription,
  trialDaysRemaining,
  type CustomerInfoLike,
  type Entitlement,
} from '../src/lib/entitlements';

let failures = 0;

function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function pro(overrides: Partial<Entitlement> = {}): Entitlement {
  return { ...freeEntitlement(), tier: 'pro', ...overrides };
}

function customerInfo(
  active: Record<string, { periodType?: string; expirationDate?: string | null }>,
): CustomerInfoLike {
  return { entitlements: { active } };
}

// ── The gate ──────────────────────────────────────────────────

console.log('\nrequiresSubscription');
{
  check('no entitlement → gated', requiresSubscription(freeEntitlement()));
  check('pro → not gated', !requiresSubscription(pro()));
  check('trialing → not gated', !requiresSubscription(pro({ inTrial: true })));
  check('is the inverse of isPro', requiresSubscription(freeEntitlement()) === !isPro(freeEntitlement()));
}

// A trial that has run out is still `pro` until RevenueCat says otherwise —
// the store, not the client clock, decides when access ends.
console.log('\ntrial is not a lesser tier');
{
  const expiredTrial = pro({ inTrial: true, trialEndsAt: '2020-01-01T00:00:00Z' });
  check('elapsed trial still counts as subscribed', !requiresSubscription(expiredTrial));
  check('but reports 0 days left', trialDaysRemaining(expiredTrial) === 0);
}

console.log('\ntrialDaysRemaining');
{
  const now = new Date('2026-07-09T12:00:00Z');
  check(
    'rounds partial days up',
    trialDaysRemaining(pro({ inTrial: true, trialEndsAt: '2026-07-12T06:00:00Z' }), now) === 3,
  );
  check('0 when not in a trial', trialDaysRemaining(pro({ trialEndsAt: '2026-07-12T00:00:00Z' }), now) === 0);
  check('0 with no end date', trialDaysRemaining(pro({ inTrial: true }), now) === 0);
}

// ── Intro offers ──────────────────────────────────────────────
//
// The two plans carry different trials (7 days monthly, 14 annual), so the
// duration has to come off the product rather than a constant.

console.log('\nintroTrialDays');
{
  check('7-day trial', introTrialDays({ periodUnit: 'DAY', periodNumberOfUnits: 7 }) === 7);
  check('14-day trial', introTrialDays({ periodUnit: 'DAY', periodNumberOfUnits: 14 }) === 14);
  check('1 week → 7 days', introTrialDays({ periodUnit: 'WEEK', periodNumberOfUnits: 1 }) === 7);
  check('2 weeks → 14 days', introTrialDays({ periodUnit: 'WEEK', periodNumberOfUnits: 2 }) === 14);
  check('1 month → 30 days', introTrialDays({ periodUnit: 'MONTH', periodNumberOfUnits: 1 }) === 30);
  check('lowercase unit', introTrialDays({ periodUnit: 'day', periodNumberOfUnits: 7 }) === 7);
  check('cycles multiply', introTrialDays({ periodUnit: 'WEEK', periodNumberOfUnits: 1, cycles: 2 }) === 14);
  check('cycles of 0 treated as 1', introTrialDays({ periodUnit: 'DAY', periodNumberOfUnits: 7, cycles: 0 }) === 7);

  // Anything unreadable must be null rather than a guess — the caller falls
  // back to plain pricing, which is the safe direction.
  check('no offer → null', introTrialDays(null) === null);
  check('undefined → null', introTrialDays(undefined) === null);
  check('unknown unit → null', introTrialDays({ periodUnit: 'FORTNIGHT', periodNumberOfUnits: 1 }) === null);
  check('zero units → null', introTrialDays({ periodUnit: 'DAY', periodNumberOfUnits: 0 }) === null);
}

// ── Mapping RevenueCat's CustomerInfo ─────────────────────────

console.log('\nentitlementFromCustomerInfo');
{
  const none = entitlementFromCustomerInfo(customerInfo({}));
  check('no active entitlement → unsubscribed', none.tier === 'free');
  check('and gated', requiresSubscription(none));
  check('clears trial fields', none.inTrial === false && none.trialEndsAt === null);
  check('clears expiry', none.expiresAt === null);

  const other = entitlementFromCustomerInfo(customerInfo({ some_other_id: { periodType: 'NORMAL' } }));
  check('ignores a different entitlement id', other.tier === 'free');

  const paid = entitlementFromCustomerInfo(
    customerInfo({ pro: { periodType: 'NORMAL', expirationDate: '2027-01-01T00:00:00Z' } }),
  );
  check('active → pro', paid.tier === 'pro');
  check('paid is not a trial', paid.inTrial === false);
  check('trialEndsAt null when paid', paid.trialEndsAt === null);
  check('carries the expiry', paid.expiresAt === '2027-01-01T00:00:00Z');

  const trial = entitlementFromCustomerInfo(
    customerInfo({ pro: { periodType: 'TRIAL', expirationDate: '2026-07-23T00:00:00Z' } }),
  );
  check('TRIAL → pro', trial.tier === 'pro');
  check('TRIAL → inTrial', trial.inTrial === true);
  check('trialEndsAt mirrors the expiry', trial.trialEndsAt === '2026-07-23T00:00:00Z');
  check('trial is not gated', !requiresSubscription(trial));

  // The native SDKs emit 'TRIAL' but RevenueCat's docs write 'trial'.
  const lower = entitlementFromCustomerInfo(
    customerInfo({ pro: { periodType: 'trial', expirationDate: '2026-07-23T00:00:00Z' } }),
  );
  check('lowercase periodType still reads as a trial', lower.inTrial === true);

  const noExpiry = entitlementFromCustomerInfo(customerInfo({ pro: { periodType: 'NORMAL' } }));
  check('missing expirationDate → null, not undefined', noExpiry.expiresAt === null);
}

console.log('\nfreeEntitlement');
{
  const e = freeEntitlement();
  check('starts unsubscribed', e.tier === 'free');
  check('not in a trial', e.inTrial === false);
  check('no dates', e.trialEndsAt === null && e.expiresAt === null);
}

console.log(failures === 0 ? '\nAll entitlement tests passed.' : `\n${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
