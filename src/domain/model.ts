import { createHash } from 'node:crypto';
import type { Claim, EntityMetadata, Relation } from './types.js';
import { MemoryError } from './errors.js';
import { escapeRegExp, wikilinkAlias, wikilinkTarget } from './path-safety.js';

/**
 * Deterministic id for a legacy `relationships` entry ({type, target_id} with
 * no id of its own). Derived from (source, type, target) so the same legacy
 * edge always gets the same id without rewriting any file. When the edge is
 * later rewritten through the relation API it collapses into a real ULID.
 */
export const legacyRelationId = (sourceId: string, type: string, targetId: string): string =>
  `legacy-${createHash('sha256').update(`${sourceId}|${type}|${targetId}`).digest('hex').slice(0, 12)}`;

/**
 * Date-tolerant ISO coercion: frontmatter dates can arrive as `Date` objects
 * (an asymmetric YAML round trip), which must never become `''` or
 * `String(Date)` when a claim or relation is rewritten.
 */
const asIsoOrEmpty = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : (typeof value === 'string' && value ? value : '');

/**
 * Read a normalized relation list from entity metadata, combining the new
 * `relations` frontmatter key with the legacy write-only `relationships`
 * key. Files are never rewritten by this function — legacy entries carry a
 * derived synthetic id. Structured `relations` entries win over a legacy
 * duplicate with the same (type, target_id) identity.
 */
export function normalizeRelations(metadata: EntityMetadata | Record<string, unknown>, sourceId: string): Relation[] {
  const byKey = new Map<string, Relation>();
  const legacy = metadata.relationships;
  if (Array.isArray(legacy)) {
    for (const raw of legacy) {
      const entry = raw as { type?: unknown; target_id?: unknown };
      if (typeof entry?.type !== 'string' || typeof entry?.target_id !== 'string') continue;
      if (!entry.type || !entry.target_id) continue;
      byKey.set(`${entry.type}|${entry.target_id}`, {
        id: legacyRelationId(sourceId, entry.type, entry.target_id),
        type: entry.type,
        target_id: entry.target_id,
        created_at: asIsoOrEmpty(metadata.created_at),
        updated_at: '',
      });
    }
  }
  const relations = metadata.relations;
  if (Array.isArray(relations)) {
    for (const raw of relations) {
      const entry = raw as Partial<Relation>;
      if (typeof entry?.id !== 'string' || typeof entry?.type !== 'string' || typeof entry?.target_id !== 'string') continue;
      byKey.set(`${entry.type}|${entry.target_id}`, {
        id: entry.id,
        type: entry.type,
        target_id: entry.target_id,
        created_at: asIsoOrEmpty(entry.created_at),
        updated_at: asIsoOrEmpty(entry.updated_at),
      });
    }
  }
  return [...byKey.values()];
}

/**
 * The one authoritative Claim id rule, shared by every path that writes,
 * reads, or validates a structured claim (graph-service creation/validation,
 * markdown parsing in normalizeClaims). Before Phase 3B the two paths defined
 * separate regexes (write-side 4–32 chars, read-side 6–64 chars), so an id of
 * 4–5 characters could be written and then silently dropped on read.
 * Unified rule: [A-Za-z0-9] first, then [A-Za-z0-9_-], 4–64 chars — every id
 * the write path ever accepted still passes (ULID: 26 chars; migration
 * `p3c-…`: 24 chars), and every id it accepts is readable again.
 */
export const CLAIM_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{3,63}$/;

/**
 * Read structured claims from entity metadata. Malformed entries are skipped
 * rather than failing the whole file read, so a damaged claim line can never
 * make an entity unreadable.
 */
export function normalizeClaims(metadata: EntityMetadata | Record<string, unknown>): Claim[] {
  const claims = metadata.claims;
  if (!Array.isArray(claims)) return [];
  const result: Claim[] = [];
  for (const raw of claims) {
    const entry = raw as Partial<Claim>;
    if (typeof entry?.id !== 'string' || !CLAIM_ID.test(entry.id)) continue;
    if (typeof entry?.predicate !== 'string' || !entry.predicate) continue;
    result.push({
      id: entry.id,
      predicate: entry.predicate,
      value: entry.value,
      source_ids: Array.isArray(entry.source_ids) ? entry.source_ids.map(String) : [],
      ...(entry.confidence === undefined ? {} : { confidence: Number(entry.confidence) }),
      valid_from: asIsoOrEmpty(entry.valid_from),
      valid_to: entry.valid_to === null || entry.valid_to === undefined ? null : asIsoOrEmpty(entry.valid_to) || String(entry.valid_to),
      ...(entry.status === undefined ? {} : { status: entry.status }),
      // Correction provenance survives the round trip: an erroneous claim is
      // never rewritten or dropped, only marked and linked to its correction.
      ...(entry.corrected_by === undefined ? {} : { corrected_by: String(entry.corrected_by) }),
      ...(entry.error_reason === undefined ? {} : { error_reason: String(entry.error_reason) }),
      ...(entry.corrected_at === undefined ? {} : { corrected_at: asIsoOrEmpty(entry.corrected_at) }),
      ...(entry.corrects === undefined ? {} : { corrects: String(entry.corrects) }),
      created_at: asIsoOrEmpty(entry.created_at),
      updated_at: asIsoOrEmpty(entry.updated_at),
    });
  }
  return result;
}

/**
 * Claim identity: same predicate and same open validity window on one entity.
 * Used for idempotent create and for merge dedup.
 */
export const claimKey = (claim: Pick<Claim, 'predicate' | 'value' | 'valid_to'>): string =>
  JSON.stringify([claim.predicate, claim.value === undefined ? null : claim.value, claim.valid_to]);

/**
 * Guardrail: the reserved graph keys must not be writable through the generic
 * entity patch — they have dedicated, validating, audited APIs. The legacy
 * `relationships` key stays writable to keep old clients working.
 */
export const RESERVED_METADATA_KEYS = ['relations', 'claims'] as const;

export function assertPatchAllowed(patch: { metadata?: Record<string, unknown> } | undefined): void {
  if (!patch?.metadata) return;
  for (const key of RESERVED_METADATA_KEYS) {
    if (key in patch.metadata) {
      throw new MemoryError('VALIDATION_ERROR',
        `'metadata.${key}' is managed by the graph API (create_relation/create_claim); it cannot be set through a generic entity update`);
    }
  }
}

/** Structured relation entries already present in frontmatter (`relations` key). */
export function structuredRelations(metadata: EntityMetadata | Record<string, unknown>): Relation[] {
  const relations = metadata.relations;
  if (!Array.isArray(relations)) return [];
  const result: Relation[] = [];
  for (const raw of relations) {
    const entry = raw as Partial<Relation>;
    if (typeof entry?.id !== 'string' || typeof entry?.type !== 'string' || typeof entry?.target_id !== 'string') continue;
    result.push({
      id: entry.id,
      type: entry.type,
      target_id: entry.target_id,
      created_at: asIsoOrEmpty(entry.created_at),
      updated_at: asIsoOrEmpty(entry.updated_at),
    });
  }
  return result;
}

const RELATIONS_HEADING = '## Relations';

/**
 * Body representation of a structured relation, as chosen by the author:
 * a `## Relations` (Obsidian) section holding one bullet per relation with an
 * HTML-comment marker (`<!-- rel:ID -->`) that Obsidian renders as nothing.
 */
export function relationBulletLine(target: { title: string; path: string }, relationId: string): string {
  // Obsidian resolves a link by file name, so link the basename and show the title as alias text.
  const parts = target.path.replace(/\.md$/, '').split('/');
  const name = parts[parts.length - 1] ?? '';
  // Folder notes are all called index.md; qualify them with the folder so the link is unambiguous.
  const rawLink = name === 'index' && parts.length > 1 ? `${parts[parts.length - 2]}/index` : name;
  const link = wikilinkTarget(rawLink) || 'note';
  const title = wikilinkAlias(target.title) || link;
  const marker = relationId.replace(/[^\w-]/g, '');
  return `- [[${link}|${title}]] <!-- rel:${marker} -->`;
}

export function appendRelationLine(content: string, target: { title: string; path: string }, relationId: string): string {
  const line = relationBulletLine(target, relationId);
  const heading = content.match(/^#{2,6}\s*Relations\s*$/m);
  if (heading?.index !== undefined) {
    const at = heading.index + heading[0]!.length;
    return `${content.slice(0, at)}\n${line}${content.slice(at)}`;
  }
  return `${content.trimEnd()}\n\n${RELATIONS_HEADING}\n\n${line}\n`;
}

/** Remove every body line carrying the relation's marker; other wikilinks stay untouched. */
export function removeRelationLines(content: string, relationId: string): { content: string; removed: number } {
  const pattern = new RegExp(`^[^\\n]*<!--\\s*rel:${escapeRegExp(relationId)}\\s*-->[^\\n]*\\n?`, 'gm');
  const matched = content.match(pattern) ?? [];
  return { content: content.replace(pattern, ''), removed: matched.length };
}

/** Identity of a relation: (source entity, type, target entity). */
export const relationIdentity = (relation: { type: string; target_id: string }): string => `${relation.type}|${relation.target_id}`;
const RELATION_BULLET = /^- \[\[([^\]\n]*)\]\] <!-- rel:([A-Za-z0-9-]+) -->$/gm;

/**
 * Rewrites legacy relation bullets (`- [[Title]] <!-- rel:ID -->`) to the
 * basename-alias form. Only lines carrying a relation marker are touched.
 * `targets` maps relation id -> current target {title, path}; markers without
 * a known target are reported in `unresolved` and left unchanged.
 */
export function rewriteRelationBullets(
  content: string,
  targets: Map<string, { title: string; path: string }>,
): { content: string; changed: number; unresolved: string[] } {
  let changed = 0;
  const unresolved: string[] = [];
  const next = content.replace(RELATION_BULLET, (line, _link: string, relationId: string) => {
    const target = targets.get(relationId);
    if (!target) {
      unresolved.push(relationId);
      return line;
    }
    const rewritten = relationBulletLine(target, relationId);
    if (rewritten === line) return line;
    changed += 1;
    return rewritten;
  });
  return { content: next, changed, unresolved };
}
