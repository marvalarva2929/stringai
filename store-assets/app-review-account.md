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
## Where the reviewer signs in

**Account creation no longer happens during onboarding.** It moved to
`AccountGate`, which runs *after* a purchase. So there is no signup or sign-in
screen anywhere in the first run — the reviewer completes onboarding, walks the
activation flow, and arrives at the paywall.

The paywall carries an **"Already subscribed? Sign in"** link beneath *Restore
purchases*, which opens `SignInSheet` — a native Modal, so it draws above the
gate overlay rather than being pushed underneath it. **That link is the
reviewer's only way in.** Signing in there fires `onAuthStateChange` →
`identifyPurchaser` → the granted entitlement lands and the gate clears.

Verify that link works on the release build before submitting. Without it the
credentials below are unusable, because the paywall is the only screen a
signed-out user can reach.

## 🚫 BLOCKER — the reviewer cannot enter the app without this

The app is **subscription-only**. `SubscribeGate` renders a mandatory paywall
over the whole navigator once the activation flow ends: no ✕, no "Maybe Later",
no way past it except purchasing, restoring, or signing in as an account that
already holds the entitlement. A reviewer without an entitlement sees the
paywall and nothing else, so this is no longer a "some features are locked"
problem — it is a hard stop, and a guaranteed rejection.

The account has `entitlement = 'pro'` in Supabase, which is what the **server**
checks (`analyze-feedback` and `session-chat` gate on it). But that is not what
the **app** checks.

`useEntitlementStore` derives the tier solely from RevenueCat's `CustomerInfo`
(`entitlementFromCustomerInfo`). Nothing on the client ever reads
`profiles.entitlement` — that column exists so the server can enforce its own
gate and so the RevenueCat webhook has somewhere to mirror state. So the seed
alone leaves a reviewer stuck at the paywall.

To let the reviewer in, once RevenueCat is set up (stage 3 of the launch
checklist), grant the entitlement there:

> RevenueCat dashboard → Customers → search App User ID
> `178d7a08-6c39-4012-8ad1-d3a1f2802a9b` → **Grant entitlement** → `pro`,
> expiry ~1 year.

That id is the App User ID because `app/_layout.tsx` calls
`identifyPurchaser(userId)` on sign-in, which does `Purchases.logIn(supabaseUserId)`.
The customer record only appears in RevenueCat after the account has signed in
once from a build with a live RevenueCat key — so: configure RevenueCat, sign in
on a device as this account, then grant.

**Do not skip this.** Verify it by signing in as the review account on a release
build and confirming you reach the home tab rather than the paywall.

The alternative — leaving the reviewer to make a real sandbox purchase — also
works, but only if sandbox purchases are confirmed working end-to-end on that
build first. If you go that route, say so explicitly in App Review Notes along
with the plans and trial lengths (monthly / 7 days, annual / 14 days), since the
reviewer will otherwise expect the credentials alone to be enough.

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
