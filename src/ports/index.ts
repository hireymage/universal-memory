import type { AuditEvent, Changeset, Entity, EntityDraft, EntityMetadata, EntityPatch, ExternalFile, RelationEdge, SearchQuery } from '../domain/types.js';

export interface EntityStorage {
  create(draft: EntityDraft): Promise<Entity>;
  get(id: string): Promise<Entity | undefined>;
  getByPath(path: string): Promise<Entity | undefined>;
  update(id: string, patch: EntityPatch, expectedRevision: string): Promise<Entity>;
  /** Full-metadata write used by the graph, merge, and restore paths. */
  write(id: string, metadata: EntityMetadata, content: string, expectedRevision: string, options?: { timestamp?: string }): Promise<Entity>;
  move(id: string, destination: string, expectedRevision: string): Promise<Entity>;
  adopt(path: string, draft: EntityDraft, expectedRevision: string): Promise<Entity>;
  archive(id: string, expectedRevision: string): Promise<Entity>;
  /** Migration rollback only (Phase 3C §27): removes the entity's managed file
   * after an audited delete. Not reachable through any generic delete tool. */
  remove(id: string): Promise<void>;
  scan(): AsyncIterable<Entity>;
  inspectFiles(): Promise<Array<{ path: string; entity?: Entity; error?: string }>>;
  externalFiles(): Promise<ExternalFile[]>;
}

/**
 * How a resolve lookup matched: an exact stable id or a case-exact
 * title/alias, an Obsidian-style path match (vault-relative path without the
 * extension, so `[[People/jan-novak|…]]` targets it), a normalized
 * (accent/case/spacing-insensitive) title or alias match, or finally a compact
 * (punctuation-space-insensitive) match.
 */
export type ResolveMatch = 'id' | 'exact' | 'path' | 'normalized' | 'compact';

export interface ResolveCandidate {
  entity: Entity;
  match: ResolveMatch;
}

export interface AliasCollision {
  key: string;
  form: 'normalized' | 'compact' | 'path';
  entity_ids: string[];
}

/**
 * Candidate visibility for alias-index lookups.
 *
 * Archived entities stay in the index: they remain addressable by stable ID,
 * auditable, restorable, and their files still count as real wikilink targets.
 * They are only invisible to *resolution* (title/alias/path lookup) unless the
 * caller explicitly opts in with `includeArchived: true`.
 */
export interface ArchivedVisibility {
  /** Include entities whose `metadata.status` is `archived`. Default: false. */
  includeArchived?: boolean;
}

/** Filter over `source`-type entities. Identity is the canonical
 * (provider, identity_type, identity_value) triple (Phase-3C VARIANTA B);
 * provider+conversation_id / provider+content_hash normalize to the same
 * identity space so legacy and typed sources dedup together. */
export interface SourceFilter {
  provider?: string;
  conversation_id?: string;
  content_hash?: string;
  identity_type?: string;
  identity_value?: string;
}

export interface SearchIndex {
  rebuild(entities: AsyncIterable<Entity>): Promise<{ indexed: number }>;
  upsert(entity: Entity): Promise<void>;
  remove(id: string): Promise<void>;
  /** Id, path, and revision currently held by the disposable index. */
  listEntries(): Promise<Array<{ id: string; path: string; revision: string }>>;
  search(query: SearchQuery): Promise<Entity[]>;
  /** Every indexed entity. Find uses this when a query has filters but no text. */
  listAll(): Promise<Entity[]>;
  findById(id: string): Promise<{ path: string; revision: string } | undefined>;
  backlinks(titleOrAlias: string): Promise<Entity[]>;
  linksFrom(id: string): Promise<string[]>;
  /** People whose `birth_date`/`name_day` falls in the window. Archived people
   * are excluded by default — an archived merge stub is not a person. */
  dateWindow(field: 'birth_date' | 'name_day', from: string, to: string, visibility?: ArchivedVisibility): Promise<Entity[]>;
  /**
   * Resolve a user/reference string to candidate entities via the alias index.
   * Archived entities are excluded by default; pass `includeArchived: true` to
   * see them (for example a curator auditing a merge or a rollback).
   */
  resolveLookup(raw: string, visibility?: ArchivedVisibility): Promise<ResolveCandidate[]>;
  /** Typed relation edges (normalized, legacy entries included) by source/target. */
  edgesFrom(id: string): Promise<RelationEdge[]>;
  edgesTo(id: string): Promise<RelationEdge[]>;
  /**
   * Keys where more than one *resolvable* entity claims the same alias —
   * reported, never auto-resolved. Archived claimants are excluded by default
   * because they cannot be resolved; pass `includeArchived: true` to see the
   * latent collisions an entity would create again after a restore.
   */
  aliasCollisions(visibility?: ArchivedVisibility): Promise<Array<AliasCollision>>;
  /** Lookup `source`-type entities by their import identity fields. */
  findSources(filter: SourceFilter): Promise<Entity[]>;
}

/** One touched file of a multi-file operation (for example merge). */
export interface AuditBundleItem {
  entity_id: string;
  path: string;
  before?: Entity;
  after?: Entity;
}

export interface AuditSink {
  append(event: AuditEvent, before?: Entity, after?: Entity, bundle?: AuditBundleItem[]): Promise<void>;
  list(entityId?: string, limit?: number): Promise<AuditEvent[]>;
  readSnapshot(eventId: string, which: 'before' | 'after'): Promise<Entity | undefined>;
  /** Entities touched together by one multi-file event, in bundle order. */
  readBundle(eventId: string): Promise<AuditBundleItem[]>;
}

export interface ChangesetStore {
  save(changeset: Changeset): Promise<void>;
  get(id: string): Promise<Changeset | undefined>;
  list(): Promise<Changeset[]>;
}