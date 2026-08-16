# Launch integrations — what's connected, what isn't

Every external service StringAI touches, and its **verified** state as of **2026-08-08**. Status
came from probing the live project (auth endpoints, REST, edge functions, `supabase migration list`,
`supabase secrets list`), not from reading code — so "connected" means it answered.

Re-verify any time with the commands in [Appendix: how to re-check](#appendix-how-to-re-check).

---

## The one-line summary

The app is **subscription-only** (`src/lib/entitlements.ts`: "nothing inside the app is reachable
without a subscription"). RevenueCat is not configured, so **today nobody can get past the paywall
into the app.** Everything else is secondary to that.

---

## Status at a glance

| # | Integration | State | Blocked by |
|---|---|---|---|
| 1 | Supabase project (DB, auth, edge functions) | ✅ Live | — |
| 2 | Legal/support site | ✅ Live | — |
| 3 | App Review demo account | ✅ Verified signs in | — |
| 4 | `app_feedback` table (migration 005) | ✅ **Applied 2026-08-08** | — |
| 5 | `REVENUECAT_WEBHOOK_SECRET` | ✅ **Set 2026-08-08** | — |
| 6 | `HF_TOKEN` | ❌ Not set | Hugging Face token |
| 7 | Supabase custom SMTP | ❌ Not configured | email provider account |
| 8 | EAS project (`extra.eas.projectId`) | ❌ Missing | Expo account |
| 9 | Google OAuth | ❌ Provider disabled | Google Cloud |
| 10 | Firebase (Analytics/Crashlytics/Perf) | ❌ No plist | Firebase console |
| 11 | Migration 006 (retire free tier) | ⏸ Written, **not applied** | your go-ahead (destructive) |
| 12 | RevenueCat | ❌ Nothing | Apple Developer |
| 13 | App Store Connect + products | ❌ Nothing | Apple Developer |
| 14 | Sign in with Apple | ❌ Entirely unwired | Apple Developer |
| 15 | Screenshots | ❌ Wrong dimensions | — (just re-capture) |
| 16 | App Store privacy labels | ❌ Must be redone | Apple Developer |

**You do NOT need:** APNs / push certificates (notifications are local-only — zero push-token calls
in the codebase), or Google Cloud for Firebase (that's console-only).

---

## Already done — don't redo

**Supabase** `bwsjgacrzcnycpzqytpy` (us-east-2, ACTIVE_HEALTHY). Auth health 200. Tables `profiles`,
`pieces`, `sessions`, `metric_scores`, `milestones` all 200. Migrations 001–005 applied. All four
edge functions deployed (`analyze-feedback`, `session-chat`, `delete-account`, `revenuecat-webhook`).

**Legal site** — `privacy.html`, `terms.html`, `support.html` all return 200 at
`marvalarva2929.github.io/stringai-site`. `src/constants/links.ts` points at them correctly.

**Demo account** — `joshvigel+appreview@gmail.com` signs in successfully; profile carries
`entitlement: pro` expiring 2036. Credentials in `store-assets/app-review-account.md`.

**Bundle ID** — `com.stringai.app`, consistent in both `app.json` and the Xcode project.
`DEVELOPMENT_TEAM = TTKYKL258N` is already set in `project.pbxproj` — **verify this matches the
Apple account you create**, or signing fails confusingly.

---

## Fixed on 2026-08-08

### 4. `app_feedback` table
Migration 005 was never applied — the table didn't exist, so the review prompt's feedback insert
failed and silently fell back to a `mailto:` draft for signed-in users. Applied and verified
(`local 005 / remote 005`, table returns 200).

### 5. `REVENUECAT_WEBHOOK_SECRET`
Was unset, so `revenuecat-webhook` returned **500 "server misconfigured"** and refused every
webhook. Generated and set. Verified: 401 without auth, 200 with the secret.

> **The value — you need this later:**
> ```
> BQLiNULzrvGl4WpyR6AyDqk33W0KfjYm3QfF9p0IsxA
> ```
> Paste the *same string* into **RevenueCat → Integrations → Webhooks → Authorization header**
> when you set up RevenueCat (#12). Rotate with
> `supabase secrets set REVENUECAT_WEBHOOK_SECRET=<new>` and update both sides together.

---

## No Apple account needed — do these next

### 6. `HF_TOKEN` — ✅ RESOLVED (2026-08-11)
The token is set and the LLM path has been exercised end to end. Coaching and Maestro chat work.

The audit below is kept only as a description of the failure mode, since it is silent: without the
token every analysis falls back to the static template (`coaching_failed` fires) and chat fails
outright, with nothing in the UI to say so. If coaching ever looks generic again, check this first.

> `supabase secrets list` shows only the seven auto-injected Supabase secrets. A live call to
> `analyze-feedback` with a valid Pro token returned the SDK's own error:
> *"Could not resolve authentication method."*

Note the model split, which the paywall copy previously got wrong: post-session coaching runs on
**DeepSeek V4 Flash** via the HF router (`supabase/functions/_shared/coachingPrompt.ts`), and only
Maestro chat runs on **Claude Haiku** (`_shared/coachContext.ts`).

```bash
supabase secrets set HF_TOKEN=hf_...
```
Both `analyze-feedback` and `session-chat` read it. No redeploy needed. Verify with the appendix
command — a correct key returns coaching JSON instead of an auth error.

### 7. Supabase custom SMTP — most signups will fail
A live signup attempt returned **429 `over_email_send_rate_limit`**. Email confirmation is required
(new signups return no session), and the project is on Supabase's built-in email service, which is
explicitly **not for production** — roughly 2–4 messages per hour, shared and throttled.

Impact: at any real signup rate, confirmation emails stop arriving. Users create an account, never
get the mail, and cannot sign in. Password reset (`resetPassword` in `src/services/auth.ts`) breaks
the same way.

Fix: **Supabase → Project Settings → Authentication → SMTP Settings**, point at Resend / Postmark /
SendGrid (all have free tiers; Resend needs only a domain DNS record). Then raise the rate limit
under **Auth → Rate Limits**.

While you're there, set **Auth → URL Configuration → Redirect URLs** to include `stringai://` and
`stringai://auth-callback` — `signInWithProvider` uses `Linking.createURL('auth-callback')`, and
OAuth will bounce without it.

### 8. EAS project ID
`app.json` has no `extra.eas.projectId` (`extra` is `null`), so `eas build` cannot run.

```bash
npx eas-cli@latest login
npx eas-cli@latest init
```
Then add `EXPO_PUBLIC_*` values to EAS environment variables for **both** the `preview` and
`production` environments (`eas.json` maps each build profile to one). Miss this and the built app
ships with undefined keys and silently disables Supabase and RevenueCat.

### 9. Google OAuth
`GET /auth/v1/authorize?provider=google` returns *"provider is not enabled"*. The Google button is
live in **login, register, and onboarding** (`OAuthButtons` is used in all three) and fails on tap.

Google Cloud → OAuth consent screen → Web application client. Authorized redirect URI is
`https://bwsjgacrzcnycpzqytpy.supabase.co/auth/v1/callback`. Then paste client ID + secret into
**Supabase → Authentication → Providers → Google**.

> ⚠️ Offering Google sign-in makes **Sign in with Apple mandatory** under App Store Guideline 4.8
> (#14). If you want to ship sooner, removing the Google button removes that requirement too.

### 10. Firebase
Full walkthrough in **`docs/FIREBASE_SETUP.md`**. No Apple account required. Short version: create
the project, add an iOS app with bundle `com.stringai.app`, drop `GoogleService-Info.plist` into the
Xcode target, then register custom dimensions and mark key events in GA4. Until the plist exists
every telemetry call no-ops silently — `/debug` → **Firebase Telemetry** tells you which state
you're in.

### 11. Migration 006 — needs your decision
`006_retire_free_tier.sql` is written but **not applied**. It is destructive: it drops
`consume_analysis()`, `get_analyses_used_today()`, and the `analyses_used_today`,
`analyses_count_date`, `subscription_tier` columns from `profiles`.

I verified nothing in `app/`, `src/`, `supabase/functions/` or `scripts/` still references any of
them — only stale comments. It looks safe, but dropping production columns is irreversible, so it
is your call:

```bash
supabase db push --linked      # applies 006
```

---

## Requires the Apple Developer account ($99/yr)

### 12. RevenueCat — the critical path
Nothing exists: no project, no API key. `.env` has only the two Supabase keys, so
`isPurchasesConfigured` is `false` and `purchasePackage` throws *"Subscriptions are not available on
this build."* Since the app is subscription-only, **this alone makes the app unusable.**

Order of operations:
1. App Store Connect: subscription group → monthly + annual products → introductory offers
2. RevenueCat: project → iOS app → paste the ASC **in-app purchase key**
3. Entitlement id must be exactly **`pro`** (`PRO_ENTITLEMENT_ID` in `src/lib/entitlements.ts`)
4. Offering with `monthly` and `annual` packages — `PaywallView` reads `offering.monthly` /
   `offering.annual` by those exact names
5. Copy the **public SDK key** into `EXPO_PUBLIC_REVENUECAT_API_KEY_IOS`
6. Webhook → your `revenuecat-webhook` URL, Authorization header = the secret in #5 above
7. Firebase integration (needs #10 first): Firebase App ID + a GA4 Measurement Protocol API secret

Note trials are per **subscription group**, not per product — `checkTrialEligibility` in
`src/services/purchases.ts` already handles this, but the group must be configured for it to mean
anything.

#### Offering metadata — changing the paywall without an App Store review

`PaywallView` reads its copy from the offering's **metadata** (RevenueCat → Offerings → your
offering → Metadata). Every key is optional and falls back to what shipped, so an empty metadata
bag renders exactly the default paywall. Parsing and fallbacks live in
`src/lib/paywallContent.ts` and are covered by `npm run test:paywallcontent`.

| Key | Type | Falls back to |
|---|---|---|
| `headline` | string | "Start your free trial" (gate) / "Unlock More Features" |
| `features` | JSON array, or newline-separated string | `DEFAULT_FEATURES` |
| `personal_note` | string — **set to `""` to hide the block** | `DEFAULT_PERSONAL_NOTE` |
| `variant` | string | `"default"` |

`variant` is what makes a copy test readable: it rides on `paywall_view`, `paywall_plan_selected`,
`paywall_dismiss` and `purchase_cancelled`, and on `begin_checkout`/`purchase` inside the ecommerce
item as **`item_category2`** (`item_variant` was already taken by trial-vs-direct). Register
`item_category2` as a custom dimension in GA4 or the variant will be collected and never shown —
see the dimensions note in `FIREBASE_SETUP.md`. **Always change `variant` when you change copy**;
without it the before/after sits in one undifferentiated bucket.

Prices and plans are *already* remote without any of this — `PaywallView` reads
`offering.monthly` / `offering.annual` at runtime, so swapping the current offering changes what is
sold with no app update. (Changing the price of an existing product is still an App Store Connect
operation.)

This is deliberately smaller than RevenueCat Paywalls v2, which would need `react-native-purchases-ui`
and a v7→v8 SDK bump, and would replace the hand-built screen with a templated one.

### 13. App Store Connect
App record, bundle ID registration, and the **Paid Applications Agreement + tax/banking forms** —
that last one is a separate gate that blocks in-app purchases *even in sandbox*, and is easy to miss
behind "get RevenueCat keys."

Then fill the three placeholders in `eas.json`:
`REPLACE_WITH_APPLE_ID_EMAIL`, `REPLACE_WITH_APP_STORE_CONNECT_APP_ID`, `REPLACE_WITH_APPLE_TEAM_ID`.

### 14. Sign in with Apple — mandatory, entirely unwired
Guideline 4.8: offering Google sign-in requires offering Apple. Currently missing at **every** layer:

- `ios/StringAI/StringAI.entitlements` is an empty `<dict/>` — no `com.apple.developer.applesignin`
- `app.json` has no `ios.usesAppleSignIn`
- Apple Developer: Service ID + Sign in with Apple key
- Supabase → Providers → Apple is disabled (verified: *"provider is not enabled"*)

The client code already handles it (`signInWithProvider('apple')`) — only configuration is missing.
Alternative: drop the Google button and this requirement disappears.

### 15. Screenshots — currently unusable
| File | Size |
|---|---|
| `01–03`, `first`, `homescreen` | 941 × 1672 |
| `04` | 852 × 1846 |
| `05–07` | 853 × 1844 |

None match an accepted iPhone size. Re-capture at **1320 × 2868** or **1290 × 2796** — upscaling is
rejected. Icons are fine (1024 × 1024).

### 16. App Store privacy labels
The build now collects the IDFA under ATT, so `PrivacyInfo.xcprivacy` declares
`NSPrivacyTracking = true`. App Store Connect → App Privacy must add:

- **Identifiers → Device ID** — *used for tracking*; Analytics + Developer's Advertising
- **Usage Data → Product Interaction** — Analytics, App Functionality
- **Diagnostics → Crash Data, Performance Data, Other Diagnostic Data**

Doing this after submission is a rejection.

---

## Not integrations, but they block a clean launch

~~**`test/entitlements.test.ts` is broken**~~ — ✅ resolved. Verified 2026-08-11:
`npm run typecheck` is clean, `npm run lint` reports 0 errors, and `npm run test:all` exits 0.

**`src/lib/practiceBlocks.ts:992`** — `// Placeholder thresholds — need calibrating against real
footage before shipping.` Still outstanding, and related to the wider calibration gap: the first
run now shows the user *their own* intonation before the paywall (`DiagnosticTake`), which makes
detector accuracy a conversion input rather than only a quality one. `test/fixtures/corpus/`
contains only its README — recording the labelled takes is the highest-value non-funnel work left.

**Android is entirely unwired** — no `google-services.json`, no Firebase gradle plugins, no Play
products. Consistent with the iOS-only decision, but `eas.json` still has Android build and submit
profiles that will fail if invoked.

---

## Appendix: how to re-check

```bash
URL=$(grep EXPO_PUBLIC_SUPABASE_URL .env | cut -d= -f2)
KEY=$(grep EXPO_PUBLIC_SUPABASE_ANON_KEY .env | cut -d= -f2)

# Migrations: any row with an empty "remote" is unapplied
supabase migration list --linked

# Edge function secrets (names only — HF_TOKEN should appear)
supabase secrets list

# OAuth providers: 400 "provider is not enabled" means not configured
curl -s "$URL/auth/v1/authorize?provider=google" | head -c 120
curl -s "$URL/auth/v1/authorize?provider=apple"  | head -c 120

# Edge functions: 404 = not deployed
for f in analyze-feedback session-chat delete-account revenuecat-webhook; do
  printf "%-22s " "$f"
  curl -s -o /dev/null -w "%{http_code}\n" -X POST "$URL/functions/v1/$f" \
    -H "apikey: $KEY" -H "Authorization: Bearer $KEY" \
    -H "Content-Type: application/json" -d '{}'
done

# HF_TOKEN end-to-end (needs a Pro account token)
TOKEN=$(curl -s -X POST "$URL/auth/v1/token?grant_type=password" -H "apikey: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"joshvigel+appreview@gmail.com","password":"Legato-Scroll-7565"}' \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['access_token'])")
curl -s -X POST "$URL/functions/v1/analyze-feedback" -H "apikey: $KEY" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"metrics":[{"key":"pitchAccuracy","score":70,"severity":"good"}],"playerCategory":"foundation","skillLevel":"beginner"}'

# Email/SMTP health — 429 means you're still on Supabase's built-in sender
curl -s -X POST "$URL/auth/v1/signup" -H "apikey: $KEY" -H "Content-Type: application/json" \
  -d '{"email":"you+probe'$RANDOM'@gmail.com","password":"TestPassword12345"}'
```
