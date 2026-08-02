import type { PracticeEvidence } from './practiceEvidence';
import type { PracticeBlock } from './practiceBlocks';

// ─────────────────────────────────────────────────────────────
// applyCuratedCopy (Phase 3.5 wiring)
//
// Curated blocks (CuratedBlockSpec) have no `type`/`target` — they're prose,
// not runnable drill definitions, so they can never replace a deterministic
// PracticeBlock outright (the runner in app/practice/[id].tsx needs the real
// structured target to run the exercise). Instead they overlay better copy
// (`reason`) onto whichever deterministic block covers the same issue(s).
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// LLM curation grounding (Phase 3)
//
// The LLM may reorder, merge, and re-word practice blocks, and name root causes
// the deterministic ranker can't — but it must never invent an issue. Every
// block and root cause it returns cites `issueIds`; this layer verifies each id
// against the real issue set before anything reaches the student.
//
// Two hard guards, both from the multi-agent experiment (docs/…-plan.md):
//   1. Unknown issueId  → strip it; drop the block/cause if nothing valid remains
//      (Haiku cited `vibrato:primary`, an id that wasn't in the input).
//   2. Root cause resting only on non-`high` measurement quality → reject
//      (Haiku promoted a `proxy` wrist metric to a root cause; Opus refused).
//
// If the LLM output is missing or nothing survives, we fall back to the
// deterministic candidate blocks — a free/offline user still gets a real plan.
// ─────────────────────────────────────────────────────────────

export interface CuratedRootCause {
  id: string;
  label: string;
  explanation: string;
  issueIds: string[];
  confidence: number;
}

export interface CuratedBlockSpec {
  title: string;
  minutes: number;
  issueIds: string[];
  whyThisDrill: string;
}

export interface CuratedPlan {
  rootCauses: CuratedRootCause[];
  blocks: CuratedBlockSpec[];
}

export type RejectionReason = 'unknown-issue' | 'no-valid-issues' | 'low-quality-basis';

export interface GroundingResult {
  plan: CuratedPlan;
  rejected: {
    rootCauses: Array<{ cause: CuratedRootCause; reason: RejectionReason }>;
    blocks: Array<{ block: CuratedBlockSpec; reason: RejectionReason }>;
  };
  usedFallback: boolean;
}

/**
 * Map the Edge Function's raw JSON (snake_case, untrusted) into a CuratedPlan.
 * Returns null when the payload has no usable blocks — the caller then grounds
 * against `null`, which triggers the deterministic fallback. Shape-only; the
 * issueId/quality guards live in groundCuratedPlan.
 */
export function parseCuratedResponse(data: unknown): CuratedPlan | null {
  if (!data || typeof data !== 'object') return null;
  const raw = data as Record<string, unknown>;
  const rawBlocks = Array.isArray(raw.blocks) ? raw.blocks : [];
  const rawCauses = Array.isArray(raw.root_causes) ? raw.root_causes : [];

  const blocks: CuratedBlockSpec[] = rawBlocks.flatMap((b) => {
    const o = b as Record<string, unknown>;
    if (typeof o.title !== 'string' || !Array.isArray(o.issue_ids)) return [];
    return [{
      title: o.title,
      minutes: typeof o.minutes === 'number' ? o.minutes : 5,
      issueIds: o.issue_ids.filter((id): id is string => typeof id === 'string'),
      whyThisDrill: typeof o.why_this_drill === 'string' ? o.why_this_drill : '',
    }];
  });

  if (blocks.length === 0) return null;

  const rootCauses: CuratedRootCause[] = rawCauses.flatMap((c, i) => {
    const o = c as Record<string, unknown>;
    if (typeof o.label !== 'string' || !Array.isArray(o.issue_ids)) return [];
    return [{
      id: typeof o.id === 'string' ? o.id : `rc-${i}`,
      label: o.label,
      explanation: typeof o.explanation === 'string' ? o.explanation : '',
      issueIds: o.issue_ids.filter((id): id is string => typeof id === 'string'),
      confidence: typeof o.confidence === 'number' ? o.confidence : 0.5,
    }];
  });

  return { rootCauses, blocks };
}

/** Express deterministic blocks in the curated shape, so fallback and LLM
 *  output are interchangeable downstream. */
export function candidatesFromBlocks(blocks: PracticeBlock[]): CuratedBlockSpec[] {
  return blocks.map((block) => ({
    title: block.title,
    minutes: block.estimatedMinutes,
    issueIds: block.evidenceRefs.map((ref) => ref.evidenceId),
    whyThisDrill: block.reason,
  }));
}

/**
 * Overlay curated `whyThisDrill` copy onto the deterministic blocks that cover
 * the same issue(s), matched by shared evidence id. Everything else about the
 * block (id, type, target, evaluator, evidenceRefs) is untouched, so the
 * runner and progress tracking behave exactly as they do for a purely
 * deterministic plan. Blocks with no curated coverage keep their original
 * `reason` — this is strictly additive.
 */
export function applyCuratedCopy(
  blocks: PracticeBlock[],
  curated: CuratedBlockSpec[],
): PracticeBlock[] {
  if (curated.length === 0) return blocks;
  return blocks.map((block) => {
    const ids = new Set(block.evidenceRefs.map((ref) => ref.evidenceId));
    const match = curated.find((c) => c.issueIds.some((id) => ids.has(id)));
    if (!match || !match.whyThisDrill) return block;
    return { ...block, reason: match.whyThisDrill };
  });
}

function qualityOf(issue: PracticeEvidence): 'high' | 'proxy' | 'low' | 'unavailable' {
  // Statistical findings and note-level evidence leave this undefined = high.
  return issue.measurementQuality ?? 'high';
}

export function groundCuratedPlan(args: {
  llm: CuratedPlan | null | undefined;
  issues: PracticeEvidence[];
  fallback: CuratedBlockSpec[];
}): GroundingResult {
  const { llm, issues, fallback } = args;
  const byId = new Map(issues.map((issue) => [issue.id, issue]));

  const rejected: GroundingResult['rejected'] = { rootCauses: [], blocks: [] };

  if (!llm) {
    return { plan: { rootCauses: [], blocks: fallback }, rejected, usedFallback: true };
  }

  // ── Root causes: every cited id must exist, and at least one must be high quality.
  const rootCauses: CuratedRootCause[] = [];
  for (const cause of llm.rootCauses ?? []) {
    const known = cause.issueIds.filter((id) => byId.has(id));
    if (known.length !== cause.issueIds.length) {
      rejected.rootCauses.push({ cause, reason: 'unknown-issue' });
      continue;
    }
    if (known.length === 0) {
      rejected.rootCauses.push({ cause, reason: 'no-valid-issues' });
      continue;
    }
    if (!known.some((id) => qualityOf(byId.get(id)!) === 'high')) {
      rejected.rootCauses.push({ cause, reason: 'low-quality-basis' });
      continue;
    }
    rootCauses.push(cause);
  }

  // ── Blocks: strip unknown ids; drop the block only if nothing valid remains.
  const blocks: CuratedBlockSpec[] = [];
  for (const block of llm.blocks ?? []) {
    const known = block.issueIds.filter((id) => byId.has(id));
    if (known.length === 0) {
      rejected.blocks.push({ block, reason: 'no-valid-issues' });
      continue;
    }
    blocks.push(known.length === block.issueIds.length ? block : { ...block, issueIds: known });
  }

  if (blocks.length === 0) {
    return { plan: { rootCauses, blocks: fallback }, rejected, usedFallback: true };
  }

  return { plan: { rootCauses, blocks }, rejected, usedFallback: false };
}
