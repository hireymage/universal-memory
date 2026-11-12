import type { EntityDraft } from './types.js';
import type { Route } from './routing.js';
import { nearestKnownType } from './entity-types.js';
import { stripAccents } from './similarity.js';

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
 * Patterns are matched on the accent-stripped title with Unicode letter
 * boundaries. JavaScript `\b` is ASCII-only even with the `u` flag, so a
 * word that ends in a diacritic ("Rozhodnutí") never matched `\b...\b`.
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

const KINSHIP_WORDS = [
  'mother', 'father', 'wife', 'husband', 'son', 'daughter', 'brother', 'sister', 'grandmother', 'grandfather',
  'bratr', 'sestra', 'mama', 'tata', 'maminka', 'tatinek', 'tatinka', 'matka', 'otec', 'manzel', 'manzelka',
  'dcera', 'syn', 'babicka', 'deda', 'dedecek', 'stryc', 'teta', 'vnuk', 'vnucka', 'partner', 'partnerka',
];
const KINSHIP_PATTERN = words(KINSHIP_WORDS);
const DECISION_PATTERN = words(['decisions', 'decision', 'decided', 'rozhodnuti']);
const NOTE_PATTERN = words(['poznamky', 'poznamka', 'notes', 'note', 'memo']);
const TASK_PATTERN = words(['to-do', 'todo', 'koupit', 'udelat', 'do patku']);
const PREFERENCE_PATTERN = words(['nemam rada', 'nemam rad', 'mam rada', 'mam rad', 'preferuji', 'prefer']);
const IDEA_PATTERN = words(['napad', 'idea']);
const PERSON_EXTRA_PATTERN = words(['narozeniny', 'birthday']);
const CHECKBOX_PATTERN = /(?:^|\s)[-*+]\s+\[\s\]/;
const DATE_PATTERN = /\d{4}-\d{2}-\d{2}|\d{1,2}\.\s*\d{1,2}\.\s*\d{4}|\d{1,2}\/\d{1,2}\/\d{4}/;
const TIME_PATTERN = /\d{1,2}:\d{2}/;

// First match wins. Table-driven, no personal names, no I/O.
const TYPE_HINTS: Array<{ type: string; test: (stripped: string, original: string) => boolean }> = [
  { type: 'event', test: (stripped) => DATE_PATTERN.test(stripped) && TIME_PATTERN.test(stripped) },
  { type: 'preference', test: (stripped) => PREFERENCE_PATTERN.test(stripped) },
  { type: 'task', test: (stripped, original) => TASK_PATTERN.test(stripped) || CHECKBOX_PATTERN.test(original) },
  { type: 'idea', test: (stripped) => IDEA_PATTERN.test(stripped) },
  { type: 'decision', test: (stripped) => DECISION_PATTERN.test(stripped) },
  { type: 'person', test: (stripped) => KINSHIP_PATTERN.test(stripped) || PERSON_EXTRA_PATTERN.test(stripped) },
  { type: 'note', test: (stripped) => NOTE_PATTERN.test(stripped) },
];

// Matches the family index at People/family/index.md. The person route is
// flat (People/{slug}.md), so family membership must be pinned explicitly
// via metadata.member_of_collections (collection-sync rule B).
const FAMILY_COLLECTION = 'People/family';
const LOOSE_TYPES = new Set(['memory', 'note', 'knowledge', 'inbox']);

function words(list: string[]): RegExp {
  const body = [...list].sort((a, b) => b.length - a.length).join('|');
  return new RegExp(`(?<!\\p{L})(?:${body})(?!\\p{L})`, 'u');
}

function hintFor(title: string): string | undefined {
  const stripped = stripAccents(title);
  return TYPE_HINTS.find(hint => hint.test(stripped, title))?.type;
}

function hasKinship(value: string): boolean {
  return KINSHIP_PATTERN.test(stripAccents(value));
}

function suggestedType(type: string, title: string): string | undefined {
  const hint = hintFor(title);
  if (!hint || hint === type) return undefined;
  if (LOOSE_TYPES.has(type)) return hint;
  // Explicit types are only flagged for strong mismatches.
  if (hint === 'person' && type !== 'person') return 'person';
  if (hint === 'decision' && !type.includes('decision')) return 'decision';
  return undefined;
}

export function classifyCreate(draft: EntityDraft, routes: Record<string, Route>): AdvisoryClassification | null {
  const title = String(draft.title ?? '');
  const metadata = draft.metadata ?? {};
  const type = String(draft.type ?? 'memory');

  let suggested_type = suggestedType(type, title);
  const relation = typeof metadata.relation === 'string' ? metadata.relation : '';
  const relationHint = relation.length > 0 && hasKinship(relation);
  const familyHint = hasKinship(title) || metadata.family === true || relationHint;
  const pinned = Array.isArray(metadata.member_of_collections) && metadata.member_of_collections.length > 0;
  const isPerson = type === 'person' || suggested_type === 'person';
  const hasRoute = Object.prototype.hasOwnProperty.call(routes, type);
  const nearest = hasRoute ? undefined : nearestKnownType(type);
  const nearestUseful = nearest && nearest.type !== type ? nearest : undefined;
  if (!suggested_type && nearestUseful) suggested_type = nearestUseful.type;

  const routingNotes: string[] = [];
  if (!hasRoute) {
    const fallback = routes.memory?.path ?? 'Memory/{slug}.md';
    const nearestNote = nearestUseful
      ? `nearest known type is "${nearestUseful.type}" (${nearestUseful.via}${nearestUseful.via === 'similarity' ? ` ${nearestUseful.score}` : ''}). `
      : '';
    routingNotes.push(`type "${type}" has no configured route; ${nearestNote}it falls back to the "memory" route (${fallback})`);
  }

  const suggestedCollections: string[] = [];
  if (isPerson && familyHint && !pinned) {
    suggestedCollections.push(FAMILY_COLLECTION);
    const personRoute = routes.person?.path ?? 'People/{slug}.md';
    routingNotes.push(`person with family hints routes flat to ${personRoute} without metadata.member_of_collections pinning; consider pinning to ${FAMILY_COLLECTION}`);
  }

  if (!suggested_type && !suggestedCollections.length && !routingNotes.length) return null;

  const corroborated = metadata.family === true && hasKinship(title);
  const confidence: ClassificationConfidence = !hasRoute ? 'low' : corroborated ? 'high' : 'medium';

  return {
    ...(suggested_type ? { suggested_type } : {}),
    ...(suggestedCollections.length ? { suggested_collections: suggestedCollections } : {}),
    ...(routingNotes.length ? { routing_notes: routingNotes } : {}),
    confidence,
  };
}
