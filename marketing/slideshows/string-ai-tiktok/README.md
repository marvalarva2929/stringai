# String AI TikTok pipeline

Drop photos and app screenshots into `assets/inbox/`, then tell Claude Code:

> sort the inbox and build me 10 decks

Everything else — slot assignment, compositing, assembly rules, logging — is in
`SKILL.md`.

## Install

Claude Code:
```
mkdir -p ~/.claude/skills
cp -r string-ai-tiktok ~/.claude/skills/
```
Or drop the folder in a project as `.claude/skills/string-ai-tiktok/`.

```
pip install pillow
```

## Manual build

```
python3 scripts/build_decks.py --count 10
```
