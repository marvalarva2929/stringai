// Resolver hook: lets `node --experimental-strip-types` run the project's
// extensionless relative TypeScript imports (e.g. `import './dsp'`) by appending
// `.ts` when the bare specifier doesn't resolve on its own.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export async function resolve(specifier, context, next) {
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[mc]?[jt]sx?$/.test(specifier)) {
    try {
      const base = new URL(specifier, context.parentURL);
      if (existsSync(fileURLToPath(base) + '.ts')) return next(specifier + '.ts', context);
    } catch {
      /* fall through to default resolution */
    }
  }
  return next(specifier, context);
}
