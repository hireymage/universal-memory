import { mkdir, open, readFile, rename, unlink, writeFile, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { ulid } from 'ulid';
import type { AuditSink, EntityStorage, SearchIndex } from '../ports/index.js';
import type { NeuralAssociativeMemory, NeuralRevisionSnapshot } from '../ports/neural.js';
import type { ChangeOperation, Entity } from '../domain/types.js';
import { MemoryError } from '../domain/errors.js';
import { assertContained, confine } from '../domain/path-safety.js';
import { StorageRouter, type Route } from '../domain/routing.js';
import { normalizeRelations, rewriteRelationBullets } from '../domain/model.js';
import { compactForm, normalizedForm } from '../domain/similarity.js';
import {
  dateFieldsFor,
  entityTypeSpec,
  isInvalidDate,
  nearestKnownType,
  normalizeTags,
  type NearestType,
} from '../domain/entity-types.js';
import type { MaintenanceService } from './maintenance-service.js';

/**
 * One linear pass over the vault. Markdown stays the source of truth.
 * The check writes a report and dry-run changesets under audit_dir (allowed
 * while read_only, same as prepare). It never edits the vault, never applies
 * a changeset, and never starts a reindex.
 */
export const HEALTH_OPS_PER_CHANGESET = 50;

export interface HealthFinding {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  path?: string;
  entity_id?: string;
}

export interface HealthChangesetRef {
  id: string;
  description: string;
  operations: number;
}

export interface HealthReport {
  generated_at: string;
  duration_ms: number;
  read_only: boolean;
  /** Health never applies a changeset and never writes vault Markdown. */
  applied: false;
  files: number;
  entities: number;
  counts: { by_severity: Record<string, number>; by_code: Record<string, number> };
  findings: HealthFinding[];
  changesets: HealthChangesetRef[];
  operations_proposed: number;
  operations_omitted: number;
  recommend_reindex: boolean;
  recommendations: string[];
  audit_event_id: string;
}

export interface HealthSummary {
  last_run_at: string | null;
  counts: { by_severity: Record<string, number>; by_code: Record<string, number> };
  top_findings: HealthFinding[];
  changeset_ids: string[];
  recommend_reindex: boolean;
  page?: number;
  page_size?: number;
  total_findings?: number;
  findings?: HealthFinding[];
}

export interface HealthRunOptions {
  maxChangesets?: number;
  maxOps?: number;
}

interface Fix {
  id: string;
  priority: number;
  operations: ChangeOperation[];
}

const SEVERITY_RANK: Record<HealthFinding['severity'], number> = { error: 0, warning: 1, info: 2 };

export function healthSummary(report: HealthReport | null, input: { detail?: boolean; page?: number; page_size?: number } = {}): HealthSummary {
  if (!report) {
    return { last_run_at: null, counts: { by_severity: {}, by_code: {} }, top_findings: [], changeset_ids: [], recommend_reindex: false };
  }
  const summary: HealthSummary = {
    last_run_at: report.generated_at,
    counts: report.counts,
    top_findings: report.findings.slice(0, 5),
    changeset_ids: report.changesets.map(item => item.id),
    recommend_reindex: report.recommend_reindex,
  };
  if (!input.detail) return summary;
  const page = input.page ?? 1;
  const pageSize = input.page_size ?? 20;
  const start = (page - 1) * pageSize;
  return {
    ...summary,
    page,
    page_size: pageSize,
    total_findings: report.findings.length,
    findings: report.findings.slice(start, start + pageSize),
  };
}

export class HealthService {
  private running = false;
  private readonly router: StorageRouter;
  private readonly reportDir: string;

  constructor(
    private readonly storage: EntityStorage,
    private readonly index: SearchIndex,
    private readonly maintenance: MaintenanceService,
    private readonly audit: AuditSink,
    private readonly neural: NeuralAssociativeMemory,
    vaultRoot: string,
    private readonly routes: Record<string, Route>,
    auditDir: string,
    private readonly readOnly: boolean,
    private readonly maxChangesets: number,
  ) {
    this.router = new StorageRouter(vaultRoot, routes);
    this.reportDir = path.join(auditDir, 'health');
  }

  private get lockPath(): string {
    return path.join(this.reportDir, '.lock');
  }

  async run(options: HealthRunOptions = {}): Promise<HealthReport> {
    if (this.running) throw new MemoryError('CONFLICT', 'A health check is already running');
    this.running = true;
    let lock: FileHandle | undefined;
    try {
      lock = await this.acquireLock();
      return await this.execute(options);
    } finally {
      this.running = false;
      if (lock) {
        await lock.close().catch(() => undefined);
        await unlink(this.lockPath).catch(() => undefined);
      }
    }
  }

  async latest(): Promise<HealthReport | null> {
    try {
      return JSON.parse(await readFile(path.join(this.reportDir, 'latest.json'), 'utf8')) as HealthReport;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  summary(input: { detail?: boolean; page?: number; page_size?: number } = {}): Promise<HealthSummary> {
    return this.latest().then(report => healthSummary(report, input));
  }

  private async execute(options: HealthRunOptions): Promise<HealthReport> {
    const started = Date.now();
    const maxChangesets = options.maxChangesets ?? this.maxChangesets;
    const maxOps = options.maxOps ?? HEALTH_OPS_PER_CHANGESET;
    const files = await this.storage.inspectFiles();
    const findings: HealthFinding[] = [];
    const entities: Entity[] = [];
    const occupied = new Set<string>();
    for (const file of files) {
      occupied.add(posix(file.path));
      if (!file.entity || file.error) {
        findings.push({ code: 'MALFORMED_MARKDOWN', severity: 'error', message: file.error ?? 'Unreadable Markdown', path: file.path });
        continue;
      }
      entities.push(file.entity);
    }

    const idCounts = new Map<string, number>();
    for (const entity of entities) idCounts.set(entity.metadata.id, (idCounts.get(entity.metadata.id) ?? 0) + 1);
    for (const entity of entities) {
      if ((idCounts.get(entity.metadata.id) ?? 0) > 1) {
        findings.push({
          code: 'DUPLICATE_ID', severity: 'error', entity_id: entity.metadata.id, path: entity.path,
          message: `Stable id ${entity.metadata.id} is used by more than one file`,
        });
      }
    }

    const linkKeys = new Map<string, string[]>();
    const duplicateTitles = new Map<string, Entity[]>();
    const aliasBuckets = new Map<string, { form: 'normalized' | 'compact'; ids: Set<string> }>();
    const relationTargets = new Set<string>();
    const fixes = new Map<string, Fix>();
    const byId = new Map<string, Entity>();
    for (const entity of entities) if ((idCounts.get(entity.metadata.id) ?? 0) === 1) byId.set(entity.metadata.id, entity);

    for (const entity of entities) {
      const unique = byId.get(entity.metadata.id) === entity;
      registerLinks(linkKeys, entity);
      const duplicateKey = compactForm(entity.metadata.title);
      if (duplicateKey) {
        const group = duplicateTitles.get(duplicateKey) ?? [];
        group.push(entity);
        duplicateTitles.set(duplicateKey, group);
      }
      if (entity.metadata.status !== 'archived') registerAliases(aliasBuckets, entity);
      for (const relation of normalizeRelations(entity.metadata, entity.metadata.id)) relationTargets.add(relation.target_id);
      if (!unique) continue;
      this.inspectEntity(entity, findings, fixes, occupied);
      this.proposeRelationRepair(entity, byId, findings, fixes);
      this.proposeTagFix(entity, findings, fixes);
    }

    for (const [key, group] of duplicateTitles) {
      if (group.length < 2) continue;
      findings.push({
        code: 'DUPLICATE_TITLE', severity: 'warning', entity_id: group[0]?.metadata.id, path: group[0]?.path,
        message: `Title compact form "${key}" is shared by ${group.length} entities (${group.map(item => item.metadata.id).join(', ')})`,
      });
    }
    for (const [bucketKey, bucket] of aliasBuckets) {
      if (bucket.ids.size < 2) continue;
      const ids = [...bucket.ids].sort();
      findings.push({
        code: 'ALIAS_COLLISION', severity: 'warning', entity_id: ids[0],
        message: `Alias key "${bucketKey.slice(bucket.form.length + 1)}" (${bucket.form}) is claimed by ${ids.length} entities`,
      });
    }

    const incoming = new Set<string>();
    for (const entity of entities) {
      for (const link of entity.wikilinks) {
        const key = normalizeLink(link);
        const targets = linkKeys.get(key);
        if (!targets?.length) {
          findings.push({
            code: 'BROKEN_LINK', severity: 'warning', entity_id: entity.metadata.id, path: entity.path,
            message: `Wikilink [[${link}]] does not resolve`,
          });
          continue;
        }
        for (const id of targets) incoming.add(id);
      }
    }
    for (const entity of entities) {
      if (entity.metadata.status === 'archived') continue;
      const relations = normalizeRelations(entity.metadata, entity.metadata.id);
      const connected = entity.wikilinks.length > 0 || incoming.has(entity.metadata.id) || relations.length > 0 || relationTargets.has(entity.metadata.id);
      if (!connected) {
        findings.push({
          code: 'ORPHAN', severity: 'info', entity_id: entity.metadata.id, path: entity.path,
          message: 'Entity has no wikilinks, backlinks, or relations',
        });
      }
    }

    await this.compareIndex(entities, findings);
    await this.compareSidecar(entities, findings);

    sortFindings(findings);
    const counts = countFindings(findings);
    const recommend = findings.some(finding => finding.code === 'INDEX_DRIFT' || finding.code === 'SIDECAR_DRIFT');
    const groups = [...fixes.values()]
      .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
      .map(orderedOperations)
      .filter(operations => operations.length > 0);
    const { slices, omitted } = chunkOperations(groups, Math.max(0, maxChangesets), Math.max(1, maxOps));
    const preparedAlready = (await this.maintenance.listChangesets()).filter(changeset => changeset.status === 'prepared' && changeset.description.startsWith('Health check dry-run'));
    const changesets: HealthChangesetRef[] = [];
    for (const slice of slices) {
      const fingerprint = operationFingerprint(slice);
      const reused = preparedAlready.find(changeset => operationFingerprint(changeset.operations) === fingerprint);
      if (reused) {
        changesets.push({ id: reused.id, description: reused.description, operations: reused.operations.length });
        continue;
      }
      const prepared = await this.maintenance.prepare(
        `Health check dry-run (${slice.length} operations). Review and apply_changeset explicitly; nothing is applied automatically.`,
        slice,
      );
      preparedAlready.push(prepared);
      changesets.push({ id: prepared.id, description: prepared.description, operations: prepared.operations.length });
    }

    const generatedAt = new Date().toISOString();
    const auditEventId = ulid();
    const report: HealthReport = {
      generated_at: generatedAt,
      duration_ms: Date.now() - started,
      read_only: this.readOnly,
      applied: false,
      files: files.length,
      entities: entities.length,
      counts,
      findings,
      changesets,
      operations_proposed: groups.reduce((sum, group) => sum + group.length, 0),
      operations_omitted: omitted,
      recommend_reindex: recommend,
      recommendations: recommend ? ['reindex'] : [],
      audit_event_id: auditEventId,
    };
    await this.writeReport(report);
    await this.audit.append({
      id: auditEventId,
      timestamp: generatedAt,
      operation: 'health_check',
      details: {
        files: report.files,
        entities: report.entities,
        by_severity: counts.by_severity,
        by_code: counts.by_code,
        changesets: changesets.map(item => item.id),
        operations_proposed: report.operations_proposed,
        operations_omitted: report.operations_omitted,
        recommend_reindex: recommend,
        duration_ms: report.duration_ms,
        applied: false,
      },
    });
    return report;
  }

  private inspectEntity(entity: Entity, findings: HealthFinding[], fixes: Map<string, Fix>, occupied: Set<string>): void {
    const type = entity.metadata.type;
    const spec = entityTypeSpec(type);
    const routed = Object.prototype.hasOwnProperty.call(this.routes, type);
    const nearest = nearestKnownType(type);
    const other: NearestType | undefined = nearest && nearest.type !== type ? nearest : undefined;
    if (!routed) {
      const hint = other ? ` Nearest known type is "${other.type}" (${formatNearest(other)}).` : '';
      findings.push({
        code: spec ? 'UNROUTED_TYPE' : 'UNKNOWN_TYPE',
        severity: 'warning',
        entity_id: entity.metadata.id,
        path: entity.path,
        message: spec
          ? `Type "${type}" is known but has no configured route; it falls back to the memory route.${hint}`
          : `Type "${type}" is not a known type and has no configured route.${hint}`,
      });
    }
    if (spec) {
      const required = new Set(spec.required);
      for (const key of spec.required) {
        if (blank(entity.metadata[key])) {
          findings.push({
            code: 'MISSING_FRONTMATTER', severity: 'error', entity_id: entity.metadata.id, path: entity.path,
            message: `Missing required frontmatter "${key}" for type ${type}`,
          });
        }
      }
      for (const key of spec.expected) {
        if (required.has(key) || !blank(entity.metadata[key])) continue;
        findings.push({
          code: 'MISSING_FRONTMATTER', severity: 'warning', entity_id: entity.metadata.id, path: entity.path,
          message: `Missing expected frontmatter "${key}" for type ${type}`,
        });
      }
    }
    for (const field of dateFieldsFor(type)) {
      if (!(field.key in entity.metadata)) continue;
      const value = entity.metadata[field.key];
      if (value == null || value === '') continue;
      if (!isInvalidDate(value, field.kind)) continue;
      findings.push({
        code: 'INVALID_DATE', severity: 'error', entity_id: entity.metadata.id, path: entity.path,
        message: `${field.key} is not a valid ISO ${field.kind === 'month-day' ? 'month-day or date' : field.kind}: ${JSON.stringify(value)}`,
      });
    }

    let routedPath: string | undefined;
    try {
      routedPath = this.routePath(type, entity);
    } catch (error) {
      findings.push({
        code: 'ROUTE_ERROR', severity: 'warning', entity_id: entity.metadata.id, path: entity.path,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    if (!routedPath) return;
    if (directoryOf(routedPath) === directoryOf(entity.path)) return;
    findings.push({
      code: 'TYPE_FOLDER_MISMATCH', severity: 'warning', entity_id: entity.metadata.id, path: entity.path,
      message: `Type "${type}" belongs in ${directoryOf(routedPath) || '(vault root)'}, file is in ${directoryOf(entity.path) || '(vault root)'}`,
    });
    const moveTo = (destination: string): void => {
      const target = posix(destination);
      if (target === posix(entity.path) || occupied.has(target)) return;
      propose(fixes, entity.metadata.id, 1, { kind: 'move', entity_id: entity.metadata.id, expected_revision: entity.revision, destination: target });
    };
    const retype = (next: string): void => {
      let destination: string;
      try { destination = this.routePath(next, entity); } catch { return; }
      const target = posix(destination);
      if (target !== posix(entity.path) && occupied.has(target)) return;
      propose(fixes, entity.metadata.id, 1, {
        kind: 'update', entity_id: entity.metadata.id, expected_revision: entity.revision,
        patch: { metadata: { type: next } },
      });
    };
    // A configured type keeps its type and is offered a move into its own folder.
    // An unrecognised type is only retyped when the name is an exact alias of a
    // routed type (`todo` → `task`). It is never moved onto the memory fallback
    // and never rewritten just because the current folder belongs to some other type.
    if (routed) {
      moveTo(routedPath);
      return;
    }
    const aliasTarget = other?.via === 'alias' && Object.prototype.hasOwnProperty.call(this.routes, other.type) ? other.type : undefined;
    if (aliasTarget) retype(aliasTarget);
  }

  private proposeRelationRepair(entity: Entity, byId: Map<string, Entity>, findings: HealthFinding[], fixes: Map<string, Fix>): void {
    if (!entity.content.includes('<!--')) return;
    const targets = new Map<string, { title: string; path: string }>();
    for (const relation of normalizeRelations(entity.metadata, entity.metadata.id)) {
      const target = byId.get(relation.target_id);
      if (target) targets.set(relation.id, { title: target.metadata.title, path: target.path });
    }
    const rewritten = rewriteRelationBullets(entity.content, targets);
    for (const relationId of rewritten.unresolved) {
      findings.push({
        code: 'UNRESOLVED_RELATION', severity: 'warning', entity_id: entity.metadata.id, path: entity.path,
        message: `Relation ${relationId} has no resolvable target`,
      });
    }
    if (rewritten.changed > 0) {
      propose(fixes, entity.metadata.id, 2, {
        kind: 'update', entity_id: entity.metadata.id, expected_revision: entity.revision,
        patch: { content: rewritten.content },
      });
    }
  }

  private proposeTagFix(entity: Entity, findings: HealthFinding[], fixes: Map<string, Fix>): void {
    const normalized = normalizeTags(entity.metadata.tags);
    if (!normalized.changed) return;
    findings.push({
      code: 'TAG_NORMALIZATION', severity: 'warning', entity_id: entity.metadata.id, path: entity.path,
      message: `Tags ${JSON.stringify(entity.metadata.tags)} normalize to ${JSON.stringify(normalized.tags)}`,
    });
    propose(fixes, entity.metadata.id, 3, {
      kind: 'update', entity_id: entity.metadata.id, expected_revision: entity.revision,
      patch: { metadata: { tags: normalized.tags } },
    });
  }

  private async compareIndex(entities: Entity[], findings: HealthFinding[]): Promise<void> {
    const indexed = await this.index.listEntries();
    const byId = new Map(indexed.map(entry => [entry.id, entry]));
    const seen = new Set<string>();
    for (const entity of entities) {
      seen.add(entity.metadata.id);
      const row = byId.get(entity.metadata.id);
      if (!row) {
        findings.push({
          code: 'INDEX_DRIFT', severity: 'warning', entity_id: entity.metadata.id, path: entity.path,
          message: 'Entity is missing from the in-memory index. Reindex is recommended and was not run.',
        });
        continue;
      }
      if (row.revision !== entity.revision || posix(row.path) !== posix(entity.path)) {
        findings.push({
          code: 'INDEX_DRIFT', severity: 'warning', entity_id: entity.metadata.id, path: entity.path,
          message: `Index revision ${row.revision} at ${row.path} does not match Markdown revision ${entity.revision} at ${entity.path}. Reindex is recommended and was not run.`,
        });
      }
    }
    for (const row of indexed) {
      if (seen.has(row.id)) continue;
      findings.push({
        code: 'INDEX_DRIFT', severity: 'warning', entity_id: row.id, path: row.path,
        message: `Index entry ${row.id} has no Markdown file. Reindex is recommended and was not run.`,
      });
    }
  }

  private async compareSidecar(entities: Entity[], findings: HealthFinding[]): Promise<void> {
    if (!this.neural.enabled) return;
    let snapshot: NeuralRevisionSnapshot;
    try {
      snapshot = await this.neural.revisions();
    } catch (error) {
      snapshot = { available: false, warning: error instanceof Error ? error.message : String(error) };
    }
    if (!snapshot.available || !snapshot.bdh) {
      findings.push({
        code: 'SIDECAR_UNAVAILABLE', severity: 'info',
        message: `Neural sidecar id map was not compared (${snapshot.warning ?? 'unavailable'}). Reindex was not run.`,
      });
      return;
    }
    this.compareLayer(entities, findings, 'bdh', snapshot.bdh);
    if (snapshot.vector) this.compareLayer(entities, findings, 'vector', snapshot.vector);
  }

  private compareLayer(entities: Entity[], findings: HealthFinding[], layer: string, revisions: Record<string, string>): void {
    const ids = new Set<string>();
    for (const entity of entities) {
      ids.add(entity.metadata.id);
      const got = revisions[entity.metadata.id];
      if (got === entity.revision) continue;
      findings.push({
        code: 'SIDECAR_DRIFT', severity: 'warning', entity_id: entity.metadata.id, path: entity.path,
        message: `${layer} revision is ${got === undefined ? 'missing' : got}; Markdown revision is ${entity.revision}. Reindex is recommended and was not run.`,
      });
    }
    for (const id of Object.keys(revisions)) {
      if (ids.has(id)) continue;
      findings.push({
        code: 'SIDECAR_DRIFT', severity: 'warning', entity_id: id,
        message: `${layer} has ${id} at revision ${revisions[id]}, which is not in the vault. Reindex is recommended and was not run.`,
      });
    }
  }

  private routePath(type: string, entity: Entity): string {
    const decided = typeof entity.metadata.decided_at === 'string' ? new Date(entity.metadata.decided_at) : undefined;
    const created = new Date(String(entity.metadata.created_at ?? ''));
    const date = decided && !Number.isNaN(decided.getTime()) ? decided : (!Number.isNaN(created.getTime()) ? created : new Date());
    return this.router.route(type, entity.metadata.title, date, entity.metadata).relativePath;
  }

  private async acquireLock(): Promise<FileHandle> {
    await mkdir(this.reportDir, { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await open(this.lockPath, 'wx');
        await handle.writeFile(String(process.pid));
        return handle;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (attempt === 0 && await this.lockIsStale()) {
          await unlink(this.lockPath).catch(() => undefined);
          continue;
        }
        throw new MemoryError('CONFLICT', 'A health check is already running');
      }
    }
    throw new MemoryError('CONFLICT', 'A health check is already running');
  }

  private async lockIsStale(): Promise<boolean> {
    try {
      const pid = Number((await readFile(this.lockPath, 'utf8')).trim());
      if (!Number.isInteger(pid) || pid <= 0) return true;
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ESRCH';
      }
    } catch {
      return true;
    }
  }

  private async writeReport(report: HealthReport): Promise<void> {
    await mkdir(this.reportDir, { recursive: true });
    const body = JSON.stringify(report, null, 2);
    const historyName = `${report.generated_at.replace(/[:]/g, '-')}-${report.audit_event_id}.json`;
    await writeAtomic(this.reportDir, historyName, body);
    await writeAtomic(this.reportDir, 'latest.json', body);
  }
}

function propose(fixes: Map<string, Fix>, id: string, priority: number, operation: ChangeOperation): void {
  const existing = fixes.get(id) ?? { id, priority, operations: [] };
  existing.priority = Math.min(existing.priority, priority);
  if (operation.kind === 'update') {
    const update = existing.operations.find(item => item.kind === 'update');
    if (update) mergeUpdate(update, operation);
    else existing.operations.push(operation);
  } else if (!existing.operations.some(item => item.kind === operation.kind)) {
    existing.operations.push(operation);
  }
  fixes.set(id, existing);
}

/** Moves stay first: a rename does not change the revision, so a following update still matches. */
function orderedOperations(fix: Fix): ChangeOperation[] {
  const moves = fix.operations.filter(operation => operation.kind === 'move');
  const updates = fix.operations.filter(operation => operation.kind !== 'move');
  return [...moves, ...updates];
}

function mergeUpdate(target: ChangeOperation, extra: ChangeOperation): void {
  const patch = target.patch ?? {};
  const incoming = extra.patch ?? {};
  target.patch = {
    ...patch,
    ...incoming,
    ...(patch.metadata || incoming.metadata ? { metadata: { ...(patch.metadata ?? {}), ...(incoming.metadata ?? {}) } } : {}),
  };
}

function chunkOperations(groups: ChangeOperation[][], maxChangesets: number, maxOps: number): { slices: ChangeOperation[][]; omitted: number } {
  const slices: ChangeOperation[][] = [];
  let current: ChangeOperation[] = [];
  let omitted = 0;
  const flush = () => {
    if (!current.length || slices.length >= maxChangesets) return;
    slices.push(current);
    current = [];
  };
  for (const group of groups) {
    if (slices.length >= maxChangesets) {
      omitted += group.length;
      continue;
    }
    if (current.length > 0 && current.length + group.length > maxOps) flush();
    if (slices.length >= maxChangesets) {
      omitted += group.length;
      continue;
    }
    current = current.concat(group);
    if (current.length >= maxOps) flush();
  }
  if (current.length) {
    if (slices.length < maxChangesets) slices.push(current);
    else omitted += current.length;
  }
  return { slices, omitted };
}

function operationFingerprint(operations: ChangeOperation[]): string {
  return JSON.stringify(operations.map(operation => ({
    kind: operation.kind,
    entity_id: operation.entity_id ?? null,
    expected_revision: operation.expected_revision ?? null,
    destination: operation.destination ?? null,
    patch: operation.patch ?? null,
  })));
}

function blank(value: unknown): boolean {
  return value == null || value === '' || (Array.isArray(value) && value.length === 0);
}

function posix(value: string): string {
  return value.replaceAll('\\', '/');
}

function directoryOf(relativePath: string): string {
  const normalized = posix(relativePath).replace(/\/+$/, '');
  const slash = normalized.lastIndexOf('/');
  return slash < 0 ? '' : normalized.slice(0, slash);
}

function normalizeLink(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/\\/g, '/').replace(/\.md$/i, '').replace(/\/$/, '').toLocaleLowerCase();
}

function registerLinks(linkKeys: Map<string, string[]>, entity: Entity): void {
  const keys = [
    entity.metadata.title,
    ...entity.metadata.aliases,
    entity.path.replace(/\.md$/i, ''),
    entity.path.replace(/\.md$/i, '').split('/').at(-1) ?? '',
  ];
  for (const key of keys.map(normalizeLink).filter(Boolean)) {
    const list = linkKeys.get(key) ?? [];
    if (!list.includes(entity.metadata.id)) list.push(entity.metadata.id);
    linkKeys.set(key, list);
  }
}

function registerAliases(buckets: Map<string, { form: 'normalized' | 'compact'; ids: Set<string> }>, entity: Entity): void {
  const values = [entity.metadata.title, ...entity.metadata.aliases];
  const add = (form: 'normalized' | 'compact', key: string) => {
    if (!key) return;
    const bucketKey = `${form}:${key}`;
    const bucket = buckets.get(bucketKey) ?? { form, ids: new Set<string>() };
    bucket.ids.add(entity.metadata.id);
    buckets.set(bucketKey, bucket);
  };
  for (const value of values) {
    add('normalized', normalizedForm(value));
    add('compact', compactForm(value));
  }
}

function formatNearest(nearest: NearestType): string {
  return nearest.via === 'similarity' ? `similarity ${nearest.score}` : 'alias';
}

function sortFindings(findings: HealthFinding[]): void {
  findings.sort((a, b) =>
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    a.code.localeCompare(b.code) ||
    (a.path ?? '').localeCompare(b.path ?? '') ||
    (a.entity_id ?? '').localeCompare(b.entity_id ?? '') ||
    a.message.localeCompare(b.message));
}

function countFindings(findings: HealthFinding[]): { by_severity: Record<string, number>; by_code: Record<string, number> } {
  const by_severity: Record<string, number> = {};
  const by_code: Record<string, number> = {};
  for (const finding of findings) {
    by_severity[finding.severity] = (by_severity[finding.severity] ?? 0) + 1;
    by_code[finding.code] = (by_code[finding.code] ?? 0) + 1;
  }
  return { by_severity, by_code };
}

async function writeAtomic(root: string, name: string, body: string): Promise<void> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,240}$/.test(name)) throw new MemoryError('VALIDATION_ERROR', 'Unsupported health report name');
  const target = confine(root, path.join(root, name));
  await assertContained(root, target);
  const temp = path.join(root, `.${name}.${ulid()}.tmp`);
  await assertContained(root, temp);
  await writeFile(temp, body, { mode: 0o600 });
  await rename(temp, target);
}
