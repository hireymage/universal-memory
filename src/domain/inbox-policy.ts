import type { AdvisoryClassification } from './classification.js';
import type { EntityDraft } from './types.js';

/**
 * Numeric reading of the advisory confidence labels.
 * `null` (nothing to advise, the type already looks right) is 1.
 * The default inbox threshold is 0.5, so only `low` (0.3) is parked.
 * `medium` (0.6) and `high` (0.9) stay on the route the caller asked for.
 */
export const CONFIDENCE_SCORE: Record<AdvisoryClassification['confidence'], number> = {
  high: 0.9,
  medium: 0.6,
  low: 0.3,
};

export const DEFAULT_INBOX_CONFIDENCE_THRESHOLD = 0.5;

export function confidenceScore(block: AdvisoryClassification | null | undefined): number {
  if (!block) return 1;
  return CONFIDENCE_SCORE[block.confidence];
}

export interface ParkResult {
  draft: EntityDraft;
  parked: boolean;
  /** Set when the item was stored as inbox because confidence was below the threshold. */
  classification_confidence?: number;
}

/**
 * Below the threshold, store the item as `inbox` and keep the caller's type.
 * `suggested_type` is the classifier hint, or the requested type when there is
 * no hint. The caller's draft is not mutated. An item that is already `inbox`
 * is left on that type; low confidence only adds the two frontmatter fields.
 */
export function parkLowConfidence(
  draft: EntityDraft,
  classification: AdvisoryClassification | null | undefined,
  threshold = DEFAULT_INBOX_CONFIDENCE_THRESHOLD,
): ParkResult {
  const score = confidenceScore(classification);
  if (!(score < threshold)) return { draft, parked: false };
  const suggested = classification?.suggested_type ?? draft.type;
  const metadata: Record<string, unknown> = {
    ...(draft.metadata ?? {}),
    suggested_type: suggested,
    classification_confidence: score,
  };
  if (draft.type === 'inbox') return { draft: { ...draft, metadata }, parked: false, classification_confidence: score };
  metadata.requested_type = draft.type;
  return {
    draft: { ...draft, type: 'inbox', metadata },
    parked: true,
    classification_confidence: score,
  };
}
