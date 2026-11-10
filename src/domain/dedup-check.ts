import type { Entity } from './types.js';
import { DEFAULT_SIMILARITY_THRESHOLD, rankSimilar, type SimilarCandidate } from './similarity.js';

/**
 * Read-only pre-create duplicate check.
 *
 * Agents routinely create duplicate entities because they do not reliably
 * search before creating. This helper surfaces ranked candidates for human
 * (or agent) review using the similarity scoring in similarity.ts. It never
 * writes, merges, selects, or archives anything — it only reports.
 *
 * Decision boundaries:
 * - top score >= 0.9 → 'likely_duplicate' (compact equality or containment)
 * - top score >= threshold (default 0.6) → 'possible_duplicate'
 * - otherwise → 'no_match'
 */
export type DedupDecision = 'likely_duplicate' | 'possible_duplicate' | 'no_match';

export interface PreCreateCheckResult {
  candidates: SimilarCandidate[];
  decision: DedupDecision;
  /** Set only when the check itself failed (e.g. an index error); the create
   * is never blocked by a failed check. Additive: existing callers ignore it. */
  error?: string;
}

const LIKELY_DUPLICATE_SCORE = 0.9;

export function preCreateCheck(
  title: string,
  type: string,
  entities: Entity[],
  opts: { threshold?: number; limit?: number; includeArchived?: boolean } = {},
): PreCreateCheckResult {
  const threshold = opts.threshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  const candidates = rankSimilar(title, entities, {
    types: [type],
    threshold,
    limit: opts.limit,
    includeArchived: opts.includeArchived,
  });
  const topScore = candidates[0]?.score ?? 0;
  const decision: DedupDecision =
    topScore >= LIKELY_DUPLICATE_SCORE ? 'likely_duplicate' : topScore >= threshold ? 'possible_duplicate' : 'no_match';
  return { candidates, decision };
}
