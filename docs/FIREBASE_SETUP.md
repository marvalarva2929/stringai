# Firebase Analytics & Crashlytics — setup

The app code is fully wired. Everything below is console/Xcode work that cannot be done from the
repo, plus the one file that is not in source control.

Until step 1 is done the app runs normally with all telemetry disabled — `isAnalyticsConfigured`
is `false`, every `track()` call no-ops, and `AppDelegate.swift` skips `FirebaseApp.configure()`
because there is no plist to configure from. Nothing breaks; nothing is reported either.

---

## 1. Create the Firebase project and add the plist

1. <https://console.firebase.google.com> → **Add project** → enable Google Analytics, attach or
   create a GA4 property.
2. **Add app → iOS**, bundle ID **`com.stringai.app`** (must match `app.json` exactly).
3. Download **`GoogleService-Info.plist`**.
4. Put a copy at the repo root (`app.json` points `ios.googleServicesFile` here for any future
   prebuild) **and** add it to the Xcode target:

   ```
   open ios/StringAI.xcworkspace
   ```
   Drag the file into the `StringAI` group → tick **Copy items if needed** → tick the **StringAI**
   target. It must appear under *Build Phases → Copy Bundle Resources*; if it doesn't, the app
   ships without it and analytics stays silent.

5. In the Firebase console enable **Crashlytics**, **Analytics** and **Performance Monitoring**.

Whether to commit the plist is your call — it is a client config file, not a secret (Firebase
security comes from rules and App Check), and committing it is the common choice because it keeps
CI builds working without extra secret plumbing.

## 2. Register custom dimensions (do not skip)

GA4 collects event parameters but will not show them in any report until each is registered as a
custom dimension. Unregistered parameters are silently invisible — this is the single easiest way
to end up with an instrumented app and empty dashboards.

**GA4 → Admin → Custom definitions → Create custom dimension** (event-scoped) for:

`source` · `plan` · `step` · `step_id` · `prev_step` · `activation_step` · `scope` · `reason` ·
`stage` · `method` · `permission` · `block_type` · `page_name` · `metric_key` · `trigger` ·
`outcome` · `engine` · `degraded` · `is_demo` · `has_trial` · `result` · `delivery` · `domain` ·
`saved_remote` · `will_fetch_coaching`

User-scoped dimensions for the properties in `src/lib/analyticsUserProps.ts`:
`entitlement` · `in_trial` · `is_authenticated` · `skill_level` · `player_category` ·
`learning_goal` · `daily_time` · `weekly_goal_min` · `violin_size` · `activation_step` ·
`used_demo` · `progress_stage` · `session_count_bkt` · `streak_bkt` · `reminders_enabled` ·
`notif_permission` · `att_status`

## 3. Mark Key Events (conversions)

**GA4 → Admin → Events → Mark as key event**:

`onboarding_complete` · `activation_complete` · `analysis_completed` · `practice_plan_complete` ·
`begin_checkout` · `trial_started` · `purchase`

## 4. BigQuery export

**Firebase → Project settings → Integrations → BigQuery → Link**. Daily export is free and is the
only way to answer questions the console can't — per-user funnels, custom cohorts, and joins back
to the Supabase `sessions` table. An `events_intraday_` table appears within 24h.

## 5. Crashlytics alerts

**Crashlytics → ⚙ → Alert settings**: enable *velocity*, *new issue* and *regression* alerts, and
point them at your email or a Slack webhook.

## 6. RevenueCat → Firebase

This is what makes churn measurable. RevenueCat sends subscription lifecycle events —
`trial_converted`, `renewal`, `cancellation`, `billing_issue`, `refund` — to GA4 server-side, so
they arrive even when the app is never opened. Client events alone can never see a cancellation.

1. **GA4 → Admin → Data streams →** your iOS stream **→ Measurement Protocol API secrets →
   Create**. Copy the secret.
2. **RevenueCat → Project settings → Integrations → Firebase**: paste the **Firebase App ID**
   (`Project settings → General → App ID`) and that API secret.

The client half is already done — `app/_layout.tsx` calls `fetchAppInstanceId()` and passes it to
`Purchases.setFirebaseAppInstanceID()` on every identify. Without it RevenueCat cannot match a
customer to a GA4 user and the integration silently delivers nothing.

## 7. App Store Connect privacy labels

The app now collects the IDFA when ATT is authorised, so `PrivacyInfo.xcprivacy` declares
`NSPrivacyTracking = true`. **App Store Connect → App Privacy** must be updated to match before
the next build is submitted:

- **Identifiers → Device ID** — *used for tracking*, purposes: Analytics, Developer's Advertising
- **Usage Data → Product Interaction** — Analytics, App Functionality
- **Diagnostics → Crash Data, Performance Data, Other Diagnostic Data** — App Functionality

---

## Verifying it works

### The debug panel (fastest check)

`/debug` (dev builds only) now has a **Firebase Telemetry** panel showing whether Analytics and
Crashlytics are configured, the current ATT status, and the GA4 app instance id — plus buttons to
fire a test non-fatal, re-ask ATT, and force a crash. If "Analytics: NOT configured" or the app
instance id is blank, stop here and fix step 1; nothing downstream can work.

### DebugView (real-time event stream)

Xcode → *Product → Scheme → Edit Scheme → Run → Arguments*, add the launch argument:

```
-FIRAnalyticsDebugEnabled
```

Then run on a device and watch **Firebase console → Analytics → DebugView** while walking each
funnel: onboarding → activation → record/upload → results → practice → paywall. Every event and
parameter should appear with the right types. Standard reports lag ~24h; DebugView is instant.

### Monetisation events

`FORCE_ONBOARDING` and `DEBUG_FORCE_PRO` in `src/constants/featureFlags.ts` are both `true` under
`__DEV__`. **With `DEBUG_FORCE_PRO` on, every gate and paywall event is unreachable** — flip it to
`false` temporarily to exercise `capture_gate_blocked`, `paywall_view`, `begin_checkout` and
`purchase`. Purchases need a real device and a sandbox Apple ID; RevenueCat does not work in the
Simulator.

### Crashlytics

- **Non-fatal:** *Test non-fatal* in the debug panel, or upload a video with no audio track — the
  latter should also produce `analysis_degraded` in DebugView. Crashlytics batches non-fatals, so
  they usually appear after the next app launch, carrying the `entitlement` / `activation_step`
  custom keys.
- **Fatal:** *Force crash* in the debug panel, in a **release** build. `expo-dev-client`'s error
  overlay swallows native crashes, so a dev-client build will report nothing. Confirm the issue
  appears and that no "missing dSYM" banner is shown — the *[Firebase] Upload Crashlytics dSYMs*
  build phase handles the upload and skips itself cleanly when Firebase is not configured.

### If you ever regenerate the native project

`ios/` is committed and hand-edited, so this setup was applied manually rather than by config
plugins. Two pieces of iOS build config are load-bearing and easy to lose:

- `ios/Podfile` — `$RNFirebaseDisableSPM` / `$RNFirebaseAsStaticFramework` /
  `$RNFirebaseAnalyticsEnableAdSupport`. SPM needs dynamic frameworks; MediaPipe forces static, so
  Firebase has to come through CocoaPods.
- `ios/Podfile.properties.json` — `ios.forceStaticLinking` listing the four RNFB pods. Without it
  the build fails with *"include of non-modular header inside framework module"*: RNFB's public
  headers import React Native core headers by path, which is invalid once the pod is built as a
  framework module. Expo applies the same fix to its own pods for the same reason. Mirrored in
  `app.json` under `expo-build-properties` so a future prebuild reproduces it.
- `ios/StringAI/Info.plist` — `NSUserTrackingUsageDescription`. This is the real Info.plist; the
  copy in `app.json` under `ios.infoPlist` only takes effect on prebuild. Without the key, calling
  the ATT prompt **terminates the app** on device, and App Review rejects the build.

Keep the pod list in sync with the installed `@react-native-firebase/*` packages.

### Known limitation

Crashlytics cannot symbolicate Hermes JavaScript frames, so JS stacks are minified in release
builds. The breadcrumbs (`breadcrumb()`) and custom keys set by `useAnalyticsIdentity` are what
make those reports actionable. Full JS symbolication would need `metro-symbolicate` run against
the source map EAS produces.
