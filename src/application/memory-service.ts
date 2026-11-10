import { ulid } from 'ulid';
import type { AuditSink, EntityStorage, SearchIndex } from '../ports/index.js';
import type { Entity, EntityDraft, EntityPatch, RetrievedRelation, SearchQuery } from '../domain/types.js';
import { MemoryError } from '../domain/errors.js';
import { assertPatchAllowed } from '../domain/model.js';
import { preCreateCheck, type PreCreateCheckResult } from '../domain/dedup-check.js';
import { syncCollectionIndexes, type SyncStorage } from '../domain/collection-sync.js';
import { classifyCreate, type AdvisoryClassification } from '../domain/classification.js';
import type { Route } from '../domain/routing.js';

export class MemoryService {
  constructor(private readonly storage: EntityStorage, private readonly index: SearchIndex, private readonly audit: AuditSink, private readonly routes: Record<string, Route> = {}) {}

  async create(draft: EntityDraft, client?: string): Promise<Entity> {
    // Same guardrail as update: graph-managed keys may enter only through the
    // validating, audited graph API, never through a generic entity create.
    assertPatchAllowed({ metadata: draft.metadata });
    const entity = await this.storage.create(draft);
    await this.record('create', undefined, entity, client);
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
  async createWithDedup(draft: EntityDraft, client?: string): Promise<{ entity: Entity; dedup: PreCreateCheckResult; classification?: AdvisoryClassification }> {
    let dedup: PreCreateCheckResult;
    try {
      dedup = preCreateCheck(draft.title, draft.type, await this.dedupPool(draft.type, draft.title), { limit: 5 });
    } catch {
      dedup = { candidates: [], decision: 'no_match', error: 'dedup_check_failed' };
    }
    let classification: AdvisoryClassification | undefined;
    try {
      classification = classifyCreate(draft, this.routes) ?? undefined;
    } catch {
      // Advisory only: a classification failure never blocks the create.
      classification = undefined;
    }
    const entity = await this.create(draft, client);
    return { entity, dedup, ...(classification ? { classification } : {}) };
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
    const indexed = await this.index.search(query);
    if (indexed.length) return indexed;
    // The RAM index is an optimisation only. A cold/rebuilding/failed index
    // must never be authoritative for a negative answer.
    const direct: Entity[] = [];
    for await (const entity of this.storage.scan()) if (matchesSource(entity, query)) direct.push(entity);
    return direct
      .sort((a, b) => sourceRank(b, query.query) - sourceRank(a, query.query) || b.metadata.updated_at.localeCompare(a.metadata.updated_at))
      .slice(0, Math.min(query.limit ?? 20, 200));
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

  async update(id: string, patch: EntityPatch, expectedRevision: string, client?: string): Promise<Entity> {
    assertPatchAllowed(patch);
    const before = await this.get(id);
    const after = await this.storage.update(id, patch, expectedRevision);
    await this.record('update', before, after, client);
    return after;
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