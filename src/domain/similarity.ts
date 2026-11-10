import type { Entity } from './types.js';

/**
 * Search-before-create similarity foundation (dedup candidates).
 *
 * Problem: agents create duplicate entities because they do not reliably
 * search before creating. This module provides deterministic, dependency-free
 * similarity scoring so a read-only pre-create check can surface candidates
 * for review. It never merges, never selects, and never writes.
 *
 * Normalization rules (shared by every function here):
 * - Accents are stripped via NFKD + combining-mark removal
 *   ("Nováková" → "novakova").
 * - Everything is lowercased with toLocaleLowerCase().
 * - Compact form: all non-alphanumeric characters removed
 *   ("RTX 2070" → "rtx2070").
 * - Normalized form: non-alphanumeric runs collapse to single spaces.
 *
 * tokenize(value): accent-stripped, lowercase, alphanumeric tokens. Every
 * alphanumeric run is emitted whole AND split into its maximal digit runs and
 * letter runs, so "256GB" yields ["256gb", "256", "gb"] and "M1" yields
 * ["m1", "m", "1"]. Order is preserved; duplicates are removed.
 *
 * similarity(a, b): 0..1, the maximum of:
 * 1. Compact-form equality → 1.0 ("RTX 2070" vs "RTX2070").
 * 2. Compact containment (one compact form contains the other) → 0.9
 *    ("M1-256" ⊂ "macminim1256gb"). Deliberately generous: a short query like
 *    "RTX" surfaces every "RTX…" entity for review, never an auto-pick.
 * 3. Numeric+unit tolerance: 0.6 × token-set Jaccard + 0.4 × numeric overlap,
 *    where numeric overlap is the fraction of the larger digit-run set that
 *    also appears in the other string. This is what makes "M1-256" match
 *    "Mac mini M1 256GB" even without containment, and keeps near-misses like
 *    "256GB" vs "512GB" below the threshold.
 * Empty input → 0.
 *
 * rankSimilar(query, entities, opts): scores the query against each entity's
 * title and every alias (best field wins), filters by type, excludes entities
 * with status "archived" unless includeArchived is set, keeps candidates with
 * score >= threshold (default 0), sorts deterministically (score desc, then
 * title asc), and truncates to limit (default 20).
 */

export const DEFAULT_SIMILARITY_THRESHOLD = 0.6;

export interface SimilarCandidate {
  entity: Entity;
  score: number;
  reason: string;
}

const stripAccents = (value: string): string =>
  value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase();

const compactForm = (value: string): string => stripAccents(value).replace(/[^a-z0-9]/g, '');
const normalizedForm = (value: string): string => stripAccents(value).replace(/[^a-z0-9]+/g, ' ').trim();

export function tokenize(value: string): string[] {
  const tokens: string[] = [];
  for (const run of normalizedForm(value).split(' ')) {
    if (!run) continue;
    tokens.push(run);
    // Mixed alphanumeric runs split into digit and letter runs:
    // "256gb" → "256", "gb"; "m1" → "m", "1".
    tokens.push(...run.match(/\d+/g) ?? [], ...run.match(/[a-z]+/g) ?? []);
  }
  return [...new Set(tokens)];
}

const numericRuns = (value: string): string[] => normalizedForm(value).match(/\d+/g) ?? [];

export function similarity(a: string, b: string): number {
  const compactA = compactForm(a), compactB = compactForm(b);
  if (!compactA || !compactB) return 0;
  if (compactA === compactB) return 1;
  if (compactA.includes(compactB) || compactB.includes(compactA)) return 0.9;
  const tokensA = new Set(tokenize(a)), tokensB = new Set(tokenize(b));
  let intersection = 0;
  for (const token of tokensA) if (tokensB.has(token)) intersection++;
  const union = tokensA.size + tokensB.size - intersection;
  const jaccard = union === 0 ? 0 : intersection / union;
  const runsA = numericRuns(a), runsB = new Set(numericRuns(b));
  const shared = runsA.filter(run => runsB.has(run)).length;
  const largest = Math.max(runsA.length, runsB.size);
  const numeric = largest === 0 ? 0 : shared / largest;
  return Math.min(1, Math.max(0, 0.6 * jaccard + 0.4 * numeric));
}

function matchMechanism(a: string, b: string): string {
  const compactA = compactForm(a), compactB = compactForm(b);
  if (compactA && compactA === compactB) return 'identical compact form';
  if (compactA && compactB && (compactA.includes(compactB) || compactB.includes(compactA))) return 'compact containment';
  return 'token and numeric overlap';
}

function bestFieldMatch(query: string, entity: Entity): { score: number; reason: string } {
  const fields: Array<[string, string]> = [
    ['title', entity.metadata.title],
    ...entity.metadata.aliases.map((alias: string): [string, string] => ['alias', alias]),
  ];
  let best = { score: 0, reason: 'no match' };
  for (const [field, value] of fields) {
    const score = similarity(query, value);
    if (score > best.score) best = { score, reason: `${field} "${value}": ${matchMechanism(query, value)}` };
  }
  return best;
}

export function rankSimilar(
  query: string,
  entities: Entity[],
  opts: { types?: string[]; limit?: number; threshold?: number; includeArchived?: boolean } = {},
): SimilarCandidate[] {
  const threshold = opts.threshold ?? 0;
  const limit = opts.limit ?? 20;
  return entities
    .filter(entity =>
      (!opts.types?.length || opts.types.includes(entity.metadata.type)) &&
      (opts.includeArchived === true || entity.metadata.status !== 'archived'))
    .map(entity => ({ entity, ...bestFieldMatch(query, entity) }))
    .filter(candidate => candidate.score > 0 && candidate.score >= threshold)
    .sort((a, b) => b.score - a.score || a.entity.metadata.title.localeCompare(b.entity.metadata.title))
    .slice(0, limit);
}
