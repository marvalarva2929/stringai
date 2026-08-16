import { useEffect } from 'react';
import { usePathname } from 'expo-router';

import { logScreen } from '../services/analytics';
import { setCurrentScreen } from '../services/crashReporting';

/** Static children of /practice — everything else under it is a block id. */
const PRACTICE_STATIC = new Set(['plan', 'complete', 'calibrate']);

/**
 * Collapses resolved dynamic segments back to their route pattern, so a
 * thousand session ids don't become a thousand screen names. `/piece/abc123`
 * reports as `/piece/[id]`.
 */
export function normalizeScreenName(pathname: string): string {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length < 2) return pathname === '' ? '/' : pathname;

  const [head, second] = parts;
  if (head === 'piece' || head === 'session') return `/${head}/[id]`;
  if (head === 'metric') return '/metric/[key]';
  if (head === 'practice') {
    return PRACTICE_STATIC.has(second) ? `/practice/${second}` : '/practice/[id]';
  }
  return pathname;
}

/**
 * Reports screen views from expo-router. Firebase's automatic screen reporting
 * is disabled in firebase.json because it sees native view controllers rather
 * than routes, which for a single-Stack expo-router app means one screen name
 * for the whole session.
 */
export function useScreenTracking(): void {
  const pathname = usePathname();

  useEffect(() => {
    const name = normalizeScreenName(pathname);
    logScreen(name);
    setCurrentScreen(name);
  }, [pathname]);
}
