# StringAI — Static Site

A minimal, self-contained static site for the StringAI app: landing page, Privacy Policy, Terms of Service / EULA, and Support page. Built for GitHub Pages. No build step, no dependencies — plain HTML + one CSS file.

## ✅ Live

Deployed at **https://marvalarva2929.github.io/stringai-site/** from the separate public repo `marvalarva2929/stringai-site` (branch `main`, root path).

**This folder is the source; that repo is the deploy target.** They are not linked — editing here does nothing until you copy the changed files across and push. Verify they still match before a submission:

```sh
for f in index privacy terms support; do
  diff <(curl -sL "https://marvalarva2929.github.io/stringai-site/$f.html") "site/$f.html" >/dev/null \
    && echo "match  $f" || echo "DIVERGED  $f"
done
```

The live URLs are wired into the app in `src/constants/links.ts` and recorded for submission in `store-assets/listing.md` — update both if the site ever moves.

## Files

| File | Purpose | App Store use |
|---|---|---|
| `index.html` | Landing page | Marketing / Support URL fallback |
| `privacy.html` | Privacy Policy (AI clause, data label, DMCA, warranty disclaimer, liability cap, indemnity, termination, arbitration) | **Privacy Policy URL** (required) |
| `terms.html` | Terms of Service / EULA (warranty disclaimer, liability cap, indemnity, arbitration) | **EULA / License Agreement URL** |
| `support.html` | Support + FAQ | **Support URL** (required) |
| `styles.css` | Shared styles (light + dark) | — |
| `.nojekyll` | Tells GitHub Pages to serve files as-is | — |

## Deploying to GitHub Pages

Because your app repo is private (GitHub Pages on private repos needs a paid plan) and contains internal files, the cleanest option is a **separate public repo** just for this site.

**Option A — dedicated public repo (recommended):**
1. Create a new public repo, e.g. `stringai-site`.
2. Copy the contents of this `site/` folder into the repo root.
3. Push to `main`.
4. Repo → **Settings → Pages** → Source: **Deploy from a branch** → Branch: `main` / `/ (root)` → Save.
5. Your site goes live at `https://<username>.github.io/stringai-site/`.

**Option B — serve from this repo's `/docs`:** rename `site/` to `docs/`, make the repo public (or use GitHub Pro), then Settings → Pages → Branch `main` / `/docs`.

## URLs to paste into App Store Connect / Google Play

Assuming `https://<username>.github.io/stringai-site/`:
- **Privacy Policy URL:** `.../privacy.html`
- **Support URL:** `.../support.html`
- **EULA / License Agreement URL:** `.../terms.html`

## Custom domain (optional)

To use e.g. `stringai.app`: add a file named `CNAME` (no extension) containing just `stringai.app`, point your domain's DNS at GitHub Pages, then set the custom domain under Settings → Pages.

## Maintenance notes

- Governing law / arbitration venue is set to **Texas**.
- `privacy.html` and `terms.html` both carry warranty, liability, indemnity, termination, and arbitration clauses. They are written to agree: the **US $100 / 12-months-paid liability cap is shared, not per-document**, the Terms control on conflict, and both use the same blow-up rule (class-waiver unenforceable ⇒ whole arbitration section void). **Change one, change the other** — divergent caps or divergent arbitration terms weaken both.
- Keep the **effective/last-updated dates** current whenever you change a document.
- Make sure your in-app **privacy label** in App Store Connect matches `privacy.html` (raw video/audio processed on device and not collected; email, purchases, identifiers, and derived data linked to the user; no tracking).
