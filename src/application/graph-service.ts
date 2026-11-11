import { ulid } from 'ulid';
import type { AuditSink, EntityStorage, ResolveMatch, SearchIndex } from '../ports/index.js';
import type { Claim, Entity, EntityMetadata, Relation, RelationEdge } from '../domain/types.js';
import { MemoryError } from '../domain/errors.js';
import { normalizeRelationSpecs, type RelationSpec } from '../domain/relation-batch.js';
import { MemoryService } from './memory-service.js';
import {
  appendRelationLine,
  claimKey,
  CLAIM_ID,
  normalizeClaims,
  normalizeRelations,
  relationIdentity,
  removeRelationLines,
  structuredRelations,
} from '../domain/model.js';

const today = (): string => new Date().toISOString().slice(0, 10);
/** A claim counts as current while its validity window is open and no close status is set. 'superseded', 'invalidated' and 'recorded_in_error' are all non-current by this check. */
const claimIsCurrent = (claim: Claim): boolean =>
  claim.valid_to === null && (claim.status === undefined || claim.status === 'current' || claim.status === 'disputed');
const RESOLVE_CONFIDENCE: Record<ResolveMatch, number> = { id: 1, exact: 1, path: 0.9, normalized: 0.9, compact: 0.8 };
/** Lower sorts first — the strongest match kind wins when one entity matches several forms. */
const MATCH_ORDER: Record<ResolveMatch, number> = { id: 0, exact: 1, path: 2, normalized: 3, compact: 4 };
/**
 * Claim ids for migration batches — deterministic, same form as relation ids.
 * The regex itself lives in domain/model.ts as the single shared CLAIM_ID rule
 * (used identically by the read path); this file no longer defines its own.
 */

export interface ResolveInput {
  query: string;
  /** Optional caller-owned hint that one of the candidates is the intended entity. Reported back as `hint_valid`; never selects on its own. */
  hint_id?: string;
  types?: string[];
  /**
   * Include archived entities (merge stubs, retired records) as candidates.
   * Default false: an archived duplicate is invisible to normal resolution, so
   * `resolve_entity("Jan Novák")` reports the single canonical person instead
   * of an ambiguous pair. Callers that audit merges or rollbacks opt in.
   */
  include_archived?: boolean;
}

export interface CreateRelationInput {
  entity_id: string;
  relation_type: string;
  target_id: string;
  expected_revision: string;
  /**
   * Migration only: deterministic relation id (e.g. `p3r-…`) so a batch can be
   * rolled back and re-applied byte-identically. Ids derived from identity,
   * never generated from a wall clock. `legacy-` ids stay reserved for the shim.
   */
  relation_id?: string;
  /** Migration only: pinned ISO timestamp for created_at/updated_at + entity updated_at, instead of the wall clock. */
  timestamp?: string;
}

export interface BuildRelationsInput {
  entity_id: string;
  /** Batch of edge specs; validated and trimmed by normalizeRelationSpecs (domain/relation-batch.ts). */
  relations: RelationSpec[];
  /**
   * Pre-flight mode: validate and resolve ALL specs first. If ANY spec is
   * invalid, unresolvable, ambiguous, or self-referential, throw VALIDATION_ERROR
   * listing every offending spec and write NOTHING. Note: a mid-batch CONFLICT
   * (the source entity changed between pre-flight and execution) is still
   * possible after pre-flight and is reported as a per-edge 'failed' result —
   * rollback of a partially applied batch is out of scope for this increment.
   */
  all_or_nothing?: boolean;
  client?: string;
}

export type RelationBatchStatus = 'created' | 'skipped_existing' | 'skipped_ambiguous' | 'skipped_not_found' | 'skipped_self_relation' | 'failed';

export interface QueryRelationsInput {
  entity_id?: string;
  relation_type?: string;
  target_id?: string;
  direction?: 'outgoing' | 'incoming' | 'both';
  depth?: number;
  limit?: number;
}

export interface CreateClaimInput {
  predicate: string;
  value: unknown;
  source_ids?: string[];
  confidence?: number;
  valid_from?: string;
  /** Close currently-open claims of the same predicate (their knowledge is kept, never destroyed). */
  close_existing?: boolean;
  /** Migration only: deterministic claim id, so re-applied batches reproduce the exact bytes. */
  claim_id?: string;
  /** Migration only: pinned ISO timestamp used for claim timestamps + entity updated_at. */
  timestamp?: string;
}

export interface ClaimPatch {
  value?: unknown;
  confidence?: number;
  source_ids?: string[];
  valid_from?: string;
  valid_to?: string | null;
  status?: Claim['status'];
}

/**
 * Correction input for a claim that was wrong from the start. The erroneous
 * claim is never deleted or rewritten in place; only the correction is new.
 */
export interface CorrectClaimInput {
  value: unknown;
  /** Defaults to the original predicate when omitted. */
  predicate?: string;
  /** Required: why the original record was wrong. */
  reason: string;
  /** Defaults to the original provenance when omitted. */
  source_ids?: string[];
  /** Defaults to the original valid_from when omitted — no invented dates. */
  valid_from?: string;
  confidence?: number;
}

export class GraphService {
  constructor(private readonly storage: EntityStorage, private readonly index: SearchIndex, private readonly audit: AuditSink, private readonly memory: MemoryService) {}

  /**
   * Category-independent entity resolution over the alias index. Multiple
   * candidates never auto-select: the result is `ambiguous` with the ranked
   * candidate list so the caller (or a later curator) decides.
   * Archived entities are excluded unless `include_archived` is set.
   */
  async resolve(input: ResolveInput): Promise<unknown> {
    const includeArchived = input.include_archived === true;
    const best = new Map<string, { entity: Entity; match: ResolveMatch }>();
    for (const candidate of await this.index.resolveLookup(input.query, { includeArchived })) {
      if (input.types?.length && !input.types.includes(candidate.entity.metadata.type)) continue;
      const previous = best.get(candidate.entity.metadata.id);
      if (!previous || MATCH_ORDER[candidate.match] < MATCH_ORDER[previous.match]) best.set(candidate.entity.metadata.id, candidate);
    }
    const candidates = [...best.values()]
      .map(({ entity, match }) => ({
        id: entity.metadata.id, title: entity.metadata.title, type: entity.metadata.type,
        path: entity.path, match, confidence: RESOLVE_CONFIDENCE[match],
      }))
      .sort((a, b) => MATCH_ORDER[a.match as ResolveMatch] - MATCH_ORDER[b.match as ResolveMatch] || a.title.localeCompare(b.title));
    return {
      query: input.query,
      include_archived: includeArchived,
      ambiguous: candidates.length > 1,
      resolved: candidates.length === 1 ? candidates[0]! : undefined,
      candidates,
      ...(input.hint_id === undefined ? {} : { hint: { hint_id: input.hint_id, hint_valid: best.has(input.hint_id) } }),
    };
  }

  /** Idempotent by identity (entity, type, target). An existing identity is returned unchanged — no write, no audit noise. */
  async createRelation(input: CreateRelationInput, client?: string): Promise<unknown> {
    const relationType = input.relation_type.trim();
    if (!relationType) throw new MemoryError('VALIDATION_ERROR', 'relation_type must not be empty');
    if (input.entity_id === input.target_id) throw new MemoryError('VALIDATION_ERROR', 'Self-relations are not supported');
    if (input.relation_id !== undefined && input.relation_id.length > 0) {
      if (input.relation_id.startsWith('legacy-')) throw new MemoryError('VALIDATION_ERROR', 'relation_id "legacy-*" is reserved for the legacy shim');
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{3,31}$/.test(input.relation_id)) throw new MemoryError('VALIDATION_ERROR', `relation_id has unsupported form: ${input.relation_id}`);
    }
    if (input.timestamp !== undefined && Number.isNaN(Date.parse(input.timestamp))) throw new MemoryError('VALIDATION_ERROR', 'timestamp must be ISO');
    const source = await this.memory.get(input.entity_id);
    const target = await this.memory.get(input.target_id);
    // A duplicate against an already-structured relation is a no-op return
    // (idempotence, never written twice). A duplicate against a legacy
    // `relationships` entry only is the migration itself: structuring it
    // through this write collapses the shim copy (audited update).
    const structuredOnly = structuredRelations(source.metadata);
    const existing = normalizeRelations(source.metadata, source.metadata.id);
    const duplicateId = existing.find(edge => edge.type === relationType && edge.target_id === input.target_id)?.id;
    const duplicateStructured = duplicateId !== undefined && structuredOnly.some(edge => edge.id === duplicateId);
    if (duplicateStructured) return this.relationResult(source.metadata.id, existing.find(edge => edge.id === duplicateId)!, target, false);
    if (source.revision !== input.expected_revision) throw new MemoryError('CONFLICT', 'Entity changed since it was read', { expected_revision: input.expected_revision, actual_revision: source.revision });
    const now = input.timestamp ?? new Date().toISOString();
    const relation: Relation = { id: input.relation_id ?? ulid(), type: relationType, target_id: target.metadata.id, created_at: now, updated_at: now };

    // Collapse the legacy `relationships` duplicates that this write now represents.
    const structured = structuredRelations(source.metadata);
    const identities = new Set([...structured, relation].map(relationIdentity));
    const legacyEntries = Array.isArray(source.metadata.relationships) ? source.metadata.relationships : [];
    const remainingLegacy = legacyEntries.filter(entry =>
      !(typeof entry === 'object' && entry !== null && identities.has(`${String((entry as { type?: unknown }).type)}|${String((entry as { target_id?: unknown }).target_id)}`)));
    const metadata: EntityMetadata = { ...source.metadata, relations: [...structured, relation] };
    if (remainingLegacy.length) metadata.relationships = remainingLegacy;
    else delete metadata.relationships;
    const after = await this.write(source, metadata, appendRelationLine(source.content, { title: target.metadata.title, path: target.path }, relation.id), 'create_relation', client, {
      relation_id: relation.id, type: relation.type, target_id: target.metadata.id,
      legacy_collapsed: legacyEntries.length - remainingLegacy.length,
    }, input.timestamp);
    const fresh = structuredRelations(after.metadata).find(edge => edge.id === relation.id) ?? relation;
    return this.relationResult(source.metadata.id, fresh, target, true, after.revision);
  }

  /**
   * Bulk relation builder. Every edge goes through createRelation — the only
   * relation write path — so idempotence, legacy-shim collapse, body markers,
   * and audit are inherited per edge. There is no automatic inverse anywhere:
   * when a spec carries `inverse`, the reverse edge is written explicitly on
   * the target entity, matching the existing directed-edge semantics (both
   * edges must be written for a relation to be visible from both sides).
   *
   * Default mode is best-effort: each edge is attempted independently and the
   * report carries a per-edge status. `all_or_nothing` pre-flights the whole
   * batch and aborts with VALIDATION_ERROR (zero writes) if any spec is
   * invalid, unresolvable, ambiguous, or self-referential.
   */
  async buildRelations(input: BuildRelationsInput): Promise<unknown> {
    const specs = normalizeRelationSpecs(input.relations ?? []);
    const entityId = (input.entity_id ?? '').trim();
    if (!entityId) throw new MemoryError('VALIDATION_ERROR', 'entity_id must not be empty');
    await this.memory.get(entityId); // source must exist; NOT_FOUND propagates

    interface Planned {
      spec: RelationSpec;
      kind: 'resolved' | 'not_found' | 'ambiguous' | 'self_relation';
      target?: Entity;
      candidates?: Array<{ id: string; title: string; type: string; path: string; match: string; confidence: number }>;
    }
    const planned: Planned[] = [];
    const offenders: string[] = [];
    for (const [index, spec] of specs.entries()) {
      const resolution = await this.resolveTarget(spec.target);
      if (resolution.kind === 'resolved' && resolution.entity.metadata.id === entityId) {
        planned.push({ spec, kind: 'self_relation', target: resolution.entity });
        if (input.all_or_nothing) offenders.push(`relations[${index}]: target "${spec.target}" resolves to the source entity itself`);
      } else if (resolution.kind === 'resolved') {
        planned.push({ spec, kind: 'resolved', target: resolution.entity });
      } else if (resolution.kind === 'ambiguous') {
        planned.push({ spec, kind: 'ambiguous', candidates: resolution.candidates });
        if (input.all_or_nothing) offenders.push(`relations[${index}]: target "${spec.target}" is ambiguous (${resolution.candidates.length} candidates)`);
      } else {
        planned.push({ spec, kind: 'not_found' });
        if (input.all_or_nothing) offenders.push(`relations[${index}]: target "${spec.target}" not found`);
      }
    }
    if (input.all_or_nothing && offenders.length) {
      throw new MemoryError('VALIDATION_ERROR', `all_or_nothing batch aborted before any write: ${offenders.join('; ')}`, { offenders });
    }

    const results: Array<Record<string, unknown>> = [];
    let created = 0, skipped = 0, failed = 0;
    // The summary counts every attempted edge, forward and inverse alike.
    const tally = (status: RelationBatchStatus): void => {
      if (status === 'created') created++;
      else if (status === 'failed') failed++;
      else skipped++;
    };
    for (const item of planned) {
      if (item.kind !== 'resolved') {
        const status: RelationBatchStatus = item.kind === 'not_found' ? 'skipped_not_found' : item.kind === 'ambiguous' ? 'skipped_ambiguous' : 'skipped_self_relation';
        results.push({
          target_query: item.spec.target, type: item.spec.type, status,
          ...(item.target ? { resolved_id: item.target.metadata.id, resolved_title: item.target.metadata.title } : {}),
          ...(item.candidates ? { candidates: item.candidates } : {}),
        });
        tally(status);
        continue;
      }
      const target = item.target!;
      let edge: { status: RelationBatchStatus; relation_id?: string; reason?: string };
      try {
        // Fresh revision every time: earlier edges in the same batch have
        // already advanced the source entity's revision.
        const source = await this.memory.get(entityId);
        const outcome = await this.createRelation({ entity_id: entityId, relation_type: item.spec.type, target_id: target.metadata.id, expected_revision: source.revision }, input.client) as { created: boolean; relation: Relation };
        edge = { status: outcome.created ? 'created' : 'skipped_existing', relation_id: outcome.relation.id };
      } catch (error) {
        edge = { status: 'failed', reason: error instanceof Error ? error.message : String(error) };
      }
      tally(edge.status);
      let inverse: { status: RelationBatchStatus; relation_id?: string; reason?: string } | undefined;
      if (item.spec.inverse) {
        try {
          const targetEntity = await this.memory.get(target.metadata.id);
          const outcome = await this.createRelation({ entity_id: target.metadata.id, relation_type: item.spec.inverse, target_id: entityId, expected_revision: targetEntity.revision }, input.client) as { created: boolean; relation: Relation };
          inverse = { status: outcome.created ? 'created' : 'skipped_existing', relation_id: outcome.relation.id };
        } catch (error) {
          inverse = { status: 'failed', reason: error instanceof Error ? error.message : String(error) };
        }
        tally(inverse.status);
      }
      results.push({
        target_query: item.spec.target, resolved_id: target.metadata.id, resolved_title: target.metadata.title, type: item.spec.type,
        status: edge.status, ...(edge.relation_id ? { relation_id: edge.relation_id } : {}), ...(edge.reason ? { reason: edge.reason } : {}),
        ...(inverse ? { inverse } : {}),
      });
    }
    return { entity_id: entityId, mode: input.all_or_nothing ? 'all_or_nothing' : 'best_effort', results, summary: { created, skipped, failed } };
  }

  async relationsOf(id: string, limit = 200): Promise<unknown> {
    const entity = await this.memory.get(id);
    const edges = await this.index.edgesFrom(id);
    const relations = [];
    for (const edge of edges.slice(0, limit)) {
      relations.push({ ...edge, legacy: edge.id.startsWith('legacy-') ? true : undefined, target: await this.targetInfo(edge.target_id) });
    }
    return { entity_id: id, entity_title: entity.metadata.title, relations };
  }

  /** Typed traversal, cycle-safe by (source_id, relation_id), depth 1–2. */
  async query(input: QueryRelationsInput): Promise<unknown> {
    const direction = input.direction ?? 'outgoing';
    const depth = input.depth ?? 1;
    if (depth < 1 || depth > 2) throw new MemoryError('VALIDATION_ERROR', 'depth must be 1 or 2');
    const limit = Math.min(input.limit ?? 200, 1000);
    const seeds: Array<{ source_id: string; edge: RelationEdge; depth: number }> = [];
    if (input.entity_id) {
      if (direction === 'outgoing' || direction === 'both')
        for (const edge of await this.index.edgesFrom(input.entity_id)) seeds.push({ source_id: input.entity_id, edge, depth: 1 });
      if (direction === 'incoming' || direction === 'both')
        for (const edge of await this.index.edgesTo(input.entity_id)) seeds.push({ source_id: edge.source_id, edge, depth: 1 });
    } else {
      for await (const entity of this.storage.scan())
        seeds.push(...normalizeRelations(entity.metadata, entity.metadata.id).map(relation => ({ source_id: entity.metadata.id, edge: { ...relation, source_id: entity.metadata.id }, depth: 1 })));
    }
    const accept = (edge: RelationEdge): boolean =>
      (!input.relation_type || edge.type === input.relation_type) && (!input.target_id || edge.target_id === input.target_id);
    const seen = new Set<string>();
    const visitedEntities = new Set([input.entity_id ?? '']);
    const result: Array<{ source_id: string; relation: Relation; depth: number }> = [];
    const frontier = [...seeds];
    for (let level = 0; level < depth; level++) {
      const next: typeof frontier = [];
      for (const item of frontier) {
        if (!accept(item.edge)) continue;
        const key = `${item.source_id}:${item.edge.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push({ source_id: item.source_id, relation: this.plain(item.edge), depth: item.depth });
        if (level + 1 < depth) {
          const outward = direction === 'incoming' ? item.source_id : item.edge.target_id;
          if (!visitedEntities.has(outward)) {
            visitedEntities.add(outward);
            const outgoing = direction === 'incoming' ? await this.index.edgesTo(outward) : await this.index.edgesFrom(outward);
            for (const edge of outgoing) next.push(direction === 'incoming' ? { source_id: edge.source_id, edge, depth: level + 2 } : { source_id: outward, edge, depth: level + 2 });
          }
        }
      }
      frontier.length = 0;
      frontier.push(...next);
    }
    return { query: { entity_id: input.entity_id ?? null, relation_type: input.relation_type ?? null, target_id: input.target_id ?? null, direction, depth: Math.min(depth, 2) }, relations: result.slice(0, limit) };
  }

  /** Removes the structured record and its body marker line; unrelated wikilinks are untouched. */
  async deleteRelation(entityId: string, relationId: string, expectedRevision: string, client?: string): Promise<unknown> {
    const source = await this.memory.get(entityId);
    if (source.revision !== expectedRevision) throw new MemoryError('CONFLICT', 'Entity changed since it was read', { expected_revision: expectedRevision, actual_revision: source.revision });
    const relation = structuredRelations(source.metadata).find(edge => edge.id === relationId);
    if (!relation) throw new MemoryError('NOT_FOUND', `Relation not found on entity: ${relationId}`);
    const remaining = structuredRelations(source.metadata).filter(edge => edge.id !== relationId);
    const metadata: EntityMetadata = { ...source.metadata };
    if (remaining.length) metadata.relations = remaining;
    else delete metadata.relations;
    const body = removeRelationLines(source.content, relationId);
    const after = await this.write(source, metadata, body.content, 'delete_relation', client, {
      relation_id: relationId, type: relation.type, target_id: relation.target_id, body_lines_removed: body.removed,
    });
    return { entity_id: after.metadata.id, relation_id: relationId, deleted: true };
  }

  /**
   * Adds a claim. Same-predicate currently-open claims are reported as
   * conflicts; with `close_existing` they are closed (valid_to + superseded)
   * instead — old knowledge is closed, never destroyed.
   */
  async createClaim(entityId: string, input: CreateClaimInput, expectedRevision: string, client?: string): Promise<unknown> {
    const entity = await this.memory.get(entityId);
    const predicate = input.predicate?.trim() ?? '';
    if (!predicate) throw new MemoryError('VALIDATION_ERROR', 'predicate must not be empty');
    if (input.claim_id !== undefined && input.claim_id.length > 0 && !CLAIM_ID.test(input.claim_id))
      throw new MemoryError('VALIDATION_ERROR', `claim_id has unsupported form: ${input.claim_id}`);
    if (input.timestamp !== undefined && Number.isNaN(Date.parse(input.timestamp))) throw new MemoryError('VALIDATION_ERROR', 'timestamp must be ISO');
    const sourceIds = input.source_ids ?? [];
    for (const sourceId of sourceIds) {
      let resolved: Entity;
      try { resolved = await this.memory.get(sourceId); }
      catch { throw new MemoryError('NOT_FOUND', `Claim source entity not found: ${sourceId}`); }
      // Phase-3C §9 write-path type safety: a claim's provenance must point at
      // source entities only — a person/project id in source_ids is never
      // silently accepted.
      if (resolved.metadata.type !== 'source')
        throw new MemoryError('INVALID_SOURCE_TYPE', `Claim source ${sourceId} is a ${resolved.metadata.type}, not a source`);
    }
    if (entity.revision !== expectedRevision) throw new MemoryError('CONFLICT', 'Entity changed since it was read', { expected_revision: expectedRevision, actual_revision: entity.revision });
    const claims = normalizeClaims(entity.metadata);
    const conflicts = claims.filter(claim => claim.predicate === predicate && claimIsCurrent(claim));
    const now = input.timestamp ?? new Date().toISOString();
    let next = claims;
    let closed: string[] = [];
    if (input.close_existing && conflicts.length) {
      closed = conflicts.map(claim => claim.id);
      next = claims.map(claim => closed.includes(claim.id) ? { ...claim, valid_to: today(), status: 'superseded', updated_at: now } : claim);
    }
    const claim: Claim = {
      id: input.claim_id ?? ulid(), predicate, value: input.value, source_ids: sourceIds,
      ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
      valid_from: input.valid_from ?? today(), valid_to: null, status: 'current',
      created_at: now, updated_at: now,
    };
    await this.write(entity, { ...entity.metadata, claims: [...next, claim] }, entity.content, 'create_claim', client, {
      claim_id: claim.id, predicate, value: claim.value, closed,
    // The pinned migration timestamp must reach the entity write too — otherwise a
    // migration batch stamps the entity updated_at with the wall clock and a
    // rollback/re-apply cycle can never reproduce the exact bytes (§26).
    }, input.timestamp);
    return {
      entity_id: entityId, claim, closed,
      conflicts: closed.length ? [] : conflicts.map(claim => claim.id),
    };
  }

  async claims(input: { entity_id?: string; predicate?: string; source_id?: string; valid_at?: string; include_invalidated?: boolean; include_errors?: boolean; limit?: number }): Promise<unknown[]> {
    const limit = Math.min(input.limit ?? 100, 1000);
    const collected: Array<{ entity_id: string; entity_title: string; entity_type: string; claim: Claim }> = [];
    if (input.entity_id) {
      const entity = await this.memory.get(input.entity_id);
      for (const claim of normalizeClaims(entity.metadata)) collected.push({ entity_id: entity.metadata.id, entity_title: entity.metadata.title, entity_type: entity.metadata.type, claim });
    } else {
      for await (const entity of this.storage.scan())
        for (const claim of normalizeClaims(entity.metadata)) collected.push({ entity_id: entity.metadata.id, entity_title: entity.metadata.title, entity_type: entity.metadata.type, claim });
    }
    const validAt = input.valid_at;
    const filtered = collected.filter(({ claim }) => {
      if (input.predicate && claim.predicate !== input.predicate) return false;
      if (input.source_id && !claim.source_ids.includes(input.source_id)) return false;
      if (!input.include_invalidated && claim.status === 'invalidated') return false;
      // An erroneous claim is not a fact about the entity; it is a record of a
      // mistake. Opt in with include_errors to see it.
      if (!input.include_errors && claim.status === 'recorded_in_error') return false;
      if (validAt) {
        if (validAt < claim.valid_from) return false;
        if (claim.valid_to !== null && (claim.valid_to === 'open' || validAt > claim.valid_to)) return false;
      }
      return true;
    });
    return filtered.slice(0, limit).map(({ entity_id, entity_title, entity_type, claim }) => ({ entity_id, entity_title, entity_type, ...claim }));
  }

  /**
   * Temporal view of one entity's claims as of a date. 'planned' is derived,
   * never stored: an open claim (valid_to null) whose valid_from is later than
   * as_of has not started yet; an open claim already in effect (including an
   * unknown '' valid_from) is present; a closed claim is past. Ordering is
   * deterministic so repeated reads return identical arrays.
   *
   * Claims recorded in error are a different category: the record was wrong from
   * the start, so it is neither past, present nor planned. They are reported in a
   * dedicated `errors` bucket so a fictional window never reads as history.
   */
  async timeline(input: { entity_id: string; as_of?: string }): Promise<unknown> {
    const asOf = input.as_of ?? today();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf) || Number.isNaN(Date.parse(asOf))) throw new MemoryError('VALIDATION_ERROR', 'as_of must be an ISO date (YYYY-MM-DD)');
    const entity = await this.memory.get(input.entity_id);
    const claims = normalizeClaims(entity.metadata);
    // Mirrors the claims() read path: 'open' is tolerated as an open sentinel.
    const isOpen = (claim: Claim): boolean => claim.valid_to === null || claim.valid_to === 'open';
    const errors = claims.filter(claim => claim.status === 'recorded_in_error');
    const valid = claims.filter(claim => claim.status !== 'recorded_in_error');
    const past = valid.filter(claim => !isOpen(claim));
    const present = valid.filter(claim => isOpen(claim) && claim.valid_from <= asOf);
    const planned = valid.filter(claim => isOpen(claim) && claim.valid_from > asOf);
    const desc = (a: string, b: string): number => a < b ? 1 : a > b ? -1 : 0;
    const asc = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
    // past: newest close first; present: most recently started first ('' unknown last);
    // planned: soonest start first. Ties break on timestamps, then id for stability.
    past.sort((a, b) => desc(a.valid_to ?? '', b.valid_to ?? '') || desc(a.updated_at, b.updated_at) || asc(a.id, b.id));
    present.sort((a, b) => desc(a.valid_from, b.valid_from) || desc(a.updated_at, b.updated_at) || asc(a.id, b.id));
    planned.sort((a, b) => asc(a.valid_from, b.valid_from) || asc(a.created_at, b.created_at) || asc(a.id, b.id));
    // errors: most recently corrected first, then id for stability.
    errors.sort((a, b) => desc(a.corrected_at ?? '', b.corrected_at ?? '') || asc(a.id, b.id));
    const flatten = (claim: Claim) => ({ entity_id: entity.metadata.id, entity_title: entity.metadata.title, entity_type: entity.metadata.type, ...claim });
    return {
      entity_id: entity.metadata.id, entity_title: entity.metadata.title, as_of: asOf,
      counts: { past: past.length, present: present.length, planned: planned.length, errors: errors.length },
      past: past.map(flatten), present: present.map(flatten), planned: planned.map(flatten), errors: errors.map(flatten),
    };
  }

  async updateClaim(entityId: string, claimId: string, patch: ClaimPatch, expectedRevision: string, client?: string): Promise<unknown> {
    const entity = await this.memory.get(entityId);
    if (entity.revision !== expectedRevision) throw new MemoryError('CONFLICT', 'Entity changed since it was read', { expected_revision: expectedRevision, actual_revision: entity.revision });
    const claims = normalizeClaims(entity.metadata);
    const index = claims.findIndex(claim => claim.id === claimId);
    if (index < 0) throw new MemoryError('NOT_FOUND', `Claim not found on entity: ${claimId}`);
    if (patch.source_ids) for (const sourceId of patch.source_ids) {
      let resolved: Entity;
      try { resolved = await this.memory.get(sourceId); }
      catch { throw new MemoryError('NOT_FOUND', `Claim source entity not found: ${sourceId}`); }
      if (resolved.metadata.type !== 'source') // Phase-3C §9 type safety, same rule as claim creation
        throw new MemoryError('INVALID_SOURCE_TYPE', `Claim source ${sourceId} is a ${resolved.metadata.type}, not a source`);
    }
    const updated: Claim = {
      ...claims[index]!, ...patch,
      valid_to: patch.valid_to === undefined ? claims[index]!.valid_to : patch.valid_to,
      updated_at: new Date().toISOString(),
    };
    const next = claims.map((claim, position) => position === index ? updated : claim);
    await this.write(entity, { ...entity.metadata, claims: next }, entity.content, 'update_claim', client, { claim_id: claimId });
    return { entity_id: entity.metadata.id, claim: updated };
  }

  /** Marks the claim invalid from today; the claim body is kept (history is never destroyed). */
  async invalidateClaim(entityId: string, claimId: string, expectedRevision: string, client?: string, reason?: string): Promise<unknown> {
    const entity = await this.memory.get(entityId);
    if (entity.revision !== expectedRevision) throw new MemoryError('CONFLICT', 'Entity changed since it was read', { expected_revision: expectedRevision, actual_revision: entity.revision });
    const claims = normalizeClaims(entity.metadata);
    const index = claims.findIndex(claim => claim.id === claimId);
    if (index < 0) throw new MemoryError('NOT_FOUND', `Claim not found on entity: ${claimId}`);
    const updated: Claim = { ...claims[index]!, valid_to: today(), status: 'invalidated', updated_at: new Date().toISOString() };
    const next = claims.map((claim, position) => position === index ? updated : claim);
    const after = await this.write(entity, { ...entity.metadata, claims: next }, entity.content, 'invalidate_claim', client, { claim_id: claimId, ...(reason ? { reason } : {}) });
    return { entity_id: after.metadata.id, claim: updated };
  }

  /**
   * Correct a claim that was wrong from the start — the opposite semantics of
   * `close_existing`/`superseded`, which models a fact that genuinely changed
   * over time. ONE audited write does both halves atomically: the original claim
   * stays in the record with an error marker (never deleted, never rewritten in
   * place, and its fictional validity window is left untouched), and a new
   * corrected claim is appended with provenance pointing back to it.
   */
  async correctClaim(entityId: string, claimId: string, input: CorrectClaimInput, expectedRevision: string, client?: string): Promise<unknown> {
    const entity = await this.memory.get(entityId);
    if (entity.revision !== expectedRevision) throw new MemoryError('CONFLICT', 'Entity changed since it was read', { expected_revision: expectedRevision, actual_revision: entity.revision });
    const claims = normalizeClaims(entity.metadata);
    const index = claims.findIndex(claim => claim.id === claimId);
    if (index < 0) throw new MemoryError('NOT_FOUND', `Claim not found on entity: ${claimId}`);
    const original = claims[index]!;
    if (original.status === 'recorded_in_error') throw new MemoryError('VALIDATION_ERROR', `Claim ${claimId} is already recorded in error; correct its correction instead`);
    const reason = input.reason?.trim() ?? '';
    if (!reason) throw new MemoryError('VALIDATION_ERROR', 'reason must not be empty — state why the original claim was wrong');
    const predicate = (input.predicate ?? original.predicate).trim();
    if (!predicate) throw new MemoryError('VALIDATION_ERROR', 'predicate must not be empty');
    if (input.valid_from !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(input.valid_from)) throw new MemoryError('VALIDATION_ERROR', 'valid_from must be an ISO date (YYYY-MM-DD)');
    const sourceIds = input.source_ids ?? original.source_ids;
    for (const sourceId of sourceIds) {
      let resolved: Entity;
      try { resolved = await this.memory.get(sourceId); }
      catch { throw new MemoryError('NOT_FOUND', `Claim source entity not found: ${sourceId}`); }
      if (resolved.metadata.type !== 'source') // same §9 provenance rule as claim creation
        throw new MemoryError('INVALID_SOURCE_TYPE', `Claim source ${sourceId} is a ${resolved.metadata.type}, not a source`);
    }
    const now = new Date().toISOString();
    const corrected: Claim = {
      id: ulid(), predicate, value: input.value, source_ids: sourceIds,
      ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
      valid_from: input.valid_from ?? original.valid_from, valid_to: null, status: 'current',
      corrects: original.id, created_at: now, updated_at: now,
    };
    // The original keeps its body and its (fictional) window: no valid_to is
    // invented, because a claim that was wrong from the start never held a real
    // period of validity. Only the error marker and the link are added.
    const marked: Claim = { ...original, status: 'recorded_in_error', error_reason: reason, corrected_at: now, corrected_by: corrected.id, updated_at: now };
    const next = claims.map((claim, position) => position === index ? marked : claim);
    next.push(corrected);
    const after = await this.write(entity, { ...entity.metadata, claims: next }, entity.content, 'correct_claim', client, {
      claim_id: original.id, corrected_claim_id: corrected.id, predicate, reason,
    });
    return { entity_id: after.metadata.id, original: marked, corrected };
  }

  /**
   * Read-only suspect scan: claims that share the provenance of a claim already
   * recorded in error are candidates for the same mistake. This never writes,
   * never audits, and never auto-fixes — a human decides.
   */
  async findSuspectClaims(input: { source_id: string; predicate?: string; entity_id?: string; limit?: number }): Promise<unknown> {
    const sourceId = input.source_id?.trim() ?? '';
    if (!sourceId) throw new MemoryError('VALIDATION_ERROR', 'source_id must not be empty');
    const limit = Math.min(input.limit ?? 100, 1000);
    const collected: Array<{ entity_id: string; entity_title: string; claim: Claim }> = [];
    if (input.entity_id) {
      const entity = await this.memory.get(input.entity_id);
      for (const claim of normalizeClaims(entity.metadata)) collected.push({ entity_id: entity.metadata.id, entity_title: entity.metadata.title, claim });
    } else {
      for await (const entity of this.storage.scan())
        for (const claim of normalizeClaims(entity.metadata)) collected.push({ entity_id: entity.metadata.id, entity_title: entity.metadata.title, claim });
    }
    const candidates = collected
      .filter(({ claim }) => claim.status !== 'recorded_in_error' && claim.source_ids.includes(sourceId) && (!input.predicate || claim.predicate === input.predicate))
      .sort((a, b) => a.entity_id.localeCompare(b.entity_id) || a.claim.predicate.localeCompare(b.claim.predicate) || a.claim.id.localeCompare(b.claim.id))
      .slice(0, limit)
      .map(({ entity_id, entity_title, claim }) => ({
        entity_id, entity_title, id: claim.id, predicate: claim.predicate, value: claim.value, status: claim.status,
        reason: 'same source and predicate as a claim recorded in error',
      }));
    return { source_id: sourceId, predicate: input.predicate ?? null, candidates, count: candidates.length };
  }

  /** Dedup key used by merge: same predicate, value, and open window is the same claim. */
  static claimIdentity = claimKey;

  /**
   * Target resolution for batch building: direct stable-id lookup first, then
   * the shared resolver path (exact title/alias → path → normalized → compact).
   * Never auto-selects: several candidates come back as `ambiguous` with the
   * ranked list, exactly like resolve().
   */
  private async resolveTarget(query: string): Promise<{ kind: 'resolved'; entity: Entity } | { kind: 'ambiguous'; candidates: Array<{ id: string; title: string; type: string; path: string; match: string; confidence: number }> } | { kind: 'not_found' }> {
    try {
      return { kind: 'resolved', entity: await this.memory.get(query) };
    } catch {
      // not a stable id — fall through to the alias/path index
    }
    const best = new Map<string, { entity: Entity; match: ResolveMatch }>();
    for (const candidate of await this.index.resolveLookup(query)) {
      const previous = best.get(candidate.entity.metadata.id);
      if (!previous || MATCH_ORDER[candidate.match] < MATCH_ORDER[previous.match]) best.set(candidate.entity.metadata.id, candidate);
    }
    const ranked = [...best.values()]
      .map(({ entity, match }) => ({ id: entity.metadata.id, title: entity.metadata.title, type: entity.metadata.type, path: entity.path, match, confidence: RESOLVE_CONFIDENCE[match] }))
      .sort((a, b) => MATCH_ORDER[a.match as ResolveMatch] - MATCH_ORDER[b.match as ResolveMatch] || a.title.localeCompare(b.title));
    if (ranked.length === 0) return { kind: 'not_found' };
    if (ranked.length === 1) return { kind: 'resolved', entity: best.get(ranked[0]!.id)!.entity };
    return { kind: 'ambiguous', candidates: ranked };
  }

  private async targetInfo(targetId: string): Promise<{ id: string; title: string | null; resolved: boolean }> {
    try {
      const entity = await this.memory.get(targetId);
      return { id: entity.metadata.id, title: entity.metadata.title, resolved: true };
    } catch {
      return { id: targetId, title: null, resolved: false };
    }
  }

  private plain(edge: RelationEdge): Relation {
    return { id: edge.id, type: edge.type, target_id: edge.target_id, created_at: edge.created_at, updated_at: edge.updated_at };
  }

  private relationResult(sourceId: string, relation: Relation, target: Entity, created: boolean, revision?: string): unknown {
    return {
      source_id: sourceId, target_id: target.metadata.id, target_title: target.metadata.title,
      relation, created, ...(revision ? { revision } : {}),
    };
  }

  private async write(current: Entity, metadata: EntityMetadata, content: string, operation: string, client: string | undefined, details?: Record<string, unknown>, timestamp?: string): Promise<Entity> {
    const after = await this.storage.write(current.metadata.id, metadata, content, current.revision, timestamp ? { timestamp } : undefined);
    await this.record(operation, current, after, client, details);
    return after;
  }

  private async record(operation: string, before: Entity, after: Entity, client?: string, details?: Record<string, unknown>): Promise<void> {
    const id = ulid();
    await this.audit.append({
      id, timestamp: new Date().toISOString(), operation, entity_id: after.metadata.id, client,
      before_revision: before.revision, after_revision: after.revision,
      before_snapshot: `${id}-before.json`, after_snapshot: `${id}-after.json`,
      ...(details ? { details } : {}),
    }, before, after);
  }
}