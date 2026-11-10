import type { EntityDraft } from './types.js';
import type { Route } from './routing.js';

/**
 * Advisory, deterministic create-time classification (Step 10).
 *
 * Strictly advisory: classifyCreate is a pure function with no I/O, no
 * network, and no LLM. It never blocks a create, never mutates the draft,
 * and never changes routing. It only reports what small table-driven rules
 * can infer from the title and metadata so the calling agent can reconsider
 * the entity type or pin collection membership. Semantic/LLM classification
 * (the umm_fast INGEST_CLASS pattern) remains an agent-side practice and is
 * deliberately not implemented server-side.
 *
 * Returns null when nothing is advisory (the create looks confident); the
 * caller then omits the classification key entirely.
 */
export type ClassificationConfidence = 'high' | 'medium' | 'low';

export interface AdvisoryClassification {
  /** Surfaced only when the chosen type is generic ('memory') or plausibly
   * mismatched with the title evidence; omitted when the type looks right. */
  suggested_type?: string;
  /** Collections the entity plausibly belongs to but is not pinned to. */
  suggested_collections?: string[];
  /** Short routing observations; advisory only, never a decision. */
  routing_notes?: string[];
  confidence: ClassificationConfidence;
}

// First match wins. Table-driven, no personal names, no I/O.
const KINSHIP_PATTERN = /\b(mother|father|wife|husband|son|daughter|brother|sister|bratr|sestra|mama|tata|grandmother|grandfather)\b/iu;
const TYPE_HINTS: Array<{ pattern: RegExp; type: string }> = [
  { pattern: /\b(decision|decided|rozhodnutí)\b/iu, type: 'decision' },
  { pattern: KINSHIP_PATTERN, type: 'person' },
  { pattern: /\b(notes?|memo|poznámky|poznámka)\b/iu, type: 'note' },
];

// Matches the family index at People/family/index.md. The person route is
// flat (People/{slug}.md), so family membership must be pinned explicitly
// via metadata.member_of_collections (collection-sync rule B).
const FAMILY_COLLECTION = 'People/family';
const GENERIC_TYPES = new Set(['memory']);

function suggestedType(type: string, title: string): string | undefined {
  const hint = TYPE_HINTS.find(({ pattern }) => pattern.test(title))?.type;
  if (!hint || hint === type) return undefined;
  if (GENERIC_TYPES.has(type)) return hint;
  // Explicit types are only flagged for strong mismatches.
  if (hint === 'person' && type !== 'person') return 'person';
  if (hint === 'decision' && !type.includes('decision')) return 'decision';
  return undefined;
}

export function classifyCreate(draft: EntityDraft, routes: Record<string, Route>): AdvisoryClassification | null {
  const title = String(draft.title ?? '');
  const metadata = draft.metadata ?? {};
  const type = String(draft.type ?? 'memory');

  const suggested_type = suggestedType(type, title);
  const relationHint = typeof metadata.relation === 'string' && KINSHIP_PATTERN.test(metadata.relation);
  const familyHint = KINSHIP_PATTERN.test(title) || metadata.family === true || relationHint;
  const pinned = Array.isArray(metadata.member_of_collections) && metadata.member_of_collections.length > 0;
  const isPerson = type === 'person' || suggested_type === 'person';
  const hasRoute = Object.prototype.hasOwnProperty.call(routes, type);

  const routingNotes: string[] = [];
  if (!hasRoute) {
    routingNotes.push(`type "${type}" has no configured route; it falls back to the "memory" route (${routes.memory?.path ?? 'Memory/{slug}.md'})`);
  }

  const suggestedCollections: string[] = [];
  if (isPerson && familyHint && !pinned) {
    suggestedCollections.push(FAMILY_COLLECTION);
    const personRoute = routes.person?.path ?? 'People/{slug}.md';
    routingNotes.push(`person with family hints routes flat to ${personRoute} without metadata.member_of_collections pinning; consider pinning to ${FAMILY_COLLECTION}`);
  }

  if (!suggested_type && !suggestedCollections.length && !routingNotes.length) return null;

  const corroborated = metadata.family === true && KINSHIP_PATTERN.test(title);
  const confidence: ClassificationConfidence = !hasRoute ? 'low' : corroborated ? 'high' : 'medium';

  return {
    ...(suggested_type ? { suggested_type } : {}),
    ...(suggestedCollections.length ? { suggested_collections: suggestedCollections } : {}),
    ...(routingNotes.length ? { routing_notes: routingNotes } : {}),
    confidence,
  };
}
