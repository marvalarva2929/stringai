// Public legal + support URLs, centralized so the App Store submission and the
// in-app links (settings, register, paywall) never drift.
//
// Live at github.com/marvalarva2929/stringai-site, served by GitHub Pages from
// the repo root. The source of these pages is this repo's `site/` folder — edit
// there, then copy across and push, or the two silently diverge.
//
// Paths keep their `.html` extension deliberately. GitHub Pages does resolve the
// extensionless form too, but that's a convenience of the host, not a promise;
// if the site ever moves to a custom domain or another static host, the explicit
// paths are the ones guaranteed to survive the move.
const SITE_ORIGIN = 'https://marvalarva2929.github.io/stringai-site';

export const PRIVACY_POLICY_URL = `${SITE_ORIGIN}/privacy.html`;
export const TERMS_OF_SERVICE_URL = `${SITE_ORIGIN}/terms.html`;

/** App Store Connect "Support URL" — also the FAQ users are pointed at. */
export const SUPPORT_URL = `${SITE_ORIGIN}/support.html`;

/** App Store Connect "Marketing URL" (optional field). */
export const MARKETING_URL = `${SITE_ORIGIN}/`;

/** Must match the address published on the support page. */
export const SUPPORT_EMAIL = 'joshvigel@gmail.com';
