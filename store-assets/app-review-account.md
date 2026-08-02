# App Review demo account

Credentials for the account Apple App Review signs in with. Paste these into
**App Store Connect → your app → App Review Information → Sign-In Required**.

**Status: live** — created 2026-08-01 on the production project
(`bwsjgacrzcnycpzqytpy`), sign-in verified through the app's own auth path.

---

## Credentials

| Field | Value |
|---|---|
| **Username** | `joshvigel+appreview@gmail.com` |
| **Password** | `Legato-Scroll-7565` |

| | |
|---|---|
| Supabase user id | `178d7a08-6c39-4012-8ad1-d3a1f2802a9b` |
| Display name | App Review |

The `+appreview` alias delivers to the same Gmail inbox, so any password-reset
mail reaches you without a new mailbox. The account was created pre-confirmed
via the admin API — the project has `mailer_autoconfirm` off, so an unconfirmed
user could not have signed in at all.

## What's seeded

- **Six sessions** across the past three weeks, overall scores 62 → 58 → 67 →
  71 → 74 → 81, so Progress shows a real trend rather than an empty state.
- **Nine metric scores per session** (54 rows) across pitch, intonation, tone,
  rhythm, bowing, and posture, so metric detail screens are populated.
- **One saved piece** — Bach A minor concerto, four sessions attached; the other
  two are unattached so the "General Practice" bucket is populated too.
- Daily analysis counter reset to zero.

## ⚠️ Pro is only half-granted — finish this after RevenueCat exists

The account has `entitlement = 'pro'` in Supabase, which is what the **server**
checks: `consume_analysis()` returns unlimited analyses for it. But that is not
what the **app** checks.

`useEntitlementStore` derives the tier solely from RevenueCat's `CustomerInfo`
(`entitlementFromCustomerInfo`). Nothing on the client ever reads
`profiles.entitlement` — that column exists so the server can enforce quota and
so the RevenueCat webhook has somewhere to mirror state. So as things stand, a
reviewer signing in today would get unlimited analyses but **still hit the
paywall** on live recording and AI coaching.

To actually unlock the client gates, once RevenueCat is set up (stage 3 of the
launch checklist), grant the entitlement there:

> RevenueCat dashboard → Customers → search App User ID
> `178d7a08-6c39-4012-8ad1-d3a1f2802a9b` → **Grant entitlement** → `pro`,
> expiry ~1 year.

That id is the App User ID because `app/_layout.tsx` calls
`identifyPurchaser(userId)` on sign-in, which does `Purchases.logIn(supabaseUserId)`.
The customer record only appears in RevenueCat after the account has signed in
once from a build with a live RevenueCat key — so: configure RevenueCat, sign in
on a device as this account, then grant.

**Do not skip this.** A reviewer who hits a paywall on the features the listing
advertises is the most likely single cause of rejection.

## Re-running / resetting

[`supabase/seed/app_review_account.sql`](../supabase/seed/app_review_account.sql)
is idempotent and re-applies the entitlement and history from scratch. Use it if
a reviewer leaves the account in an odd state, or to rebuild the account after
deleting it. It expects the auth user to already exist and errors clearly if not.

## Reviewer notes

The notes to paste alongside these credentials — that analysis needs real
instrument audio and must be tested on a physical device — are in
[`listing.md`](listing.md) under *App Review Information*.

## Security

A shared plaintext credential is inherent to Apple's review process, but worth
being deliberate about:

- **This repo is private.** Committing this file is only acceptable while that
  holds. If it ever goes public, this file and its git history need scrubbing.
- The account is real and hits production. A reviewer using session chat spends
  live Anthropic API credit — not a zero-cost credential.
- **Rotate the password once the app is approved.** It only needs to work during
  review; a known password on a Pro account indefinitely is the avoidable part.
