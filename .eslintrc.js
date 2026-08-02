// ESLint 8 (eslintrc format) — eslint-config-expo ships both a flat and a
// legacy entry point; `expo` resolves to the legacy one, which is what v8 reads.
module.exports = {
  root: true,
  extends: ['expo'],
  ignorePatterns: [
    'node_modules/',
    '.expo/',
    'dist/',
    'android/',
    'ios/',
    'ml/',              // Python
    'site/',            // static marketing pages, no build step
    'graphify-out/',
    'supabase/functions/', // Deno runtime — URL imports and Deno globals
    '*.config.js',
  ],
};
