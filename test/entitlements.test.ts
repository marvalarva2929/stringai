/**
 * Entitlement gating tests.
 *
 *   node --experimental-strip-types --loader ./test/ts-resolver.mjs test/entitlements.test.ts
 *   (or: npm run test:entitlements)
 *
 * The free tier's daily cap must roll over on read, and trial must be
 * indistinguishable from Pro at every gate — a gate that treats a trialing user
 * as free would lock the two features the trial exists to sell.
 */

import {
  FREE_DAILY_ANALYSES,
  analysesRemaining,
  analysesUsedOn,
  canAnalyze,
  canRecordLive,
  canUseLlmCoaching,
  consumeAnalysis,
  entitlementFromCustomerInfo,
  freeEntitlement,
  localDateKey,
  showAds,
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

const TODAY = '2026-07-09';
const YESTERDAY = '2026-07-08';

function free(usedToday = 0, countDate = TODAY): Entitlement {
  return { ...freeEntitlement(), analysesUsedToday: usedToday, analysesCountDate: countDate };
}

function pro(overrides: Partial<Entitlement> = {}): Entitlement {
  return { ...freeEntitlement(), tier: 'pro', ...overrides };
}

function trialing(endsAt: string): Entitlement {
  return pro({ inTrial: true, trialEndsAt: endsAt, expiresAt: endsAt });
}

// ─────────────────────────────────────────────────────────────
console.log('\nFree tier daily cap');
{
  check('cap is 3', FREE_DAILY_ANALYSES === 3, `got ${FREE_DAILY_ANALYSES}`);
  check('0 used → 3 left', analysesRemaining(free(0), TODAY) === 3);
  check('1 used → 2 left', analysesRemaining(free(1), TODAY) === 2);
  check('2 used → 1 left', analysesRemaining(free(2), TODAY) === 1);
  check('3 used → 0 left', analysesRemaining(free(3), TODAY) === 0);
  check('3 used → cannot analyze', !canAnalyze(free(3), TODAY));
  check('2 used → can analyze', canAnalyze(free(2), TODAY));
  check(
    'over-count never goes negative',
    analysesRemaining(free(99), TODAY) === 0,
    `got ${analysesRemaining(free(99), TODAY)}`,
  );
}

console.log('\nDate rollover resets the counter');
{
  const exhaustedYesterday = free(3, YESTERDAY);
  check('yesterday’s 3 reads as 0 used today', analysesUsedOn(exhaustedYesterday, TODAY) === 0);
  check('exhausted yesterday → can analyze today', canAnalyze(exhaustedYesterday, TODAY));
  check('exhausted yesterday → 3 left today', analysesRemaining(exhaustedYesterday, TODAY) === 3);
  check('same-day count is respected', analysesUsedOn(free(2, TODAY), TODAY) === 2);
}

console.log('\nconsumeAnalysis');
{
  const after = consumeAnalysis(free(1), TODAY);
  check('increments used', after.analysesUsedToday === 2, `got ${after.analysesUsedToday}`);
  check('stamps today', after.analysesCountDate === TODAY);

  // A stale count from yesterday must reset to 1, not climb to 4.
  const rolled = consumeAnalysis(free(3, YESTERDAY), TODAY);
  check('stale day resets to 1', rolled.analysesUsedToday === 1, `got ${rolled.analysesUsedToday}`);
  check('stale day restamps', rolled.analysesCountDate === TODAY);

  const p = consumeAnalysis(pro(), TODAY);
  check('pro is not counted', p.analysesUsedToday === 0);

  check('does not mutate input', free(1).analysesUsedToday === 1);
}

console.log('\nPro is unlimited');
{
  check('pro → Infinity remaining', analysesRemaining(pro(), TODAY) === Infinity);
  check('pro → can analyze', canAnalyze(pro(), TODAY));
  check('pro with stale huge count still unlimited', canAnalyze(pro({ analysesUsedToday: 999 }), TODAY));
  check('pro → can record live', canRecordLive(pro()));
  check('pro → llm coaching', canUseLlmCoaching(pro()));
  check('pro → no ads', !showAds(pro()));
}

console.log('\nFree is gated on live recording, coaching and ads');
{
  check('free → cannot record live', !canRecordLive(free()));
  check('free → no llm coaching', !canUseLlmCoaching(free()));
  check('free → sees ads', showAds(free()));
}

console.log('\nTrial reads as pro at every gate');
{
  const t = trialing('2026-07-16T00:00:00.000Z');
  check('trial → can record live', canRecordLive(t));
  check('trial → llm coaching', canUseLlmCoaching(t));
  check('trial → unlimited analyses', analysesRemaining(t, TODAY) === Infinity);
  check('trial → can analyze when free cap exhausted', canAnalyze({ ...t, analysesUsedToday: 3 }, TODAY));
  check('trial → no ads', !showAds(t));
}

console.log('\ntrialDaysRemaining');
{
  const now = new Date('2026-07-09T12:00:00.000Z');
  check('7 days out → 7', trialDaysRemaining(trialing('2026-07-16T12:00:00.000Z'), now) === 7);
  check(
    'partial day rounds up',
    trialDaysRemaining(trialing('2026-07-10T06:00:00.000Z'), now) === 1,
    `got ${trialDaysRemaining(trialing('2026-07-10T06:00:00.000Z'), now)}`,
  );
  check('elapsed → 0', trialDaysRemaining(trialing('2026-07-08T12:00:00.000Z'), now) === 0);
  check('paid pro (not trialing) → 0', trialDaysRemaining(pro({ expiresAt: '2026-08-09T00:00:00.000Z' }), now) === 0);
  check('free → 0', trialDaysRemaining(free(), now) === 0);
}

console.log('\nentitlementFromCustomerInfo');
{
  const prev = free(2);

  const noneActive: CustomerInfoLike = { entitlements: { active: {} } };
  const lapsed = entitlementFromCustomerInfo(noneActive, pro({ analysesUsedToday: 2 }));
  check('no active entitlement → free', lapsed.tier === 'free');
  check('lapse clears trial flag', lapsed.inTrial === false && lapsed.trialEndsAt === null);
  check('lapse preserves the daily counter', lapsed.analysesUsedToday === 2);

  const paid: CustomerInfoLike = {
    entitlements: { active: { pro: { periodType: 'NORMAL', expirationDate: '2026-08-09T00:00:00.000Z' } } },
  };
  const paidEnt = entitlementFromCustomerInfo(paid, prev);
  check('active NORMAL → pro', paidEnt.tier === 'pro');
  check('active NORMAL → not inTrial', paidEnt.inTrial === false);
  check('active NORMAL → trialEndsAt null', paidEnt.trialEndsAt === null);
  check('active NORMAL → expiresAt set', paidEnt.expiresAt === '2026-08-09T00:00:00.000Z');
  check('preserves the daily counter', paidEnt.analysesUsedToday === 2);

  const trial: CustomerInfoLike = {
    entitlements: { active: { pro: { periodType: 'TRIAL', expirationDate: '2026-07-16T00:00:00.000Z' } } },
  };
  const trialEnt = entitlementFromCustomerInfo(trial, prev);
  check('active TRIAL → pro', trialEnt.tier === 'pro');
  check('active TRIAL → inTrial', trialEnt.inTrial === true);
  check('active TRIAL → trialEndsAt set', trialEnt.trialEndsAt === '2026-07-16T00:00:00.000Z');
  check('active TRIAL → can record live', canRecordLive(trialEnt));

  // periodType casing varies between RevenueCat's docs ('trial') and the
  // native SDKs ('TRIAL'); both must read as a trial.
  const lowerTrial: CustomerInfoLike = {
    entitlements: { active: { pro: { periodType: 'trial', expirationDate: '2026-07-16T00:00:00.000Z' } } },
  };
  check('lowercase periodType → inTrial', entitlementFromCustomerInfo(lowerTrial, prev).inTrial === true);

  const noPeriodType: CustomerInfoLike = { entitlements: { active: { pro: {} } } };
  check('missing periodType → not inTrial', entitlementFromCustomerInfo(noPeriodType, prev).inTrial === false);

  // A different entitlement id must not unlock pro.
  const other: CustomerInfoLike = { entitlements: { active: { legacy: { periodType: 'NORMAL' } } } };
  check('unknown entitlement id → free', entitlementFromCustomerInfo(other, prev).tier === 'free');

  // RevenueCat omits expirationDate for lifetime/non-expiring grants.
  const noExpiry: CustomerInfoLike = { entitlements: { active: { pro: { periodType: 'NORMAL' } } } };
  const noExpiryEnt = entitlementFromCustomerInfo(noExpiry, prev);
  check('missing expirationDate → pro with null expiry', noExpiryEnt.tier === 'pro' && noExpiryEnt.expiresAt === null);
}

console.log('\nlocalDateKey');
{
  check('formats YYYY-MM-DD', localDateKey(new Date(2026, 6, 9)) === '2026-07-09');
  check('zero-pads month and day', localDateKey(new Date(2026, 0, 5)) === '2026-01-05');
}

console.log('\nfreeEntitlement');
{
  const e = freeEntitlement(new Date(2026, 6, 9));
  check('starts free', e.tier === 'free');
  check('starts at 0 used', e.analysesUsedToday === 0);
  check('stamps today', e.analysesCountDate === '2026-07-09');
  check('not trialing', !e.inTrial);
}

// ─────────────────────────────────────────────────────────────
if (failures > 0) {
  console.error(`\n${failures} check(s) failed\n`);
  process.exit(1);
}
console.log('\nAll entitlement checks passed\n');
