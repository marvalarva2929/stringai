/**
 * Remote paywall copy tests.
 *
 *   node --experimental-strip-types --loader ./test/ts-resolver.mjs test/paywallContent.test.ts
 *   (or: npm run test:paywallcontent)
 *
 * One property dominates: a bad offering must never blank the paywall. The copy
 * is fetched from a RevenueCat dashboard where anyone can typo a key, paste the
 * wrong type into a field, or delete a row — and the paywall is the only way
 * into a subscription-only app. Every field therefore has to fall back
 * independently, so a broken `features` value costs the feature list and
 * nothing else.
 *
 * The second is that `diagnosticFocusTitle` never invents a fault. It reads the
 * session's frozen evidence so the paywall's claim and the first drill in the
 * practice plan name the same thing; with no evidence it must say nothing
 * rather than guess.
 */

import {
  paywallCopyFromMetadata,
  diagnosticFocusTitle,
  DEFAULT_FEATURES,
  DEFAULT_HEADLINE_MANDATORY,
  DEFAULT_HEADLINE_OPTIONAL,
  DEFAULT_PERSONAL_NOTE,
} from '../src/lib/paywallContent';

let failures = 0;

function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const mandatory = { mandatory: true };
const optional = { mandatory: false };

console.log('\nFallbacks');

{
  const copy = paywallCopyFromMetadata(undefined, mandatory);
  check('no metadata at all still yields a complete paywall',
    copy.headline === DEFAULT_HEADLINE_MANDATORY &&
    copy.features.length === DEFAULT_FEATURES.length &&
    copy.personalNote === DEFAULT_PERSONAL_NOTE &&
    copy.variant === 'default');
}

check('the headline differs between the gate and an optional upsell',
  paywallCopyFromMetadata({}, mandatory).headline === DEFAULT_HEADLINE_MANDATORY &&
  paywallCopyFromMetadata({}, optional).headline === DEFAULT_HEADLINE_OPTIONAL);

{
  // The failure that matters: someone sets one key and leaves the rest blank.
  const copy = paywallCopyFromMetadata({ headline: 'Play in tune by October' }, mandatory);
  check('a partial offering overrides only what it sets',
    copy.headline === 'Play in tune by October' &&
    copy.features.length === DEFAULT_FEATURES.length &&
    copy.personalNote === DEFAULT_PERSONAL_NOTE);
}

{
  const copy = paywallCopyFromMetadata(
    { headline: 42, features: { nope: true }, variant: null } as Record<string, unknown>,
    mandatory,
  );
  check('wrong types fall back rather than rendering "42" or crashing',
    copy.headline === DEFAULT_HEADLINE_MANDATORY &&
    copy.features.length === DEFAULT_FEATURES.length &&
    copy.variant === 'default');
}

check('whitespace-only values are treated as absent',
  paywallCopyFromMetadata({ headline: '   ' }, mandatory).headline === DEFAULT_HEADLINE_MANDATORY);

console.log('\nFeature list shapes');

check('a JSON array is read as-is',
  paywallCopyFromMetadata({ features: ['One', 'Two'] }, mandatory).features.join('|') === 'One|Two');

check('a newline-separated string is accepted (what a text field produces)',
  paywallCopyFromMetadata({ features: 'One\nTwo\nThree' }, mandatory).features.join('|') === 'One|Two|Three');

check('blank lines and padding are stripped',
  paywallCopyFromMetadata({ features: '  One  \n\n  Two  \n' }, mandatory).features.join('|') === 'One|Two');

check('an empty array falls back rather than rendering an empty box',
  paywallCopyFromMetadata({ features: [] }, mandatory).features.length === DEFAULT_FEATURES.length);

check('non-string array entries are dropped',
  paywallCopyFromMetadata({ features: ['One', 5, null, 'Two'] } as Record<string, unknown>, mandatory)
    .features.join('|') === 'One|Two');

console.log('\nThe personal note can be switched off remotely');

check('an absent key keeps the default note',
  paywallCopyFromMetadata({ headline: 'x' }, mandatory).personalNote === DEFAULT_PERSONAL_NOTE);

check('an explicit empty string removes it',
  paywallCopyFromMetadata({ personal_note: '' }, mandatory).personalNote === null);

check('a value replaces it',
  paywallCopyFromMetadata({ personal_note: 'Built by one person.' }, mandatory).personalNote ===
    'Built by one person.');

console.log('\nVariant labelling');

check('a variant rides through for attribution',
  paywallCopyFromMetadata({ variant: 'goal_first_b' }, mandatory).variant === 'goal_first_b');

console.log('\nEchoing the diagnostic');

check('no session means no claim', diagnosticFocusTitle(undefined) === null);
check('empty evidence means no claim', diagnosticFocusTitle([]) === null);

check('the highest-priority finding is the one shown',
  diagnosticFocusTitle([
    { title: 'Bow speed uneven', priority: 2 },
    { title: 'Third finger runs flat', priority: 9 },
    { title: 'Tone thins near the tip', priority: 5 },
  ]) === 'Third finger runs flat');

check('a single finding needs no priority',
  diagnosticFocusTitle([{ title: 'Third finger runs flat' }]) === 'Third finger runs flat');

check('a blank title is not shown as an empty claim',
  diagnosticFocusTitle([{ title: '   ', priority: 9 }]) === null);

check('the input is not mutated by sorting',
  (() => {
    const evidence = [
      { title: 'First', priority: 1 },
      { title: 'Second', priority: 9 },
    ];
    diagnosticFocusTitle(evidence);
    return evidence[0].title === 'First';
  })());

console.log(
  failures === 0 ? '\nAll paywall content tests passed.\n' : `\n${failures} failure(s).\n`,
);

process.exit(failures === 0 ? 0 : 1);
