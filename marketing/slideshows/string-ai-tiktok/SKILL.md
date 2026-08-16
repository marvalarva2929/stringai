---
name: string-ai-tiktok
description: Turn a folder of raw photos and app screenshots into finished TikTok slideshow decks for String AI, then post them as drafts and track what works. Use when the user drops images into assets/inbox, asks for new decks, asks what to post, or asks how recent posts performed.
---

# String AI — TikTok slideshow pipeline

The user drops photos and screenshots into `assets/inbox/`. You do everything else:
sort them into slots, build the decks, queue them as drafts, and report back on what
performed.

## Layout

```
assets/inbox/       raw drops — any filename, any size
assets/sorted/      you rename into here: 1A.jpg .. 6F.jpg
assets/retired/     assets pulled from rotation
copy/matrix.json    all slide copy, keyed by slot + variant
scripts/build_decks.py
out/deck_NN/        finished slides, 01.jpg..06.jpg
log/posts.json      what was posted, which variants, how it did
```

## The six slots

Slot order is fixed. Only the variant changes between posts. `copy/matrix.json`
is the source of truth — read it before doing anything, and note the `asset`
field on each slot, which describes what kind of image belongs there.

| Slot | Role | Asset it needs |
|---|---|---|
| 1 | Hook | Violin, case, bedroom, music stand. Atmospheric. Never app UI. |
| 2 | A tip, with the one casual String AI mention inside it | Sheet music, notebook, tuner, open case. Never app UI. |
| 3 | Ear and intonation tips | Fingerboard, strings, tuner, hand in position |
| 4 | Bow, vibrato and posture tips | Bow hold, right arm mid-stroke, chin and shoulder |
| 5 | Practice structure tips | Music stand, practice space, notebook, metronome |
| 6 | Warm sign-off, second app mention | App screenshot, or a closing atmospheric shot |

## Step 1 — Sort the inbox

Look at each image in `assets/inbox/` and decide which slot it belongs to, using
the asset descriptions above and in the matrix. You can see the images — use that
rather than guessing from filenames.

Then copy it to `assets/sorted/{slot}{variant}.jpg`, filling empty variant letters
first. Report what you did in a short table and say which slots are still short.

Judgement calls:

- **Prefer his own photos over anything generated.** A slightly imperfect phone
  photo outperforms a clean render in this niche. Never upscale or "improve" them.
- **Slots 1, 2 and 5 are the ones people screenshot.** Put the best atmospheric
  images there, and make the six within a slot look clearly different from each
  other — a repeat viewer notices the cover before anything else.
- **Screenshots belong in slot 6, and sparingly in 3 and 4.** Slots 1, 2 and 5
  should be photographs. If the inbox has more screenshots than slot 6 needs,
  hold them rather than forcing them into a photo slot.
- If an image doesn't fit any slot, leave it in inbox and say so. Don't force it.

Slots don't all hold six variants — read `copy/matrix.json` for the real count and
fill every letter it lists. Slots 1, 2 and 6 currently carry extras for the
"can't afford a teacher" angle. The script runs on a partial set: it only picks
variants that have a background, and reports which are missing.

## Step 2 — Build

```bash
python3 scripts/build_decks.py --count 10
```

Writes `out/deck_NN/01.jpg..06.jpg` and `out/manifest.json`. The script handles
slot assembly rules itself: no variant repeats within four consecutive decks, and
hooks that promise a specific payoff are constrained to variants that deliver it.

Show the user a couple of finished decks before building the full batch. If the
text sits badly on a particular photo — busy background, text over a face — swap
that asset rather than tuning the script.

## Step 3 — Post as drafts

Post at `SELF_ONLY` privacy so slides land in his TikTok inbox as drafts, not on
his feed. He adds a trending sound and publishes manually. This is not a
limitation to engineer around — it is the workflow:

- Silent slideshows get buried. Music is the single biggest reach lever and no API
  can know what's trending in the violin niche today.
- `SELF_ONLY` is what an unaudited TikTok app is restricted to anyway, so this
  costs nothing.
- It keeps a human between the generator and the public account.

Use whichever posting connector is configured (an MCP server, or a direct
Content Posting API script). If none is set up, stop after building and tell him
the decks are ready to upload manually — do not improvise a posting path.

Spacing: three posts a day maximum, at least four hours apart. Never batch-drop.

## Step 4 — Log

After each post, append to `log/posts.json`:

```json
{
  "date": "2026-08-16",
  "deck": "deck_03",
  "slides": ["1C", "2A", "3F", "4D", "5B", "6A"],
  "caption": "...",
  "posted_at": "16:30",
  "views": null, "saves": null, "comments": null, "profile_clicks": null
}
```

Fill the metrics in on a later run — TikTok posts peak at 24–48 hours, so numbers
pulled sooner are noise.

## Step 5 — Weekly review

When asked how things are doing, or after ~10 logged posts, group by hook variant
(slot 1) and by slot 2 variant, and apply:

| Views | Profile clicks | Read |
|---|---|---|
| High | High | Working. Make variations of this hook. |
| High | Low | Hook is fine, the app mention isn't landing. Rotate slot 2 and 6. |
| Low | High | Content converts, nobody sees it. Change the hook, keep everything else. |
| Low | Low | Reset. New asset style, new angle. |

Decision rules: a hook that lands under 1k views twice gets retired from
`copy/matrix.json`. A hook that clears 20k gets three new variations written in the
same voice. Move retired assets to `assets/retired/`.

Report this conversationally — what's working, what to drop, what to write next.
Don't dump the table.

## Rules that don't bend

- **Every slide carries a real tip.** The advice in `copy/matrix.json` is
  researched and standard — open strings as reference pitches, contact point,
  thumb tension killing vibrato, slow-medium-fast. A slide that only describes a
  feature is a slide nobody saves. If you write new copy, the tip comes first and
  it has to be true; check it before you write it.
- **The app is named exactly twice per deck** — once in slot 2, once in slot 6.
  Slots 3, 4 and 5 never mention it. This is the single most important rule here;
  more mentions is what makes the whole deck read as an ad.
- **In slot 2 the app is an aside inside advice, never the advice itself.**
  "check your notes against a drone or a tuner — i use {app}, it tells me which
  ones i got wrong" is right. "{app} tells you which notes are out of tune" is
  wrong, even though it says the same thing. Naming the free alternative
  alongside is deliberate: it's what makes it read as a person and not a pitch.
- **Keep the emoji.** Lowercase, warm, emoji-heavy, like a student texting a
  friend. The compositor renders colour emoji properly. Never strip them to make
  tooling simpler and never rewrite copy into a more professional register.
- **One app screenshot per deck, two at most.**
- **Never invent claims about what String AI does.** If new copy needs a feature
  that isn't already in the matrix, ask.
- **Don't post on his behalf without him seeing the deck first.**
- **The affordability slides stay warm, never bitter.** "teachers are expensive
  and that's okay, you can do this" — encouraging someone who can't afford
  lessons, never running teachers down to sell an app.

## First run

Before the first post, ask whether the TikTok account is new or has history. If
it's fresh, tell him to use it normally for 7–14 days first — scroll, follow
violin accounts, like sparingly, comment occasionally, maybe post something casual.
A brand-new account that immediately starts posting slideshows reads as automated
and gets throttled from the first post. The signal it's ready: his For You page is
mostly violin content.

## Setup

```bash
pip install pillow
```

Fonts: the script looks for Poppins, then falls back to system Arial. For colour
emoji it looks for Noto Color Emoji, Apple Color Emoji, then Segoe UI Emoji. On
macOS Apple Color Emoji is already present. On Linux:
`sudo apt install fonts-noto-color-emoji fonts-poppins`.

If it prints `no colour emoji font found`, stop and fix that before building —
decks without emoji are off-voice.
