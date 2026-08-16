#!/usr/bin/env node
// Generates the Apple "client_secret" JWT that Supabase's Apple provider wants
// pasted into its "Secret Key" field (the dashboard only exposes "Client IDs" +
// "Secret Key" — it does not build this JWT for you the way some other BaaS
// dashboards do).
//
// Usage:
//   node scripts/generateAppleClientSecret.js <path-to-AuthKey.p8> <teamId> <keyId> <servicesId>
//
// Example:
//   node scripts/generateAppleClientSecret.js ~/Downloads/AuthKey_ABC123XYZ9.p8 \
//     TTKYKL258N ABC123XYZ9 com.stringai.app.signin
//
// Apple caps the expiry at 6 months from issue — this uses 180 days. Paste the
// output into Supabase's "Secret Key" field, and put the Services ID into
// "Client IDs". You will need to regenerate and re-paste before it expires;
// Supabase does not refresh it automatically for you in this simplified UI.

const fs = require('node:fs');
const crypto = require('node:crypto');

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function main() {
  const [, , p8Path, teamId, keyId, servicesId] = process.argv;
  if (!p8Path || !teamId || !keyId || !servicesId) {
    console.error(
      'Usage: node scripts/generateAppleClientSecret.js <path-to-AuthKey.p8> <teamId> <keyId> <servicesId>'
    );
    process.exit(1);
  }

  const privateKey = fs.readFileSync(p8Path, 'utf8');

  const now = Math.floor(Date.now() / 1000);
  const expiresIn = 60 * 60 * 24 * 180; // 180 days, under Apple's 6-month cap

  const header = { alg: 'ES256', kid: keyId };
  const payload = {
    iss: teamId,
    iat: now,
    exp: now + expiresIn,
    aud: 'https://appleid.apple.com',
    sub: servicesId,
  };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;

  // JWS ES256 needs the raw (IEEE P1363) r||s signature format, not the DER
  // encoding Node's crypto produces by default.
  const signature = crypto
    .createSign('SHA256')
    .update(signingInput)
    .sign({ key: privateKey, dsaEncoding: 'ieee-p1363' });

  const jwt = `${signingInput}.${base64url(signature)}`;

  console.log(jwt);
  console.error(`\n(expires ${new Date((now + expiresIn) * 1000).toISOString()})`);
}

main();
