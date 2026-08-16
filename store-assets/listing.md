# App Store Connect listing copy — StringAI

Draft copy for every text field App Store Connect requires. Character counts are
Apple's hard limits; the count in parentheses is what the draft below uses.
Nothing here is wired into the app — this is submission metadata, pasted into
App Store Connect by hand.

---

## App Name — limit 30

```
StringAI: Violin Practice
```
(25)

Alternative if the name is taken: `StringAI — Violin Coach` (23)

---

## Subtitle — limit 30

```
AI feedback on how you play
```
(27)

---

## Promotional Text — limit 170 (editable without a new build)

```
Record a practice session and get specific, measured feedback on intonation, tone, bowing, rhythm, and posture — analyzed on your device in seconds.
```
(148)

---

## Description — limit 4000

```
Practice like a teacher is listening.

StringAI records your playing, measures what you actually did, and turns it into
clear coaching — one thing to work on at a time. No vague encouragement, no
guesswork: every note is measured, and every piece of advice points at something
real in your recording.

WHAT IT MEASURES

• Intonation — how close each note lands to the pitch you meant, and how steady
  you hold it once you get there
• Tone — brightness, stability, and the scratch, whistle, and surface-noise
  faults that come from bow speed, weight, and contact point
• Bowing — bow angle and travel, straightness through the stroke, and how much
  of the bow you actually use
• Rhythm — timing against the beat, note by note
• Posture — bow hold and left-hand wrist angle, tracked with on-device vision

HOW A SESSION WORKS

1. Record. Point your phone at yourself and play — a scale, an exercise, or a
   piece you're working on.
2. Get measured. Pitch, tone, bow motion, and posture are analyzed right on your
   device in seconds.
3. Get one thing to fix. An AI coach reads the findings and tells you the one or
   two things that matter most this session — with an exercise that targets them.
4. Practice it. Guided practice blocks turn the diagnosis into something you can
   actually do, then check whether it worked.

BUILT TO SHOW PROGRESS

Every session is scored the same way, so your trend lines mean something over
weeks and months. Track any metric over time, compare attempts at the same
passage side by side, pin the piece you're working on, and set a weekly practice
goal you can actually keep.

YOUR RECORDINGS STAY ON YOUR DEVICE

Practice video and audio are analyzed on your phone. Raw recordings are never
uploaded to our servers. What syncs is your scores and progress — not the
footage.

SUBSCRIPTION

StringAI requires a subscription. Start with a free trial — 7 days on the
monthly plan, 14 days on the annual plan — and cancel any time before it ends
without being charged. Every subscription includes:

• Live camera recording with real-time feedback while you play
• Personal AI coaching after every session
• Unlimited analyses of every piece you play
• Full metric scoring, session history and progress tracking

StringAI Pro is an auto-renewing subscription, available monthly (TODO: $X.XX)
or annually (TODO: $XX.XX). Free trial length depends on the plan chosen: 7 days
monthly, 14 days annually. A free trial is available once per subscription
group; if you have used one before, you will be charged at purchase. Payment is
charged to your Apple ID at confirmation of purchase, or at the end of the free
trial period. It renews automatically unless canceled at least 24 hours before
the end of the current period; your account is charged for renewal within 24
hours before the period ends. Any unused portion of a free trial is forfeited
when you purchase a subscription. Manage or cancel in your Apple ID settings
after purchase.

FOR WHO

Adult beginners, returning players, students between lessons, and anyone
practicing without a teacher in the room. Violin first — the measurement work is
built on the violin's range and technique.

A NOTE ON WHAT THIS IS NOT

StringAI is a practice tool, not a teacher and not a medical or diagnostic
product. Its measurements and AI feedback can be wrong. Treat them as a second
opinion on your own ears, not a verdict.

Privacy Policy and Terms: see the links below.
```

**Before pasting:** delete the "A NOTE ON WHAT THIS IS NOT" heading style if you
prefer — App Store descriptions do not render markdown, only line breaks. The
draft above is already plain text; keep the blank lines, drop nothing else.

---

## Keywords — limit 100 chars total, comma-separated, NO spaces after commas

```
violin,practice,intonation,tuner,tone,bowing,posture,music,coach,strings,fiddle,lessons,ear,rhythm
```
(98)

Notes:
- Do not repeat words already in the app name or subtitle — Apple indexes those
  separately, so `StringAI`, `AI`, and `feedback` are deliberately absent.
- Singular forms only; Apple matches plurals automatically.

---

## What's New in This Version — limit 4000

For 1.0 this field is optional. If you fill it:

```
First release. Record a practice session and get measured feedback on
intonation, tone, bowing, rhythm, and posture, plus a coached plan for what to
work on next.
```

---

## Categories

- **Primary:** Education
- **Secondary:** Music

Rationale: the app teaches and tracks progress; Education has the closer intent
match and a less crowded top-chart field than Music.

---

## URLs

Live on GitHub Pages at `github.com/marvalarva2929/stringai-site`. All four
verified reachable (HTTP 200) on 2026-08-01 and byte-identical to this repo's
`site/` folder. Paste these in exactly:

| Field | Value | Required? |
|---|---|---|
| Privacy Policy URL | `https://marvalarva2929.github.io/stringai-site/privacy.html` | **Required** |
| Support URL | `https://marvalarva2929.github.io/stringai-site/support.html` | **Required** |
| Marketing URL | `https://marvalarva2929.github.io/stringai-site/` | Optional |
| EULA / License Agreement URL | `https://marvalarva2929.github.io/stringai-site/terms.html` | Optional |

`src/constants/links.ts` already points at these, so the in-app links in
Settings, Register, and the paywall match what you submit.

If you later move to a custom domain (`stringai.app`), the only two places to
change are that constants file and this table.

---

## App Review Information

**This is the field most likely to get 1.0 rejected.** The app requires an
account before anything works, so App Review must be handed a working login:

- **Sign-in required:** Yes
- **Demo account:** create a real account on the production Supabase project and
  put the email and password here. Give it Pro entitlement so the reviewer can
  reach the gated screens, and leave a few analyzed sessions in its history so
  Progress and Piece screens are not empty.
- **Notes to reviewer:** draft below.

```
StringAI analyzes violin practice recordings on-device.

To review the core flow you will need a real instrument sound — the analysis
runs on live audio and video from the camera and microphone, so it must be
tested on a physical device, not the simulator.

If an instrument is not available, any sustained pitched sound (a tuner app,
a sung note) will produce a scored session and exercise the full analysis and
results flow.

The demo account provided has Pro access enabled and existing session history,
so Progress, Piece detail, and the practice-plan screens are populated.

Camera is used to measure bow angle and posture; microphone is used to measure
pitch, tone, and rhythm. Raw video and audio are processed on device and are
never uploaded to our servers.
```

---

## Age Rating

Still an open decision (see the launch checklist). The relevant answers:

- No objectionable content of any kind — the questionnaire itself should come
  back 4+.
- The real question is the **target-audience declaration** and whether the app
  is made available to under-13 users, since sign-up is email + password with no
  age gate. If minors are in scope, COPPA obligations and a parental-consent
  flow follow. If they are not, say so in App Store Connect and consider adding
  an age gate at registration so the declaration is actually enforced.

---

## App Privacy (nutrition label)

Separate from `ios/StringAI/PrivacyInfo.xcprivacy` — that file covers required-
reason APIs, this is the App Store Connect questionnaire. Answer it to match
`site/privacy.html`:

| Data type | Collected | Linked to user | Used for tracking | Purpose |
|---|---|---|---|---|
| Email address | Yes | Yes | No | App Functionality |
| User ID | Yes | Yes | No | App Functionality |
| Purchase history | Yes | Yes | No | App Functionality |
| Product interaction | Yes | Yes | No | App Functionality |
| Audio data | **No** | — | — | Processed on device, not collected |
| Photos or videos | **No** | — | — | Processed on device, not collected |

The audio/video rows are the ones a reviewer may push back on — the answer is
that analysis runs on-device and only derived scores leave the phone.
