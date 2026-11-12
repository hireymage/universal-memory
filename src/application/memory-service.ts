import { ulid } from 'ulid';
import type { UsageStore } from '../adapters/audit/usage-store.js';
import type { AuditSink, EntityStorage, SearchIndex } from '../ports/index.js';
import type { Entity, EntityDraft, EntityPatch, RetrievedRelation, SearchQuery } from '../domain/types.js';
import { MemoryError } from '../domain/errors.js';
import { assertPatchAllowed } from '../domain/model.js';
import { preCreateCheck, type PreCreateCheckResult } from '../domain/dedup-check.js';
import { syncCollectionIndexes, type SyncStorage } from '../domain/collection-sync.js';
import { classifyCreate, type AdvisoryClassification } from '../domain/classification.js';
import type { Route } from '../domain/routing.js';
import { DEFAULT_INBOX_CONFIDENCE_THRESHOLD, parkLowConfidence } from '../domain/inbox-policy.js';
import { compareSchedule, combinedRank, DEFAULT_RANKING, recencyScore, saturatingScore, scheduleOf, type RankingConfig } from '../domain/ranking.js';
import { todayInPrague } from '../domain/name-days.js';
import { normalizeDraft, normalizePatch, VECTOR_DUPLICATE_SCORE, writeWarnings, type DuplicateHint, type NormalizationChange, type WriteWarning } from '../domain/write-guard.js';

export interface VectorHit {
  id: string;
  score: number;
}

export interface MemoryOptions {
  inboxThreshold?: number;
  ranking?: RankingConfig;
  usage?: UsageStore;
  /** Vector near-duplicates. Failures are ignored; a missing sidecar changes nothing. */
  vectors?: (text: string) => Promise<VectorHit[]>;
}

export interface WriteMeta {
  warnings: WriteWarning[];
  normalized: NormalizationChange[];
  parked_in_inbox?: true;
}

export class MemoryService {
  private readonly inboxThreshold: number;
  private readonly ranking: RankingConfig;
  private readonly usage?: UsageStore;
  private readonly vectors?: (text: string) => Promise<VectorHit[]>;

  constructor(
    private readonly storage: EntityStorage,
    private readonly index: SearchIndex,
    private readonly audit: AuditSink,
    private readonly routes: Record<string, Route> = {},
    options: MemoryOptions = {},
  ) {
    this.inboxThreshold = options.inboxThreshold ?? DEFAULT_INBOX_CONFIDENCE_THRESHOLD;
    this.ranking = options.ranking ?? DEFAULT_RANKING;
    this.usage = options.usage;
    this.vectors = options.vectors;
  }

  async create(draft: EntityDraft, client?: string, details?: Record<string, unknown>): Promise<Entity> {
    // Same guardrail as update: graph-managed keys may enter only through the
    // validating, audited graph API, never through a generic entity create.
    assertPatchAllowed({ metadata: draft.metadata });
    const entity = await this.storage.create(draft);
    await this.record('create', undefined, entity, client, details);
    await syncCollectionIndexes(this.storage as unknown as SyncStorage, entity);
    return entity;
  }
  /**
   * Create plus a read-only pre-create duplicate check. Shared threshold
   * constants: 0.6 (DEFAULT_SIMILARITY_THRESHOLD in similarity.ts) — candidates
   * are returned whenever the top score >= 0.6 — and 0.9 (LIKELY_DUPLICATE_SCORE
   * in dedup-check.ts) for the 'likely_duplicate' decision. Server policy is
   * non-blocking: the check never prevents the create; the calling agent decides
   * whether to link, update, or merge. A failed check degrades to
   * { candidates: [], decision: 'no_match', error: 'dedup_check_failed' }.
   *
   * Additive advisory classification (Step 10): a deterministic, pure-function
   * classification block is computed alongside the dedup check. It is advisory
   * only — it never blocks the create, never mutates the draft, and never
   * changes routing. Any failure inside classification degrades to the key
   * being omitted entirely.
   */
  async createWithDedup(draft: EntityDraft, client?: string): Promise<{ entity: Entity; dedup: PreCreateCheckResult; classification?: AdvisoryClassification } & WriteMeta> {
    const normalized = normalizeDraft(draft);
    let classification: AdvisoryClassification | undefined;
    try {
      classification = classifyCreate(normalized.draft, this.routes) ?? undefined;
    } catch {
      // Advisory only: a classification failure never blocks the create and does not park the item.
      classification = undefined;
    }
    const parked = classification
      ? parkLowConfidence(normalized.draft, classification, this.inboxThreshold)
      : { draft: normalized.draft, parked: false as const };
    let dedup: PreCreateCheckResult;
    try {
      // Compare against the type the caller asked for, before an inbox park, so a near-duplicate note is still reported.
      dedup = preCreateCheck(normalized.draft.title, normalized.draft.type, await this.dedupPool(normalized.draft.type, normalized.draft.title), { limit: 5 });
    } catch {
      dedup = { candidates: [], decision: 'no_match', error: 'dedup_check_failed' };
    }
    const duplicates = await this.duplicateHints(normalized.draft.title, dedup);
    const warnings = writeWarnings({
      type: parked.draft.type,
      title: parked.draft.title,
      content: parked.draft.content ?? '',
      metadata: parked.draft.metadata ?? {},
      duplicates,
      conflicts: normalized.conflicts,
    });
    if (parked.parked && normalized.draft.type !== parked.draft.type) {
      // The file is inbox, but required and date errors still follow the type the caller asked for.
      for (const warning of writeWarnings({
        type: normalized.draft.type,
        title: normalized.draft.title,
        content: normalized.draft.content ?? '',
        metadata: normalized.draft.metadata ?? {},
      })) {
        if (warning.code === 'MISSING_FRONTMATTER' || warning.code === 'INVALID_DATE') warnings.push(warning);
      }
    }
    const details: Record<string, unknown> = {};
    if (normalized.changes.length) details.normalized = normalized.changes;
    if (parked.parked) {
      details.parked_in_inbox = true;
      details.requested_type = draft.type;
      details.classification_confidence = parked.classification_confidence;
    }
    const entity = await this.create(parked.draft, client, Object.keys(details).length ? details : undefined);
    return {
      entity,
      dedup,
      ...(classification ? { classification } : {}),
      warnings,
      normalized: normalized.changes,
      ...(parked.parked ? { parked_in_inbox: true as const } : {}),
    };
  }
  /** Candidate pool for the dedup check: same-type entities ranked against the
   * title via the existing search path (index plus storage.scan fallback). */
  private async dedupPool(type: string, title: string): Promise<Entity[]> {
    return this.search({ types: [type], query: title, limit: 20 });
  }
  async get(id: string): Promise<Entity> {
    const entity = await this.storage.get(id);
    if (!entity) throw new MemoryError('NOT_FOUND', `Entity not found: ${id}`);
    return entity;
  }
  async search(query: SearchQuery): Promise<Entity[]> {
    const cap = Math.min(query.limit ?? 20, 200);
    const indexed = await this.index.search({ query: query.query, types: query.types, status: query.status, tags: query.tags, limit: cap });
    const rows = indexed.length ? indexed : await this.scanFallback(query, cap);
    return this.rankRows(rows, query);
  }

  /**
   * The stable, category-independent read path for a memory question. It never
   * interprets or answers natural language: it returns the full source entities
   * found by the local index plus deterministic graph evidence.
   */
  async retrieveContext(input: { query: string; subject_id?: string; limit?: number; related_limit?: number }): Promise<{ query: string; subject?: Entity; matches: Entity[]; related: RetrievedRelation[] }> {
    const limit = input.limit ?? 6, relatedLimit = input.related_limit ?? 0;
    const primary = new Map<string, Entity>();
    let subject: Entity | undefined;
    if (input.subject_id) {
      subject = await this.get(input.subject_id);
      primary.set(subject.metadata.id, subject);
    }
    for (const entity of await this.search({ query: input.query, limit }))
      if (!primary.has(entity.metadata.id)) primary.set(entity.metadata.id, entity);
    const related = new Map<string, RetrievedRelation>();
    for (const source of primary.values()) {
      for (const relation of await this.related(source.metadata.id, relatedLimit)) {
        if (primary.has(relation.entity.metadata.id) || related.has(relation.entity.metadata.id)) continue;
        related.set(relation.entity.metadata.id, { source_id: source.metadata.id, entity: relation.entity, reason: relation.reason });
        if (related.size >= relatedLimit) break;
      }
      if (related.size >= relatedLimit) break;
    }
    return {
      query: input.query,
      ...(subject ? { subject } : {}),
      matches: [...primary.values()].slice(subject ? 1 : 0, subject ? limit : limit),
      related: [...related.values()],
    };
  }

  /** Compact retrieval for agent runtimes. It reports deterministic search evidence,
   * not an LLM-generated English summary or a decision that memory is relevant. */
  async retrieveRelevant(input: { query: string; limit?: number }): Promise<unknown[]> {
    const matches = await this.search({ query: input.query, limit: input.limit ?? 6 });
    return matches.map((entity, index) => {
      const declared = typeof entity.metadata.summary_en === 'string' ? entity.metadata.summary_en : undefined;
      const fallback = entity.content.replace(/\s+/g, ' ').trim().slice(0, 420);
      return {
        memory_id: entity.metadata.id, type: entity.metadata.type,
        relevance: Number((1 - (index / Math.max(matches.length, 1)) * 0.35).toFixed(2)),
        summary_en: declared, summary: declared ?? fallback, summary_language: declared ? 'en' : 'source',
        source: { path: entity.path, title: entity.metadata.title }, updated_at: entity.metadata.updated_at,
      };
    });
  }

  async update(id: string, patch: EntityPatch, expectedRevision: string, client?: string): Promise<Entity & WriteMeta> {
    const normalized = normalizePatch(patch);
    assertPatchAllowed(normalized.patch);
    const before = await this.get(id);
    const after = await this.storage.update(id, normalized.patch, expectedRevision);
    const warnings = writeWarnings({
      type: after.metadata.type,
      title: after.metadata.title,
      content: after.content,
      metadata: after.metadata,
      duplicates: await this.updateDuplicates(after),
      conflicts: normalized.conflicts,
    });
    const details: Record<string, unknown> = { ...(rerouteDetails(before, after) ?? {}) };
    if (normalized.changes.length) details.normalized = normalized.changes;
    // A type change re-routes the file inside storage.update. That move is
    // explicit (the caller passed expected_revision) and is recorded on the
    // audit event, not only in the before/after snapshots.
    await this.record('update', before, after, client, Object.keys(details).length ? details : undefined);
    return { ...after, warnings, normalized: normalized.changes };
  }
  async move(id: string, destination: string, expectedRevision: string, client?: string): Promise<Entity> {
    const before = await this.get(id);
    const after = await this.storage.move(id, destination, expectedRevision);
    await this.record('move', before, after, client);
    return after;
  }
  async adopt(path: string, draft: EntityDraft, expectedRevision: string, client?: string): Promise<Entity> {
    const after = await this.storage.adopt(path, draft, expectedRevision);
    await this.record('adopt', undefined, after, client);
    return after;
  }
  async archive(id: string, expectedRevision: string, client?: string): Promise<Entity> {
    const before = await this.get(id);
    const after = await this.storage.archive(id, expectedRevision);
    await this.record('archive', before, after, client);
    return after;
  }
  /** Audited physical delete — used only by migration rollback (Phase-3C §27):
   * the maintenance 'delete' changeset kind restricts it to migration-created
   * source entities, so no generic tool can call it. */
  async delete(id: string, client?: string): Promise<Entity> {
    const before = await this.get(id);
    await this.storage.remove(before.metadata.id);
    await this.record('delete', before, undefined, client, { physical_delete: true });
    return before;
  }
  async link(sourceId: string, targetId: string, relation: string, expectedRevision: string, client?: string): Promise<Entity> {
    const source = await this.get(sourceId);
    const target = await this.get(targetId);
    const relations = Array.isArray(source.metadata.relationships) ? source.metadata.relationships : [];
    return this.update(sourceId, {
      content: `${source.content.trimEnd()}\n\n[[${target.metadata.title}]]\n`,
      metadata: { relationships: [...relations, { type: relation, target_id: targetId }] },
    }, expectedRevision, client);
  }
  async related(id: string, limit = 20): Promise<Array<{ entity: Entity; reason: string }>> {
    const source = await this.get(id);
    const result = new Map<string, { entity: Entity; reason: string }>();
    for (const entity of await this.index.backlinks(source.metadata.title))
      if (entity.metadata.id !== id) result.set(entity.metadata.id, { entity, reason: 'backlink' });
    for (const link of source.wikilinks)
      for (const entity of await this.index.search({ query: link, limit: 5 }))
        if (entity.metadata.id !== id) result.set(entity.metadata.id, { entity, reason: 'wikilink' });
    if (source.metadata.tags.length)
      for (const entity of await this.index.search({ tags: source.metadata.tags, limit }))
        if (entity.metadata.id !== id && !result.has(entity.metadata.id)) result.set(entity.metadata.id, { entity, reason: 'shared_tags' });
    return [...result.values()].slice(0, limit);
  }
  /** Likely duplicates of an entity that already exists, excluding itself. A failed lookup adds no warning. */
  private async updateDuplicates(entity: Entity): Promise<DuplicateHint[]> {
    try {
      const pool = (await this.dedupPool(entity.metadata.type, entity.metadata.title)).filter(candidate => candidate.metadata.id !== entity.metadata.id);
      const dedup = preCreateCheck(entity.metadata.title, entity.metadata.type, pool, { limit: 5 });
      return (await this.duplicateHints(entity.metadata.title, dedup)).filter(hint => hint.id !== entity.metadata.id);
    } catch {
      return [];
    }
  }

  private async duplicateHints(title: string, dedup: PreCreateCheckResult): Promise<DuplicateHint[]> {
    const hints: DuplicateHint[] = dedup.candidates.map(candidate => ({
      id: candidate.entity.metadata.id,
      score: candidate.score,
      via: 'title' as const,
    }));
    if (!this.vectors || !title.trim()) return hints;
    try {
      for (const hit of await this.vectors(title)) {
        if (hit.score >= VECTOR_DUPLICATE_SCORE) hints.push({ id: hit.id, score: hit.score, via: 'vector' });
      }
    } catch {
      // Vector similarity is advisory. A sidecar failure must not block the write.
    }
    return hints;
  }

  private async scanFallback(query: SearchQuery, cap: number): Promise<Entity[]> {
    // The RAM index is an optimisation only. A cold/rebuilding/failed index
    // must never be authoritative for a negative answer.
    const direct: Entity[] = [];
    for await (const entity of this.storage.scan()) if (matchesSource(entity, query)) direct.push(entity);
    return direct
      .sort((a, b) => sourceRank(b, query.query) - sourceRank(a, query.query) || b.metadata.updated_at.localeCompare(a.metadata.updated_at))
      .slice(0, cap);
  }

  private async rankRows(rows: Entity[], query: SearchQuery): Promise<Entity[]> {
    if (rows.length < 2) return rows;
    const now = new Date();
    const today = todayInPrague(now);
    const usage = await this.usage?.countsFor(rows.map(entity => entity.metadata.id)) ?? new Map<string, number>();
    const scored = await Promise.all(rows.map(async (entity, index) => {
      const links = await relationCount(this.index, entity);
      const match = query.query?.trim()
        ? Number((1 - (index / Math.max(rows.length, 1)) * 0.5).toFixed(4))
        : 0;
      const score = combinedRank({
        match,
        recency: recencyScore(entity.metadata.updated_at, now, this.ranking.half_life_days),
        links: saturatingScore(links),
        usage: saturatingScore(usage.get(entity.metadata.id) ?? 0),
      }, this.ranking.weights);
      return { entity, score };
    }));
    scored.sort((a, b) => {
      if (query.order === 'due') {
        const byDate = compareSchedule(scheduleOf(a.entity, today), scheduleOf(b.entity, today));
        if (byDate) return byDate;
      }
      return b.score - a.score || b.entity.metadata.updated_at.localeCompare(a.entity.metadata.updated_at) || a.entity.metadata.title.localeCompare(b.entity.metadata.title, 'cs');
    });
    return scored.map(item => item.entity);
  }

  private async record(operation: string, before: Entity | undefined, after: Entity | undefined, client?: string, details?: Record<string, unknown>): Promise<void> {
    const id = ulid();
    await this.audit.append({
      id, timestamp: new Date().toISOString(), operation, entity_id: (after ?? before)?.metadata.id, client,
      before_revision: before?.revision, after_revision: after?.revision,
      before_snapshot: before ? `${id}-before.json` : undefined, after_snapshot: after ? `${id}-after.json` : undefined,
      ...(details ? { details } : {}),
    }, before, after);
  }
}

const sourceNormalize = (value: string): string => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const sourceStopWords = new Set(['informace', 'potrebuji', 'potreboval', 'chci', 'prosim', 'najdi', 'hledej', 'neco', 'vse', 'vsechno', 'ohledne', 'kolik', 'mam', 'ma', 'mas', 'mame', 'mate', 'jsou', 'je', 'jak', 'kdy', 'kdo', 'co', 'ktery', 'kterou', 'kterem', 'mi', 'me', 'moje', 'muj', 'moji', 'nase', 'about', 'find', 'show', 'tell', 'what', 'when', 'who', 'how', 'the', 'and']);
const sourceRelationshipTerms: Record<string, string[]> = { dite: ['deti', 'syn', 'dcera', 'child', 'children'], deti: ['dite', 'syn', 'dcera', 'child', 'children'], children: ['child', 'deti', 'syn', 'dcera'], child: ['children', 'dite', 'deti', 'syn', 'dcera'] };
function rerouteDetails(before: Entity, after: Entity): Record<string, unknown> | undefined {
  if (before.metadata.type === after.metadata.type && before.path === after.path) return undefined;
  return {
    rerouted: before.path !== after.path,
    from_type: before.metadata.type,
    to_type: after.metadata.type,
    from_path: before.path,
    to_path: after.path,
  };
}

async function relationCount(index: SearchIndex, entity: Entity): Promise<number> {
  const [outgoing, incoming] = await Promise.all([
    index.edgesFrom(entity.metadata.id),
    index.edgesTo(entity.metadata.id),
  ]);
  return entity.wikilinks.length + outgoing.length + incoming.length;
}

function sourceTokens(query?: string): string[] {
  const tokens = sourceNormalize(query ?? '').split(/\s+/).filter(token => token.length >= 2 && !sourceStopWords.has(token));
  return [...new Set(tokens.flatMap(token => [token, ...(sourceRelationshipTerms[token] ?? [])]))];
}
function matchesSource(entity: Entity, query: SearchQuery): boolean {
  if (query.types?.length && !query.types.includes(entity.metadata.type)) return false;
  if (query.status && query.status !== entity.metadata.status) return false;
  if (query.tags?.length && !query.tags.every(tag => entity.metadata.tags.includes(tag))) return false;
  const phrase = sourceNormalize(query.query ?? '');
  if (!phrase) return true;
  const haystack = sourceNormalize([entity.metadata.title, ...entity.metadata.aliases, entity.path, entity.content].join('\n'));
  return haystack.includes(phrase) || sourceTokens(query.query).some(token => haystack.includes(token));
}
function sourceRank(entity: Entity, query?: string): number {
  const phrase = sourceNormalize(query ?? ''), tokens = sourceTokens(query), title = sourceNormalize(entity.metadata.title), content = sourceNormalize(entity.content);
  let score = title === phrase ? 2000 : title.includes(phrase) ? 1000 : 0;
  for (const token of tokens) {
    if (title === token) score += 500;
    else if (title.includes(token)) score += 250;
    if (content.includes(token)) score += 5;
  }
  return score;
}