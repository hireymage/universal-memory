export type EntityType = 'memory' | 'inbox' | 'note' | 'knowledge' | 'person' | 'project' | (string & {});

export interface EntityMetadata {
  id: string;
  type: EntityType;
  title: string;
  created_at: string;
  updated_at: string;
  aliases: string[];
  tags: string[];
  status: string;
  schema_version: number;
  [key: string]: unknown;
}

export interface Entity {
  metadata: EntityMetadata;
  content: string;
  path: string;
  revision: string;
  wikilinks: string[];
}

export interface EntitySummary {
  id: string;
  type: string;
  title: string;
  path: string;
  revision: string;
  status: string;
  updated_at: string;
  tags: string[];
}

export interface EntityDraft {
  type: EntityType;
  title: string;
  content?: string;
  metadata?: Record<string, unknown>;
}

export interface EntityPatch {
  title?: string;
  content?: string;
  metadata?: Record<string, unknown>;
}

export interface ExternalFile {
  path: string;
  revision: string;
  bytes: number;
  content: string;
  error: string;
}

export interface SearchQuery {
  query?: string;
  types?: string[];
  status?: string;
  tags?: string[];
  limit?: number;
  /** `due` lists tasks and events upcoming first. Other types keep relevance order. */
  order?: 'relevance' | 'due';
}

/**
 * Category-independent retrieval result. This deliberately contains source
 * entities and graph evidence, not an LLM-generated answer.
 */
export interface RetrievedRelation {
  source_id: string;
  entity: Entity;
  reason: string;
}

export interface RetrievedContext {
  query: string;
  subject?: Entity;
  matches: Entity[];
  related: RetrievedRelation[];
}

/**
 * Typed relation. Stored in the source entity frontmatter under `relations`;
 * identity is (source entity, type, target_id). Legacy `relationships` entries
 * (no id) get a deterministic derived id so they can be addressed without
 * rewriting the file.
 */
export interface Relation {
  id: string;
  type: string;
  target_id: string;
  created_at: string;
  updated_at: string;
}

export type RelationDirection = 'outgoing' | 'incoming' | 'both';

/**
 * A typed relation seen from the index, with the holding entity resolved.
 * Index edge stores carry this form so incoming queries can report their
 * owning source entity.
 */
export interface RelationEdge extends Relation {
  source_id: string;
}

/**
 * Structured claim about one entity. Lives in the entity frontmatter under
 * `claims`; `valid_to: null` means the claim is currently valid. An entity may
 * hold several current claims for the same predicate — that state is a
 * potential conflict, surfaced by the claim API, never resolved automatically.
 */
export interface Claim {
  id: string;
  predicate: string;
  value: unknown;
  source_ids: string[];
  confidence?: number;
  valid_from: string;
  valid_to: string | null;
  /**
   * `superseded` = the fact genuinely changed over time (a real closed window).
   * `recorded_in_error` = the record itself was wrong from the start: the claim
   * is kept verbatim with an error marker and replaced by a correcting claim.
   */
  status?: 'current' | 'superseded' | 'invalidated' | 'disputed' | 'recorded_in_error';
  /** Correction provenance: id of the claim that replaces this erroneous one. */
  corrected_by?: string;
  /** Why the original record was wrong from the start. */
  error_reason?: string;
  /** When the correction was recorded. */
  corrected_at?: string;
  /** On the correcting claim: id of the erroneous claim it replaces. */
  corrects?: string;
  created_at: string;
  updated_at: string;
}

export type Scope =
  | { kind: 'file'; path: string }
  | { kind: 'folder'; path: string }
  | { kind: 'entity_type'; entity_type: string }
  | { kind: 'project'; entity_id: string }
  | { kind: 'changed_since'; timestamp: string }
  | { kind: 'vault' };

export interface Diagnostic {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  path?: string;
  entity_id?: string;
}

export type ChangeOperationKind = 'create' | 'update' | 'archive' | 'move' | 'adopt' | 'merge' | 'restore' | 'relation' | 'claim' | 'delete';

export interface ChangeOperation {
  kind: ChangeOperationKind;
  entity_id?: string;
  path?: string;
  expected_revision?: string;
  draft?: EntityDraft;
  patch?: EntityPatch;
  destination?: string;
  /** merge only: canonical (target) entity id */
  target_id?: string;
  /** merge only: expected revision of the target entity */
  expected_target_revision?: string;
  /** relation only: the canonical relation type */
  relation_type?: string;
  /** claim only: the claim predicate */
  predicate?: string;
  /** claim only: the claim value */
  value?: unknown;
  /** claim only: provenance source entity ids */
  source_ids?: string[];
  /** claim only: optional confidence */
  confidence?: number;
  /**
   * claim only: explicit valid_from. An empty string means "temporal origin
   * unknown" — the model never infers a date that no data supports.
   */
  valid_from?: string;
  /** claim only: close currently-open claims of the same predicate */
  close_existing?: boolean;
  /** relation only: deterministic relation id for migration batches */
  relation_id?: string;
  /** claim only: deterministic claim id for migration batches */
  claim_id?: string;
  /** relation/claim only: pinned ISO timestamp for migration determinism */
  timestamp?: string;
  /** source create only (Phase-3C): canonical url identity value */
  source_url?: string;
  /** source create only (Phase-3C): typed identity kind */
  identity_type?: string;
  /** source create only (Phase-3C): typed identity value */
  identity_value?: string;
}

export interface Changeset {
  id: string;
  created_at: string;
  status: 'prepared' | 'applied' | 'rejected';
  description: string;
  operations: ChangeOperation[];
  diagnostics: Diagnostic[];
}

export interface AuditEvent {
  id: string;
  timestamp: string;
  operation: string;
  entity_id?: string;
  client?: string;
  before_revision?: string;
  after_revision?: string;
  before_snapshot?: string;
  after_snapshot?: string;
  details?: Record<string, unknown>;
}

export const summarize = (entity: Entity): EntitySummary => ({
  id: entity.metadata.id,
  type: entity.metadata.type,
  title: entity.metadata.title,
  path: entity.path,
  revision: entity.revision,
  status: entity.metadata.status,
  updated_at: entity.metadata.updated_at,
  tags: entity.metadata.tags,
});