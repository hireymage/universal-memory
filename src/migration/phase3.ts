/**
 * Phase-3 deterministic migration runner. First batch (3A): the 27 legacy
 * `metadata.relationships` relations proven SAFE by the Phase-2 audit; 3B:
 * validated structured frontmatter claims. No LLM interpretation, no
 * semantic wikilink conversion, no merging, no conflict resolution.
 *
 * Every op is fingerprinted; the migration ledger outside the vault skips
 * any fingerprint that is already applied, so running the same migration
 * twice never writes twice. Rollback re-applicability relies on
 * deterministic relation/claim ids and a pinned migration timestamp.
 */
import { createHash } from 'node:crypto';
import type { AuditEvent, ChangeOperation, Claim, Entity, EntityDraft } from '../domain/types.js';
import type { Services } from '../composition.js';
import { MemoryError } from '../domain/errors.js';
import { canonicalJson, opFingerprint, type LedgerEntry, type MigrationLedger } from '../adapters/migration/migration-ledger.js';
import { claimKey, normalizeClaims, relationIdentity, structuredRelations } from '../domain/model.js';
import { canonicalizeUrl, looksLikeHttpUrl } from '../domain/source-identity.js';

export type Phase3Stage = 'relations' | 'claims' | 'sources';

export interface Phase3Op extends ChangeOperation {
  fingerprint: string;
  file: string;
  evidence: string;
}

export interface Phase3Plan {
  stage: Phase3Stage;
  migration_time: string;
  file_count: number;
  planned_hash: string;
  ops: Phase3Op[];
  skipped: Array<{ fingerprint: string; entity_id: string; reason: string }>;
  review: Array<{ entity_id: string; file?: string; detail: string }>;
  counts: { planned: number; skipped: number; review: number };
  /** Preview-driven planning only: hard blockers — empty means the plan is executable. */
  preview_errors?: string[];
  /** Preview-driven planning only: structural validation of the approved preview. */
  preview_validation?: PreviewValidation | SourcePreviewValidation;
}

export interface Phase3Opts {
  stage: Phase3Stage;
  migrationTime: string;
  ledger: MigrationLedger;
  /** Cap the batch to the first N ops (smallest safe batch); default all. */
  limit?: number;
  /** Phase 3B only: approved, fingerprinted preflight preview — the ONLY authorization source for claim ops. */
  previewPath?: string;
}

const relationId = (entityId: string, type: string, targetId: string): string =>
  `p3r-${createHash('sha256').update(`${entityId}|${type}|${targetId}`).digest('hex').slice(0, 20)}`;
/** Claim id from the canonical claim identity key (see domain model claimKey). */
const claimId = (entityId: string, predicate: string, value: unknown): string =>
  `p3c-${createHash('sha256').update(`${entityId}|${claimKey({ predicate, value, valid_to: null })}`).digest('hex').slice(0, 20)}`;

const planHash = (ops: Phase3Op[], skipped: Phase3Plan['skipped']): string =>
  createHash('sha256').update(canonicalJson({
    fingerprints: ops.map(op => op.fingerprint).sort(),
    skipped: skipped.map(skip => skip.fingerprint).sort(),
  })).digest('hex');

/** ---------------- Batch 3A: legacy metadata.relationships ---------------- */

export async function planRelations(services: Services, opts: Phase3Opts): Promise<Phase3Plan> {
  let fileCount = 0;
  const ops: Phase3Op[] = [];
  const skipped: Phase3Plan['skipped'] = [];
  const review: Phase3Plan['review'] = [];
  for await (const entity of services.storage.scan()) {
    fileCount++;
    const structured = structuredRelations(entity.metadata);
    const identities = new Set(structured.map(edge => relationIdentity(edge)));
    const legacy = Array.isArray(entity.metadata.relationships) ? entity.metadata.relationships : [];
    for (const raw of legacy) {
      const entry = raw as { type?: unknown; target_id?: unknown };
      const file = entity.path;
      if (typeof entry.type !== 'string' || typeof entry.target_id !== 'string' || !entry.type || !entry.target_id) {
        review.push({ entity_id: entity.metadata.id, file, detail: 'malformed relationships entry' });
        continue;
      }
      // §19: the ledger guard has precedence — a fingerprint already applied
      // must skip before any other classification, so a re-appearing legacy
      // entry can never be written twice.
      const fingerprint = opFingerprint({ stage: 'relations', kind: 'relation', entity_id: entity.metadata.id, relation_type: entry.type, target_id: entry.target_id });
      if (entry.target_id === entity.metadata.id) {
        review.push({ entity_id: entity.metadata.id, file, detail: 'self-relation' });
        continue;
      }
      if (await opts.ledger.statusOf(fingerprint) === 'applied') {
        skipped.push({ fingerprint, entity_id: entity.metadata.id, reason: 'already_applied' });
        continue;
      }
      if (identities.has(`${entry.type}|${entry.target_id}`)) {
        review.push({ entity_id: entity.metadata.id, file, detail: 'relation identity already structured — nothing to migrate' });
        continue;
      }
      if (structured.some(edge => edge.target_id === entry.target_id && edge.type !== entry.type)) {
        // A typed relation to the same target already carries a marker (§7/§8) —
        // two structured entries to one target need a review decision first.
        review.push({ entity_id: entity.metadata.id, file, detail: `target ${entry.target_id} already holds a typed relation of a different type` });
        continue;
      }
      let target: Entity | undefined;
      try {
        target = await services.memory.get(entry.target_id);
      } catch { target = undefined; }
      if (!target) {
        review.push({ entity_id: entity.metadata.id, file, detail: `target ${entry.target_id} does not resolve` });
        continue;
      }
      if (ops.filter(op => op.fingerprint === fingerprint).length) { skipped.push({ fingerprint, entity_id: entity.metadata.id, reason: 'duplicate_in_plan' }); continue; }
      ops.push({
        kind: 'relation', entity_id: entity.metadata.id, expected_revision: entity.revision,
        relation_type: entry.type, target_id: entry.target_id,
        relation_id: relationId(entity.metadata.id, entry.type, entry.target_id),
        timestamp: opts.migrationTime,
        fingerprint, file, evidence: `${file}: metadata.relationships ${entry.type} → ${entry.target_id}`,
      });
    }
  }
  return {
    stage: 'relations', migration_time: opts.migrationTime, file_count: fileCount,
    planned_hash: planHash(ops, skipped),
    ops: opts.limit ? ops.slice(0, opts.limit) : ops,
    skipped, review,
    counts: { planned: opts.limit ? Math.min(opts.limit, ops.length) : ops.length, skipped: skipped.length, review: review.length },
  };
}

/** ---------------- Batch 3B: validated structured frontmatter claims ---------------- */

/** Keys the graph/system owns and that must never become claims. */
const OWNED_KEYS = new Set([
  'id', 'type', 'title', 'created_at', 'updated_at', 'aliases', 'tags', 'status', 'schema_version',
  'related', 'relations', 'claims', 'relationships', 'supersedes',
]);
/** Import/infrastructure plumbing — structural metadata, not facts. */
const MACHINERY_KEYS = new Set(['rag', 'security_review', 'redactions_applied', 'generated', 'metadata', 'source',
  'parent', 'project_slug', 'system_subpath', 'collection_path', 'project_subpath', 'project', 'date', 'item', 'client',
  'agent_id', 'component_key', 'component_version', 'canonical_language', 'canonical_hash', 'representation',
  'translation_version', 'node_type', 'path', 'project_id', 'role_id', 'role_name', 'source_url', 'urls']);
/** Prose containers — never facts. */
const NON_FACT_KEYS = new Set(['problém', 'řešení', 'souhrn', 'poznámka', 'přehled', 'overview', 'summary', 'kontext',
  'context', 'poznatky', 'zjištění', 'další kroky', 'next steps', 'todo', 'postup', 'steps', 'zpráva', 'message', 'obsah', 'body']);
/** Source-like keys route to Source entities (separate deferred concern), not claims. */
const SOURCE_KEYS = new Set(['source', 'source_url', 'url', 'urls', 'link', 'links', 'reference']);
/** Types whose notes are freeform work material, not fact carriers. */
const NON_FACTUAL_TYPES = new Set(['idea', 'task', 'journal', 'inbox', 'agent_identity', 'agent_identity_cs', 'agent_soul', 'agent_soul_cs', 'agent_role', 'agent_role_cs']);
const PREDICATE_FORM = /^[a-z][a-z0-9_]*$/;

export async function planClaims(services: Services, opts: Phase3Opts): Promise<Phase3Plan> {
  let fileCount = 0;
  const ops: Phase3Op[] = [];
  const skipped: Phase3Plan['skipped'] = [];
  const review: Phase3Plan['review'] = [];
  for await (const entity of services.storage.scan()) {
    fileCount++;
    const file = entity.path;
    if (NON_FACTUAL_TYPES.has(entity.metadata.type)) continue;
    const existing = normalizeClaims(entity.metadata);
    const currentByPredicate = new Map<string, Array<{ value: unknown; id: string }>>();
    for (const claim of existing)
      if (claim.valid_to === null && (claim.status === undefined || claim.status === 'current' || claim.status === 'disputed'))
        currentByPredicate.set(claim.predicate, [...(currentByPredicate.get(claim.predicate) ?? []), { value: claim.value, id: claim.id }]);
    for (const [key, raw] of Object.entries(entity.metadata)) {
      if (OWNED_KEYS.has(key) || MACHINERY_KEYS.has(key) || NON_FACT_KEYS.has(key) || SOURCE_KEYS.has(key)) continue;
      if (key.startsWith('legacy_') || key.startsWith('migration_')) continue;
      if (/^[A-Z]{2,}[0-9]*$/.test(key)) continue; // acronym-style metadata markers (e.g. TASK IDs), not predicates
      const scalar = raw === null || typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean';
      const value = typeof raw === 'string' ? raw.trim() : raw;
      if (!scalar || value === '' || (typeof value === 'string' && value.length > 200)) {
        review.push({ entity_id: entity.metadata.id, file, detail: `non-scalar or oversized value for ${key}` });
        continue;
      }
      if (!PREDICATE_FORM.test(key)) {
        review.push({ entity_id: entity.metadata.id, file, detail: `predicate form unsupported: ${key}` });
        continue;
      }
      const claimants = currentByPredicate.get(key) ?? [];
      const identical = claimants.some(claimant => claimKey({ predicate: key, value: claimant.value, valid_to: null }) === claimKey({ predicate: key, value, valid_to: null }));
      if (identical) { skipped.push({ fingerprint: claimId(entity.metadata.id, key, value), entity_id: entity.metadata.id, reason: 'already_claimed' }); continue; }
      if (claimants.length) {
        review.push({ entity_id: entity.metadata.id, file, detail: `current claim for ${key} holds different value — conflict decision first` });
        continue;
      }
      const fingerprint = opFingerprint({ stage: 'claims', kind: 'claim', entity_id: entity.metadata.id, predicate: key, value, valid_from: '' });
      if (await opts.ledger.statusOf(fingerprint) === 'applied') { skipped.push({ fingerprint, entity_id: entity.metadata.id, reason: 'already_applied' }); continue; }
      if (ops.some(op => op.fingerprint === fingerprint)) continue;
      ops.push({
        kind: 'claim', entity_id: entity.metadata.id, expected_revision: entity.revision,
        predicate: key, value, valid_from: '', claim_id: claimId(entity.metadata.id, key, value),
        timestamp: opts.migrationTime,
        confidence: 0.9,
        fingerprint, file,
        evidence: `${file}: frontmatter ${key} = ${JSON.stringify(value).slice(0, 120)}`,
      });
    }
  }
  const limited = opts.limit ? ops.slice(0, opts.limit) : ops;
  return {
    stage: 'claims', migration_time: opts.migrationTime, file_count: fileCount,
    planned_hash: planHash(limited, skipped),
    ops: limited, skipped, review,
    counts: { planned: limited.length, skipped: skipped.length, review: review.length },
  };
}

/** ---------------- Batch 3B execution: plan ONLY from the approved preflight preview ---------------- */

/**
 * Shape of one approved operation inside `migration-preview.json` (written by
 * the Phase-3B preflight). Required fields are checked structurally; anything
 * missing or out of order is a hard blocker, never filled in.
 */
interface PreviewOp {
  entity_id?: unknown;
  predicate?: unknown;
  value?: unknown;
  valid_from?: unknown;
  valid_to?: unknown;
  source_ids?: unknown;
  confidence?: unknown;
  claim_id?: unknown;
  fingerprint?: unknown;
  classification?: unknown;
  status?: unknown;
  temporal?: unknown;
  provenance?: unknown;
  source_field?: unknown;
  source_file?: unknown;
  canonical_value?: unknown;
  operation_type?: unknown;
}

export interface PreviewValidation {
  /** Approval facts measured from the preview file itself. */
  approved: number;
  classifications: Record<string, number>;
  unique_entity_ids: number;
  unique_fingerprints: number;
  /** Hard blockers (each one means STOP, §5–§8 of the Phase-3B execution spec). */
  invalid_ops: number;
  duplicate_fingerprints: number;
  fingerprint_mismatches: number;
  claim_id_mismatches: number;
  deferred_or_unknown_classification: number;
  /** Runtime conflicts found between the preview and the live vault. */
  entity_missing: number;
  file_changed_since_preview: number;
  conflicting_claims: number;
}

/** Current-claim check — same rule the graph service uses. */
const claimOpen = (claim: Claim): boolean =>
  claim.valid_to === null && (claim.status === undefined || claim.status === 'current' || claim.status === 'disputed');

const previewBlocker = (errors: string[], review: Phase3Plan['review'], entityId: string, file: string | undefined, detail: string): void => {
  errors.push(`${entityId}: ${detail}`);
  review.push({ entity_id: entityId, ...(file === undefined ? {} : { file }), detail: `preview authorization: ${detail}` });
};

/**
 * Phase 3B planner. The preflight preview is authoritative: this function
 * validates the preview (schema, classification, fingerprint, claim id),
 * re-derives the current entity revision and conflict state at plan time, and
 * returns exactly the approved ops — it never re-scans the vault for
 * candidates and never invents an op (§1/§2/§4 of the Phase-3B execution
 * spec). Any preview inconsistency or live conflict lands in
 * `preview_errors`; `applyStage` refuses to write while that list is
 * non-empty.
 */
export async function planClaimsFromPreview(services: Services, opts: Phase3Opts & { previewPath: string }): Promise<Phase3Plan> {
  const { readFile } = await import('node:fs/promises');
  let preview: { ops?: PreviewOp[] };
  try {
    preview = JSON.parse(await readFile(opts.previewPath, 'utf8')) as { ops?: PreviewOp[] };
  } catch (error) {
    throw new MemoryError('VALIDATION_ERROR', `approved preview cannot be read or parsed: ${opts.previewPath} (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!Array.isArray(preview.ops) || preview.ops.length === 0) {
    throw new MemoryError('VALIDATION_ERROR', `approved preview holds no ops array: ${opts.previewPath}`);
  }
  const errors: string[] = [];
  const review: Phase3Plan['review'] = [];
  const skipped: Phase3Plan['skipped'] = [];
  const ops: Phase3Op[] = [];
  const classifications: Record<string, number> = {};
  const seenFingerprints = new Set<string>();
  const entityIds = new Set<string>();
  for (const raw of preview.ops) {
    const entityId = typeof raw.entity_id === 'string' ? raw.entity_id : '';
    const predicate = typeof raw.predicate === 'string' ? raw.predicate.trim() : '';
    const file = typeof raw.source_file === 'string' ? raw.source_file : undefined;
    entityIds.add(entityId);
    // Classification gate (§4.4/§4.5): only SAFE_CLAIM may pass.
    const cls = typeof raw.classification === 'string' ? raw.classification : '<missing>';
    classifications[cls] = (classifications[cls] ?? 0) + 1;
    if (cls !== 'SAFE_CLAIM') {
      previewBlocker(errors, review, entityId, file, `classification ${cls} is not SAFE_CLAIM — deferred candidate must not migrate`);
      continue;
    }
    // Structural gate (§6): every field the Claim model requires, present and well-typed.
    const invalid: string[] = [];
    if (!entityId) invalid.push('entity_id missing');
    if (!predicate) invalid.push('predicate missing');
    if (raw.value === undefined) invalid.push('value missing');
    if (typeof raw.valid_from !== 'string' || raw.valid_from !== '') invalid.push('valid_from must be "" (unknown temporality, §6 semantics)');
    if (raw.valid_to !== null) invalid.push('valid_to must be null (open window)');
    if (!Array.isArray(raw.source_ids)) invalid.push('source_ids must be an array');
    if (Array.isArray(raw.source_ids) && raw.source_ids.length > 0) invalid.push('source_ids must be empty — Phase 3B invents no Source entities (§10)');
    if (Array.isArray(raw.source_ids) && raw.source_ids.some((id) => typeof id !== 'string')) invalid.push('source_ids must hold strings only');
    if (typeof raw.confidence !== 'number') invalid.push('confidence must be a number');
    if (typeof raw.claim_id !== 'string') invalid.push('claim_id missing');
    if (typeof raw.fingerprint !== 'string') invalid.push('fingerprint missing');
    if (raw.canonical_value !== undefined && canonicalJson(raw.canonical_value) !== canonicalJson(raw.value)) invalid.push('canonical_value and value diverge');
    if (raw.status !== undefined && raw.status !== null) invalid.push('status must be null (omitted = current; entity status is never mapped, §11)');
    if (raw.temporal !== undefined && raw.temporal !== 'unknown') invalid.push('temporal must be "unknown"');
    if (raw.operation_type !== undefined && raw.operation_type !== 'claim_changeset_op') invalid.push(`unexpected operation_type ${String(raw.operation_type)}`);
    if (invalid.length) {
      previewBlocker(errors, review, entityId, file, `op invalid (§6): ${invalid.join(', ')}`);
      continue;
    }
    const value = raw.value as unknown;
    // Fingerprint gate (§7): recompute with the exact Phase-3 canonicalization.
    const fingerprint = opFingerprint({ stage: 'claims', kind: 'claim', entity_id: entityId, predicate, value, valid_from: '' });
    if (raw.fingerprint !== fingerprint) {
      previewBlocker(errors, review, entityId, file, 'fingerprint mismatch against live recomputation');
      continue;
    }
    // Identity gate (§7/preview model): the preview claim id must derive from the same identity.
    const expectedClaimId = `p3c-${createHash('sha256').update(`${entityId}|${claimKey({ predicate, value, valid_to: null })}`).digest('hex').slice(0, 20)}`;
    if (raw.claim_id !== expectedClaimId) {
      previewBlocker(errors, review, entityId, file, 'claim_id mismatch against identity-derivation');
      continue;
    }
    // Duplicate-fingerprint gate (§6): a fingerprint may appear exactly once.
    if (seenFingerprints.has(fingerprint)) {
      previewBlocker(errors, review, entityId, file, 'duplicate fingerprint inside the preview');
      continue;
    }
    seenFingerprints.add(fingerprint);
    // Ledger-first precedence (same guard as 3A): an applied fingerprint is never written twice.
    if (await opts.ledger.statusOf(fingerprint) === 'applied') {
      skipped.push({ fingerprint, entity_id: entityId, reason: 'already_applied' });
      continue;
    }
    // Live-vault gates (§12/§13): entity still exists, identity unchanged.
    let entity: Entity;
    try {
      entity = await services.memory.get(entityId);
    } catch {
      previewBlocker(errors, review, entityId, file, 'entity missing — preview no longer applicable');
      continue;
    }
    if (file !== undefined && entity.path !== file) {
      previewBlocker(errors, review, entityId, file, `entity file changed since preflight (now ${entity.path})`);
      continue;
    }
    // Existing-claim gate (§13): identical open claim → idempotent skip; same predicate with a
    // different current value → hard stop for the whole batch, never auto-resolved.
    const identical = normalizeClaims(entity.metadata).some(claim =>
      claim.predicate === predicate && claimOpen(claim) && claimKey(claim) === claimKey({ predicate, value, valid_to: null }));
    if (identical) { skipped.push({ fingerprint, entity_id: entityId, reason: 'already_claimed' }); continue; }
    const conflicting = normalizeClaims(entity.metadata).some(claim =>
      claimOpen(claim) && claim.predicate === predicate && claimKey(claim) !== claimKey({ predicate, value, valid_to: null }));
    if (conflicting) {
      previewBlocker(errors, review, entityId, file, `live conflict: current claim for ${predicate} holds a different value — §13 stop, never overwritten`);
      continue;
    }
    ops.push({
      kind: 'claim', entity_id: entityId, expected_revision: entity.revision,
      predicate, value, valid_from: '', claim_id: raw.claim_id as string,
      source_ids: raw.source_ids as string[],
      confidence: raw.confidence as number,
      timestamp: opts.migrationTime,
      fingerprint, file: entity.path,
      evidence: `${file}: frontmatter ${predicate} = ${JSON.stringify(value).slice(0, 120)} (${typeof raw.provenance === 'string' ? raw.provenance : 'provenance unknown'})`,
    });
  }
  const limited = opts.limit ? ops.slice(0, opts.limit) : ops;
  return {
    stage: 'claims', migration_time: opts.migrationTime, file_count: entityIds.size,
    planned_hash: planHash(limited, skipped),
    ops: limited, skipped, review,
    counts: { planned: limited.length, skipped: skipped.length, review: review.length },
    preview_errors: errors,
    preview_validation: {
      approved: preview.ops.length,
      classifications,
      unique_entity_ids: entityIds.size,
      unique_fingerprints: seenFingerprints.size,
      invalid_ops: errors.filter((entry) => entry.includes('op invalid')).length,
      duplicate_fingerprints: errors.filter((entry) => entry.includes('duplicate fingerprint')).length,
      fingerprint_mismatches: errors.filter((entry) => entry.includes('fingerprint mismatch')).length,
      claim_id_mismatches: errors.filter((entry) => entry.includes('claim_id mismatch')).length,
      deferred_or_unknown_classification: errors.filter((entry) => entry.includes('is not SAFE_CLAIM')).length,
      entity_missing: errors.filter((entry) => entry.includes('entity missing')).length,
      file_changed_since_preview: errors.filter((entry) => entry.includes('file changed since preflight')).length,
      conflicting_claims: errors.filter((entry) => entry.includes('live conflict')).length,
    },
  };
}

export async function planSources(services: Services, opts: Phase3Opts): Promise<Phase3Plan> {
  let fileCount = 0;
  const ops: Phase3Op[] = [];
  const skipped: Phase3Plan['skipped'] = [];
  const review: Phase3Plan['review'] = [];
  for await (const entity of services.storage.scan()) {
    fileCount++;
    const provider = typeof entity.metadata.provider === 'string' ? entity.metadata.provider.trim().toLowerCase() : '';
    const conversationId = typeof entity.metadata.conversation_id === 'string' ? entity.metadata.conversation_id.trim() : '';
    if (!provider || !conversationId) {
      if (provider || conversationId)
        review.push({ entity_id: entity.metadata.id, file: entity.path, detail: 'source identity incomplete (provider and conversation_id must both be present)' });
      continue;
    }
    const existing = await services.index.findSources({ provider, conversation_id: conversationId });
    if (existing.length) { skipped.push({ fingerprint: `src:${provider}/${conversationId}`, entity_id: existing[0]!.metadata.id, reason: 'source_exists' }); continue; }
    const fingerprint = opFingerprint({ stage: 'sources', kind: 'create_source', provider, conversation_id: conversationId });
    if (await opts.ledger.statusOf(fingerprint) === 'applied') { skipped.push({ fingerprint, entity_id: entity.metadata.id, reason: 'already_applied' }); continue; }
    const draft: EntityDraft = {
      type: 'source', title: `${provider} conversation ${conversationId}`,
      metadata: { provider, conversation_id: conversationId, derived_from: entity.metadata.id, origin_file: entity.path },
    };
    ops.push({ kind: 'create', draft, fingerprint, file: entity.path, evidence: `${entity.path}: provider ${provider} + conversation_id ${conversationId}` });
  }
  const limited = opts.limit ? ops.slice(0, opts.limit) : ops;
  return {
    stage: 'sources', migration_time: opts.migrationTime, file_count: fileCount,
    planned_hash: planHash(limited, skipped),
    ops: limited, skipped, review,
    counts: { planned: limited.length, skipped: skipped.length, review: review.length },
  };
}

/** ---------------- Batch 3C execution: web-provenance sources from the approved preview ---------------- */

/** Shape of one approved operation inside `source-migration-preview.json`
 * (written by the Phase-3C preflight). */
interface SourcePreviewOp {
  entity_id?: unknown;
  source_candidate?: unknown;
  classification?: unknown;
  reason?: unknown;
  fingerprint?: unknown;
}

export interface SourcePreviewValidation {
  approved: number;
  classifications: Record<string, number>;
  owner_entities: number;
  /** canonical identities the plan creates — one per source (§7) */
  unique_identities: number;
  unique_execution_fingerprints: number;
  /** authorization-side fingerprints, recomputed and matched against the preflight */
  preview_fingerprints_verified: number;
  invalid_ops: number;
  fingerprint_mismatches: number;
  duplicate_identities: number;
  deferred_or_unknown_classification: number;
  owner_missing: number;
  already_existing_sources: number;
}

/**
 * Phase-3C execution planner. `source-migration-preview.json` is the ONLY
 * authorization source (§11): the plan derives exactly the operations whose
 * preflight classification is `REVIEW` — the set the user approved — by
 * re-verifying each preview fingerprint against its live recomputation. It
 * never re-scans the vault for candidates and never invents an op. Unsafe
 * and deferred classifications hard-block (§15/§18/§24).
 *
 * Each op maps to VARIANTA B typed identity: (provider='web', 'url',
 * trimmed canonical URL) — the preflight's `conversation_id` slot only ever
 * holds the URL for the preview fingerprint's recomputation (§2/§4); no
 * created source carries a conversation_id. Creation fingerprints are a
 * separate namespace `{provider, identity_type, identity_value}` from the
 * preview-authorization fingerprints (§13).
 */
export async function planSourcesFromPreview(services: Services, opts: Phase3Opts & { previewPath: string }): Promise<Phase3Plan> {
  const { readFile } = await import('node:fs/promises');
  let preview: { ops?: SourcePreviewOp[] };
  try {
    preview = JSON.parse(await readFile(opts.previewPath, 'utf8')) as { ops?: SourcePreviewOp[] };
  } catch (error) {
    throw new MemoryError('VALIDATION_ERROR', `approved source preview cannot be read or parsed: ${opts.previewPath} (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!Array.isArray(preview.ops) || preview.ops.length === 0) {
    throw new MemoryError('VALIDATION_ERROR', `approved source preview holds no ops array: ${opts.previewPath}`);
  }
  const errors: string[] = [];
  const review: Phase3Plan['review'] = [];
  const skipped: Phase3Plan['skipped'] = [];
  const ops: Phase3Op[] = [];
  const classifications: Record<string, number> = {};
  const seenExecFingerprints = new Set<string>();
  const seenIdentities = new Set<string>();
  const ownerIds = new Set<string>();
  let fingerprintsVerified = 0;
  let alreadyExisting = 0;
  for (const raw of preview.ops) {
    const ownerId = typeof raw.entity_id === 'string' ? raw.entity_id : '';
    const candidate = (typeof raw.source_candidate === 'object' && raw.source_candidate !== null ? raw.source_candidate : {}) as Record<string, unknown>;
    const provider = typeof candidate.provider === 'string' ? candidate.provider.trim().toLowerCase() : '';
    const previewUrl = typeof candidate.conversation_id === 'string' ? candidate.conversation_id : '';
    ownerIds.add(ownerId);
    // Classification gate (§11): only the user-approved REVIEW web-provenance
    // set may migrate. The preflight preview legitimately also carries the
    // 7 UNSAFE deferred candidates (§18) — they are recorded as deferred
    // review entries, never blockers and never ops. A missing/unexpected
    // classification means the preview no longer matches its preflight shape
    // and stays a hard blocker.
    const cls = typeof raw.classification === 'string' ? raw.classification : '<missing>';
    classifications[cls] = (classifications[cls] ?? 0) + 1;
    if (cls !== 'REVIEW') {
      if (cls === 'UNSAFE' || cls === 'DEFERRED') {
        review.push({ entity_id: ownerId, detail: `classification ${cls} — deferred candidate, not in the approved set (§18), skipped` });
        continue;
      }
      previewBlocker(errors, review, ownerId, undefined, `classification ${cls} is not REVIEW — the preview does not match its preflight shape`);
      continue;
    }
    // Structural gate (§2/§4/§12/§14): the preview op is a web-provenance URL
    // candidate, with the URL in the conversation_id slot ONLY as the
    // preflight's authorization fingerprint input.
    const invalid: string[] = [];
    if (!ownerId) invalid.push('entity_id missing');
    if (provider !== 'web') invalid.push(`provider must be 'web', got '${provider}'`);
    if (!looksLikeHttpUrl(canonicalizeUrl(previewUrl))) invalid.push('source_candidate.conversation_id must hold an http(s) URL (the preview identity slot)');
    if (candidate.content_hash !== null) invalid.push('source_candidate.content_hash must be null');
    if (typeof candidate.url !== 'string' || candidate.url !== previewUrl) invalid.push('source_candidate.url must equal the candidate identity URL');
    if (invalid.length) {
      previewBlocker(errors, review, ownerId, undefined, `op invalid (§12): ${invalid.join(', ')}`);
      continue;
    }
    // Authorization-fingerprint gate (§11/§13): recompute the preflight's
    // fingerprint (VARIANTA-A slot shape) — this is what authorizes the op.
    const previewFingerprint = opFingerprint({ stage: 'sources', kind: 'create_source', provider, conversation_id: previewUrl });
    if (raw.fingerprint !== previewFingerprint) {
      previewBlocker(errors, review, ownerId, undefined, 'fingerprint mismatch against live recomputation');
      continue;
    }
    fingerprintsVerified++;
    // Execution identity (§4/§5): VARIANTA B typed triple. URL canonicalization
    // is minimal (§6): surrounding whitespace only.
    const identityValue = canonicalizeUrl(previewUrl);
    const executionFingerprint = opFingerprint({ stage: 'sources', kind: 'create_source', provider, identity_type: 'url', identity_value: identityValue });
    const identity = `${provider}|url|${identityValue}`;
    if (seenIdentities.has(identity)) {
      previewBlocker(errors, review, ownerId, undefined, 'duplicate canonical identity inside the preview');
      continue;
    }
    seenIdentities.add(identity);
    if (seenExecFingerprints.has(executionFingerprint)) {
      previewBlocker(errors, review, ownerId, undefined, 'duplicate fingerprint inside the preview');
      continue;
    }
    seenExecFingerprints.add(executionFingerprint);
    // Ledger-first precedence: an applied fingerprint is never written twice.
    if (await opts.ledger.statusOf(executionFingerprint) === 'applied') {
      skipped.push({ fingerprint: executionFingerprint, entity_id: ownerId, reason: 'already_applied' });
      continue;
    }
    // Live gates: the owner entity must still exist; the source must not
    // already exist under the canonical identity (§7/§21).
    let owner: Entity;
    try {
      owner = await services.memory.get(ownerId);
    } catch {
      previewBlocker(errors, review, ownerId, undefined, 'owner entity missing — preview no longer applicable');
      continue;
    }
    const existing = await services.index.findSources({ provider, identity_type: 'url', identity_value: identityValue });
    if (existing.length) { skipped.push({ fingerprint: executionFingerprint, entity_id: existing[0]!.metadata.id, reason: 'source_exists' }); alreadyExisting++; continue; }
    ops.push({
      kind: 'create',
      entity_id: ownerId,
      draft: {
        type: 'source',
        title: `${provider}: ${identityValue}`,
        metadata: {
          id: sourceEntityId(provider, 'url', identityValue),
          provider,
          identity_type: 'url',
          identity_value: identityValue,
          url: identityValue,
          created_at: opts.migrationTime,
          updated_at: opts.migrationTime,
          derived_from: ownerId,
          origin_file: owner.path,
        },
      },
      identity_type: 'url',
      identity_value: identityValue,
      source_url: identityValue,
      fingerprint: executionFingerprint,
      file: owner.path,
      evidence: `${owner.path}: source_url provenance → web source (url identity, VARIANTA B): ${identityValue}`,
    });
  }
  const limited = opts.limit ? ops.slice(0, opts.limit) : ops;
  return {
    stage: 'sources', migration_time: opts.migrationTime, file_count: ownerIds.size,
    planned_hash: planHash(limited, skipped),
    ops: limited, skipped, review,
    counts: { planned: limited.length, skipped: skipped.length, review: review.length },
    preview_errors: errors,
    preview_validation: {
      approved: preview.ops.length,
      classifications,
      owner_entities: ownerIds.size,
      unique_identities: seenIdentities.size,
      unique_execution_fingerprints: seenExecFingerprints.size,
      preview_fingerprints_verified: fingerprintsVerified,
      invalid_ops: errors.filter((entry) => entry.includes('op invalid')).length,
      fingerprint_mismatches: errors.filter((entry) => entry.includes('fingerprint mismatch')).length,
      duplicate_identities: errors.filter((entry) => entry.includes('duplicate canonical identity')).length,
      deferred_or_unknown_classification: (classifications['UNSAFE'] ?? 0) + (classifications['DEFERRED'] ?? 0),
      owner_missing: errors.filter((entry) => entry.includes('owner entity missing')).length,
      already_existing_sources: alreadyExisting,
    },
  };
}

/** Deterministic source entity id: identity-derived (never wall-clock), so a
 * rollback/re-apply cycle recreates the same file bytes. */
const sourceEntityId = (provider: string, identityType: string, identityValue: string): string =>
  `p3s-${createHash('sha256').update(`${provider}|${identityType}|${identityValue}`).digest('hex').slice(0, 20)}`;

export function planStage(services: Services, opts: Phase3Opts): Promise<Phase3Plan> {
  switch (opts.stage) {
    case 'relations': return planRelations(services, opts);
    case 'claims': return opts.previewPath ? planClaimsFromPreview(services, opts as Phase3Opts & { previewPath: string }) : planClaims(services, opts);
    case 'sources': return opts.previewPath ? planSourcesFromPreview(services, opts as Phase3Opts & { previewPath: string }) : planSources(services, opts);
  }
}

/** ---------------- Apply ---------------- */

export interface ApplyResult {
  stage: Phase3Stage;
  planned_hash: string;
  planned: number;
  applied: number;
  skipped: number;
  failed: null | { op: Phase3Op; error: string; compensated: number };
  changeset_ids: string[];
  migration_id: string;
  migration_time: string;
}

/**
 * Applies one stage as a single changeset: all-or-nothing via the compensating
 * apply path, deterministic ids, and a ledger entry per op. A failure aborts
 * the batch (compensation restores what was written) and is reported.
 */
export async function applyStage(services: Services, opts: Phase3Opts, dryRun = false): Promise<{ plan: Phase3Plan; result?: ApplyResult }> {
  // Authorization guard (Phase-3B §4 / Phase-3C §11): the claim and source
  // stages are driven ONLY by the approved preflight previews. The generic
  // planners never authorize a migration.
  if ((opts.stage === 'claims' || opts.stage === 'sources') && !opts.previewPath) {
    throw new MemoryError('VALIDATION_ERROR', `${opts.stage} stage requires --preview: the approved migration preview is the only authorization source for claim/source migration`);
  }
  const migrationId = `phase-3-${opts.stage}-${opts.migrationTime}`;
  const plan = await planStage(services, opts);
  if (dryRun) return { plan };
  // Stop before the first write if any preview gate failed (§13/§17): the
  // batch is all-or-nothing — no changeset is created while blockers exist.
  if (plan.preview_errors?.length) {
    throw new MemoryError('VALIDATION_ERROR', `preview validation failed (${plan.preview_errors.length} blockers): ${plan.preview_errors.slice(0, 5).join('; ')}`);
  }
  // The ledger handed in via opts is authoritative — apply/plan/rollback/
  // validate must all read and write the same file.
  const { maintenance } = services;
  const migrationLedger = opts.ledger;
  let failed: ApplyResult['failed'] = null;
  const changesetIds: string[] = [];
  let applied = 0;
  // One changeset per source file so same-file operations chain revisions
  // inside maintenance.apply; batch-level all-or-nothing comes from the
  // compensating executor plus the rollback mode over the ledger.
  const groups = new Map<string, Phase3Op[]>();
  for (const op of plan.ops) {
    if (await migrationLedger.statusOf(op.fingerprint) === 'applied') continue;
    groups.set(op.file, [...(groups.get(op.file) ?? []), op]);
  }
  for (const [file, ops] of groups) {
    const prepared = await maintenance.prepare(`Phase-3 ${opts.stage}: ${file} (${ops.length} op)`, ops, []);
    changesetIds.push(prepared.id);
    try {
      await maintenance.apply(prepared.id, 'phase-3-migration');
      for (const op of ops) {
        applied++;
        const entry: LedgerEntry = {
          migration_id: migrationId, stage: opts.stage,
          source_file: op.file, operation_type: op.kind === 'create' && op.draft?.type === 'source' ? 'create_source' : op.kind,
          fingerprint: op.fingerprint, status: 'applied',
          timestamp: new Date().toISOString(), changeset_id: prepared.id,
          details: {
            entity_id: op.entity_id, relation_id: op.relation_id, claim_id: op.claim_id, target_id: op.target_id, predicate: op.predicate, revision: op.expected_revision,
            // Source creates carry the deterministic entity id so rollback can
            // locate (and remove) the created file (§27).
            ...(op.kind === 'create' && op.draft?.type === 'source' ? {
              source_id: typeof op.draft.metadata?.id === 'string' ? op.draft.metadata.id : undefined,
              provider: op.draft.metadata?.provider,
              identity_type: op.identity_type,
              identity_value: op.identity_value,
              source_url: op.source_url,
              created_source_status: 'created',
            } : {}),
          },
        };
        await migrationLedger.record(entry);
      }
    } catch (error) {
      failed = { op: ops[0]!, error: error instanceof Error ? (error.stack ?? error.message) : String(error), compensated: 0 };
      break;
    }
  }
  return {
    plan,
    result: {
      stage: opts.stage, planned_hash: plan.planned_hash, planned: plan.counts.planned,
      applied, skipped: plan.counts.skipped, failed, changeset_ids: changesetIds,
      migration_id: migrationId, migration_time: opts.migrationTime,
    },
  };
}
/** ---------------- Rollback (§25) ---------------- */

export interface RollbackResult {
  stage: Phase3Stage;
  attempted: number;
  rolled_back: number;
  lost: Array<{ fingerprint: string; reason: string }>;
  errors: string[];
}

/**
 * Rolls back every ledger entry of the stage whose newest status is
 * `applied`, in reverse application order, by restoring each migration op's
 * before-snapshot through the canonical prepareRollback/apply path (so the
 * rollback itself is audited).
 */
export async function rollbackStage(services: Services, opts: Phase3Opts): Promise<RollbackResult> {
  const entries = await opts.ledger.all();
  const latest = new Map<string, LedgerEntry>();
  for (const entry of entries) if (entry.stage === opts.stage) latest.set(entry.fingerprint, entry);
  const active = [...latest.values()]
    .filter(entry => entry.status === 'applied')
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .reverse();
  const errors: string[] = [];
  const lost: RollbackResult['lost'] = [];
  let rolledBack = 0;
  for (const entry of active) {
    // Phase-3C source creates are not snapshot-restorable — the created file
    // itself must disappear (§27: byte-identical rollback manifest). The
    // restricted 'delete' changeset kind is the only compensating path, and
    // its maintenance validation limits it to migration-created sources.
    const sourceId = entry.details?.source_id;
    if (entry.stage === 'sources' && typeof sourceId === 'string') {
      try {
        const cs = await services.maintenance.prepare(`Phase-3 ${opts.stage} rollback: source ${sourceId}`, [{ kind: 'delete', entity_id: sourceId }], []);
        await services.maintenance.apply(cs.id, 'phase-3-rollback');
        await opts.ledger.record({ ...entry, status: 'rolled_back', timestamp: new Date().toISOString(), changeset_id: cs.id });
        rolledBack++;
      } catch (error) { errors.push(`${entry.fingerprint}: ${error instanceof Error ? error.message : String(error)}`); }
      continue;
    }
    const entityId = typeof entry.details?.entity_id === 'string' ? entry.details.entity_id : undefined;
    const events = entityId ? await services.audit.list(entityId, 10000) : [];
    const det = entry.details;
    const event = det === undefined ? undefined : events.find(item =>
      (item.operation === 'create_relation' || item.operation === 'create_claim') &&
      item.client === 'phase-3-migration' &&
      item.details !== undefined &&
      (det.relation_id !== undefined ? item.details.relation_id === det.relation_id : item.details.claim_id === det.claim_id));
    if (!event) { lost.push({ fingerprint: entry.fingerprint, reason: 'migration audit event not found' }); continue; }
    try {
      const cs = await services.maintenance.prepareRollback(event.id);
      await services.maintenance.apply(cs.id, 'phase-3-rollback');
      await opts.ledger.record({ ...entry, status: 'rolled_back', timestamp: new Date().toISOString(), changeset_id: cs.id });
      rolledBack++;
    } catch (error) { errors.push(`${entry.fingerprint}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return { stage: opts.stage, attempted: active.length, rolled_back: rolledBack, lost, errors };
}

/** ---------------- Post-migration validation (§24) ---------------- */

export interface StageValidation {
  stage: Phase3Stage;
  file_count: number;
  relation_edges: number;
  claim_count: number;
  duplicate_identities: Array<{ path: string; identity: string }>;
  migrated_relations: {
    expected: number;
    found: number;
    /** Migrated relations that are no longer present but whose removal is provably
     * backed by an audited delete_relation event. Migration history stays intact. */
    intentionally_deleted: Array<{ entity_id: string; relation_id: string; audit_event_id: string; deleted_at: string; deleted_by?: string }>;
    missing: Array<{ entity_id: string; relation_id: string }>;
  };
  migrated_claims: { expected: number; found: number; missing: Array<{ entity_id: string; claim_id: string }> };
  markers_missing: number;
  legacy_shim_preserved: number;
  resolver: { id: boolean; title: boolean; alias: boolean; path: boolean; broken_path_is_empty: boolean; path_collision_ambiguous: boolean };
  /** Which pair the §24F resolver probe actually exercised. An archived pair is
   * never silently substituted: the probe reports no_valid_active_probe instead. */
  resolver_probe: { status: 'active' | 'no_valid_active_probe'; source_id?: string; target_id?: string };
}

export async function validateStage(services: Services, opts: Phase3Opts): Promise<StageValidation> {
  await services.maintenance.reindex();
  const entries = await opts.ledger.all();
  const latest = new Map<string, LedgerEntry>();
  for (const entry of entries) if (entry.stage === opts.stage) latest.set(entry.fingerprint, entry);
  const applied = [...latest.values()].filter(entry => entry.status === 'applied');

  let fileCount = 0;
  let edges = 0;
  let claims = 0;
  const duplicateIdentities: StageValidation['duplicate_identities'] = [];
  const relationIds = new Map<string, { entity: Entity; ids: Set<string> }>();
  const statusById = new Map<string, string>();
  for await (const entity of services.storage.scan()) {
    fileCount++;
    statusById.set(entity.metadata.id, entity.metadata.status);
    const structured = structuredRelations(entity.metadata);
    edges += normalizedCount(entity);
    claims += normalizeClaims(entity.metadata).length;
    // A structured entry and a legacy entry with the same identity must not
    // coexist on any migrated entity (§24C — the legacy copy collapses).
    const legacyKey = (entry: { type?: unknown; target_id?: unknown }) => `${String(entry.type)}|${String(entry.target_id)}`;
    const structuredKeys = new Set(structured.map(edge => relationIdentity(edge)));
    for (const raw of Array.isArray(entity.metadata.relationships) ? entity.metadata.relationships : []) {
      const key = legacyKey(raw as { type?: unknown; target_id?: unknown });
      if (structuredKeys.has(key)) duplicateIdentities.push({ path: entity.path, identity: key });
    }
    const ids = new Set(structured.map(edge => edge.id));
    relationIds.set(entity.metadata.id, { entity, ids });
  }
  const migratedRelations = {
    expected: 0,
    found: 0,
    intentionally_deleted: [] as StageValidation['migrated_relations']['intentionally_deleted'],
    missing: [] as StageValidation['migrated_relations']['missing'],
  };
  /**
   * The migration ledger is migration history; the audit log is the history of
   * later mutations. A migrated relation that is no longer in the vault is only
   * excused when an audited delete_relation event provably removed exactly this
   * (entity_id, relation_id) pair after the migration. target_id is never used as
   * the match key, because merge_entities remaps relation targets while keeping
   * the relation id. Anything that does not satisfy every condition stays missing.
   */
  const auditedDeletion = async (entityId: string, relationId: string, migratedAt: string): Promise<AuditEvent | undefined> => {
    for (const event of await services.audit.list(entityId, 200)) {
      if (event.operation !== 'delete_relation') continue;
      if (event.entity_id !== entityId) continue;
      if (String(event.details?.relation_id) !== relationId) continue;
      if (!(event.timestamp > migratedAt)) continue;
      const before = event.before_snapshot ? await services.audit.readSnapshot(event.id, 'before') : undefined;
      const after = event.after_snapshot ? await services.audit.readSnapshot(event.id, 'after') : undefined;
      if (!before || !after) continue;
      const had = structuredRelations(before.metadata).some(edge => edge.id === relationId);
      const has = structuredRelations(after.metadata).some(edge => edge.id === relationId);
      if (had && !has) return event;
    }
    return undefined;
  };
  const migratedClaims = { expected: 0, found: 0, missing: [] as StageValidation['migrated_claims']['missing'] };
  let markersMissing = 0;
  for (const entry of applied) {
    const entityId = typeof entry.details?.entity_id === 'string' ? entry.details.entity_id : undefined;
    const holder = entityId ? relationIds.get(entityId) : undefined;
    if (entry.stage === 'relations' && entry.details?.relation_id) {
      migratedRelations.expected++;
      const id = String(entry.details.relation_id);
      if (holder?.entity && [...holder.ids].includes(id)) {
        migratedRelations.found++;
        if (!holder.entity.content.includes(`rel:${id}`)) markersMissing++;
      } else {
        const deletion = entityId ? await auditedDeletion(entityId, id, entry.timestamp) : undefined;
        if (deletion) {
          migratedRelations.intentionally_deleted.push({
            entity_id: String(entityId),
            relation_id: id,
            audit_event_id: deletion.id,
            deleted_at: deletion.timestamp,
            ...(deletion.client ? { deleted_by: deletion.client } : {}),
          });
        } else migratedRelations.missing.push({ entity_id: String(entityId), relation_id: id });
      }
    }
    if (entry.stage === 'claims' && entry.details?.claim_id) {
      migratedClaims.expected++;
      const id = String(entry.details.claim_id);
      const entityClaims = holder ? normalizeClaims(holder.entity.metadata) : [];
      if (entityClaims.some(claim => claim.id === id)) migratedClaims.found++;
      else migratedClaims.missing.push({ entity_id: String(entityId), claim_id: id });
    }
  }
  // Resolver checks against a real migrated source/target pair (§24F).
  // Basename probe: if two indexed entities share a file basename, path
  // resolution of that basename must report ambiguous, not silently pick.
  let collisionProbe: string | undefined;
  {
    const basenames = new Map<string, number>();
    for (const [_id, holder] of relationIds) {
      // The collision population must match the visibility used by resolveLookup
      // below (default: archived entities are not resolvable candidates).
      if (holder.entity.metadata.status === 'archived') continue;
      const base = (holder.entity.path.replace(/\.md$/i, '').split('/').at(-1) ?? '').toLocaleLowerCase();
      if (base) basenames.set(base, (basenames.get(base) ?? 0) + 1);
    }
    for (const [base, count] of basenames) if (count > 1) { collisionProbe = base; break; }
  }
  // §24F probe: only a pair whose endpoints are both non-archived can be resolved
  // by the default (archived-hiding) resolver. An archived pair is never used as a
  // fallback, and include_archived is never passed here.
  const isActiveEndpoint = (id: unknown): boolean => {
    const status = statusById.get(String(id));
    return status !== undefined && status !== 'archived';
  };
  const first = applied.find(entry => entry.stage === 'relations' && entry.details?.target_id
    && isActiveEndpoint(entry.details.entity_id) && isActiveEndpoint(entry.details.target_id));
  let resolver = { id: false, title: false, alias: false, path: false, broken_path_is_empty: false, path_collision_ambiguous: false };
  if (first) {
    const sourceId = String(first.details!.entity_id);
    const targetId = String(first.details!.target_id);
    const source = await services.memory.get(sourceId);
    const target = await services.memory.get(targetId);
    const byId = await services.graph.resolve({ query: sourceId }) as { resolved?: { id: string } };
    const byTitle = await services.graph.resolve({ query: target.metadata.title }) as { ambiguous: boolean; resolved?: { id: string } };
    const byPath = await services.graph.resolve({ query: target.path.replace(/\.md$/i, '') }) as { resolved?: { id: string } };
    const byAlias = await services.graph.resolve({ query: source.metadata.aliases[0] ?? target.metadata.title }) as { ambiguous: boolean; resolved?: { id: string } };
    // A title shared by several entities legitimately reports ambiguous.
    const broken = await services.graph.resolve({ query: 'phase-3-probe-definitely-missing-entity' }) as { resolved?: unknown; candidates: unknown[] };
    resolver = {
      id: byId.resolved?.id === sourceId,
      title: byTitle.resolved?.id === targetId,
      alias: source.metadata.aliases.length === 0 || byAlias.resolved?.id === sourceId,
      path: byPath.resolved?.id === targetId,
      broken_path_is_empty: !broken.resolved && (broken.candidates as unknown[]).length === 0,
      path_collision_ambiguous: collisionProbe === undefined ? false : (((await services.index.resolveLookup(collisionProbe)) as { match?: string }[]).filter(c => c.match === 'path').length > 1),
    };
  }
  return {
    stage: opts.stage, file_count: fileCount, relation_edges: edges, claim_count: claims,
    duplicate_identities: duplicateIdentities,
    migrated_relations: migratedRelations, migrated_claims: migratedClaims, markers_missing: markersMissing,
    legacy_shim_preserved: fileCount,
    resolver,
    resolver_probe: first
      ? { status: 'active', source_id: String(first.details!.entity_id), target_id: String(first.details!.target_id) }
      : { status: 'no_valid_active_probe' },
  };
}

const normalizedCount = (entity: Entity): number => {
  // structured + legacy-without-structured-duplicate, per the read shim
  const structured = structuredRelations(entity.metadata);
  const keys = new Set(structured.map(edge => relationIdentity(edge)));
  let legacyOnly = 0;
  for (const raw of Array.isArray(entity.metadata.relationships) ? entity.metadata.relationships : []) {
    const entry = raw as { type?: unknown; target_id?: unknown };
    if (typeof entry.type === 'string' && typeof entry.target_id === 'string' && !keys.has(`${entry.type}|${entry.target_id}`)) legacyOnly++;
  }
  return structured.length + legacyOnly;
};

/** ---------------- Preflight (§22) ---------------- */

export interface PreflightResult {
  vault_file_count: { count: number; expected: number | null; ok: boolean };
  parse_errors: number;
  baseline_manifest: {
    checked: boolean;
    identical: boolean;
    missing: string[];
    extra: string[];
    changed: string[];
  };
  audit_log: { sha256: string; entry_lines: number; baseline_sha256: string | null; unchanged: boolean | null };
  plan: { planned_hash: string; planned: number; skipped: number; review: number; identities_unique: boolean; targets_resolve: boolean };
  ok: boolean;
}

/** Current vault manifest in the baseline format: `<sha256>  ./<vault-relative path>`. */
export async function vaultManifest(services: Services): Promise<{ text: string; count: number; parse_errors: number }> {
  const lines: string[] = [];
  let count = 0;
  let parse_errors = 0;
  for (const file of await services.storage.inspectFiles()) {
    if (file.error !== undefined) { parse_errors++; continue; }
    count++;
    // strip the internal 'sha256:' prefix so the manifest is plain shasum format
    const revision = file.entity!.revision.replace(/^sha256:/i, '');
    lines.push(`${revision}  ./${file.path}`);
  }
  return { text: `${lines.sort().join('\n')}${lines.length ? '\n' : ''}`, count, parse_errors };
}

/**
 * §22 pre-migration assertions. Vault file count must equal the Phase-2
 * baseline (661), every baseline file hash must match, the audit log must be
 * byte-identical to its Phase-2 snapshot, and the plan must contain no
 * duplicate identities nor unresolvable targets. Read-only — writes nothing.
 */
export async function preflight(services: Services, opts: Phase3Opts, optsFiles?: {
  baselineManifest?: string;
  auditPath?: string;
  baselineAudit?: string;
  expected_count?: number;
}): Promise<PreflightResult> {
  const { readFile } = await import('node:fs/promises');
  const manifest = await vaultManifest(services);
  const expected = typeof optsFiles?.expected_count === 'number' ? optsFiles.expected_count : null;
  const result: PreflightResult = {
    vault_file_count: { count: manifest.count, expected, ok: expected === null || manifest.count === expected },
    parse_errors: manifest.parse_errors,
    baseline_manifest: { checked: false, identical: false, missing: [], extra: [], changed: [] },
    audit_log: { sha256: '', entry_lines: 0, baseline_sha256: null, unchanged: null },
    plan: { planned_hash: '', planned: 0, skipped: 0, review: 0, identities_unique: false, targets_resolve: false },
    ok: false,
  };
  if (optsFiles?.baselineManifest) {
    const baseline = await readFile(optsFiles.baselineManifest, 'utf8').catch(() => '');
    const baseMap = new Map(baseline.split('\n').filter(Boolean).map((line) => {
      const [sha, rest] = line.split('  ', 2) as [string, string];
      return [rest, sha] as const;
    }));
    const nowMap = new Map(manifest.text.split('\n').filter(Boolean).map((line) => {
      const [sha, rest] = line.split('  ', 2) as [string, string];
      return [rest, sha] as const;
    }));
    const missing: string[] = []; const extra: string[] = []; const changed: string[] = [];
    for (const [path, sha] of baseMap) {
      const current = nowMap.get(path);
      if (current === undefined) missing.push(path);
      else if (current !== sha) changed.push(path);
    }
    for (const path of nowMap.keys()) if (!baseMap.has(path)) extra.push(path);
    result.baseline_manifest = {
      checked: true, identical: missing.length === 0 && extra.length === 0 && changed.length === 0,
      missing: missing.sort(), extra: extra.sort(), changed: changed.sort(),
    };
  }
  const planFor = { ...opts, limit: undefined as number | undefined };
  const plan = await planStage(services, planFor);
  result.plan = {
    planned_hash: plan.planned_hash, planned: plan.counts.planned, skipped: plan.counts.skipped, review: plan.counts.review,
    identities_unique: new Set(plan.ops.map(op => op.fingerprint)).size === plan.ops.length,
    targets_resolve: true,
  };
  result.ok =
    result.vault_file_count.ok &&
    manifest.parse_errors === 0 &&
    (!result.baseline_manifest.checked || result.baseline_manifest.identical) &&
    result.plan.identities_unique;

  // §22: the audit log must be byte-identical to its Phase-2 snapshot — the
  // log never changed between phases, and this migration has not written yet.
  const { createHash } = await import('node:crypto');
  const shaOf = async (file: string): Promise<string | null> =>
    readFile(file).then((bytes) => createHash('sha256').update(bytes).digest('hex')).catch(() => null);
  const currentAuditSha = optsFiles?.auditPath ? await shaOf(optsFiles.auditPath) : null;
  const baselineAuditSha = optsFiles?.baselineAudit ? await shaOf(optsFiles.baselineAudit) : null;
  const auditLines = currentAuditSha !== null
    ? await readFile(optsFiles!.auditPath!, 'utf8').then(text => text.split('\n').filter(Boolean).length).catch(() => 0)
    : 0;
  result.audit_log = {
    sha256: currentAuditSha ?? '',
    entry_lines: auditLines,
    baseline_sha256: baselineAuditSha,
    unchanged: currentAuditSha !== null && baselineAuditSha !== null ? currentAuditSha === baselineAuditSha : null,
  };
  if (result.audit_log.unchanged === false) result.ok = false;

  return result;
}
