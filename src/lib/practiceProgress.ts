import type { PracticePlan } from './practicePlan';
import type { PracticeBlock } from './practiceBlocks';

// Pure progress helpers, kept free of the zustand/AsyncStorage store so they
// can be unit-tested in plain Node.

/**
 * Progress is keyed by plan id so plans of different scopes can coexist. A daily
 * plan (`daily:YYYY-MM-DD`), a per-session plan (`session:<id>`) and a piece
 * warmup all live side by side; opening one no longer erases another's progress.
 */
export interface PracticeProgressSnapshot {
  completedByPlan: Record<string, string[]>;
}

/** Most recent plans to retain. Older entries are pruned on write. */
export const MAX_TRACKED_PLANS = 30;

/** Completed block ids for `planId`, or [] if that plan has no progress yet. */
export function completedBlockIdsFor(
  snapshot: PracticeProgressSnapshot,
  planId: string,
): string[] {
  return snapshot.completedByPlan[planId] ?? [];
}

/**
 * Record `blockId` as complete under `planId`, returning a new map. Re-marking
 * the same block is a no-op. The written plan is re-inserted last so that
 * pruning drops least-recently-written plans first (JS preserves string-key
 * insertion order).
 */
export function markComplete(
  completedByPlan: Record<string, string[]>,
  planId: string,
  blockId: string,
  maxPlans: number = MAX_TRACKED_PLANS,
): Record<string, string[]> {
  const current = completedByPlan[planId] ?? [];
  const ids = current.includes(blockId) ? current : [...current, blockId];

  const next: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(completedByPlan)) {
    if (key !== planId) next[key] = value;
  }
  next[planId] = ids;

  const keys = Object.keys(next);
  if (keys.length <= maxPlans) return next;
  for (const stale of keys.slice(0, keys.length - maxPlans)) delete next[stale];
  return next;
}

/** First block in ranked order not yet completed, or null if the plan is done. */
export function nextIncompleteBlock(
  plan: PracticePlan,
  completedIds: string[],
): PracticeBlock | null {
  return plan.blocks.find((block) => !completedIds.includes(block.id)) ?? null;
}
