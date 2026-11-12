import type { MaintenanceService } from './maintenance-service.js';
import type { MemoryService } from './memory-service.js';
import { entityTypeSpec, nearestKnownType } from '../domain/entity-types.js';
import { MemoryError } from '../domain/errors.js';
import type { Route } from '../domain/routing.js';
import type { Changeset, Diagnostic } from '../domain/types.js';
import { writeWarnings, type WriteWarning } from '../domain/write-guard.js';

export interface InboxItem {
  id: string;
  title: string;
  path: string;
  revision: string;
  suggested_type: unknown;
  classification_confidence: unknown;
  updated_at: string;
}

export interface TriageDecision {
  id: string;
  expected_revision: string;
  type: string;
}

/**
 * Lists inbox items and, when decisions are passed, prepares a dry-run
 * changeset that retypes them. Applying stays on `apply_changeset`, which
 * checks revisions and writes the audit event.
 */
export async function triageInbox(
  memory: MemoryService,
  maintenance: MaintenanceService,
  input: { limit?: number; decisions?: TriageDecision[] },
  routes: Record<string, Route> = {},
): Promise<{ items: InboxItem[]; changeset?: Changeset; warnings?: WriteWarning[] }> {
  const items = await listInbox(memory, input.limit ?? 20);
  if (!input.decisions?.length) return { items };
  const warnings: WriteWarning[] = [];
  const diagnostics: Diagnostic[] = [];
  const operations = [];
  for (const decision of input.decisions) {
    const entity = await memory.get(decision.id);
    if (entity.metadata.type !== 'inbox') throw new MemoryError('VALIDATION_ERROR', `Not an inbox item: ${decision.id}`);
    if (entity.revision !== decision.expected_revision) {
      throw new MemoryError('CONFLICT', `Inbox item changed since it was read: ${decision.id}`, {
        expectedRevision: decision.expected_revision,
        actualRevision: entity.revision,
      });
    }
    const type = canonicalType(decision.type, routes);
    if (type !== decision.type.trim()) {
      warnings.push({
        code: 'TYPE_ALIAS', severity: 'info', field: 'type',
        message: `Type "${decision.type}" is an alias of "${type}"`,
      });
    }
    const projected = { ...entity.metadata, type, status: 'processed' };
    const found = writeWarnings({ type, title: entity.metadata.title, content: entity.content, metadata: projected });
    warnings.push(...found);
    for (const warning of found) {
      diagnostics.push({
        code: warning.code, severity: warning.severity, message: warning.message,
        entity_id: entity.metadata.id, path: entity.path,
      });
    }
    operations.push({
      kind: 'update' as const,
      entity_id: decision.id,
      expected_revision: decision.expected_revision,
      patch: { metadata: { type, status: 'processed' } },
    });
  }
  const changeset = await maintenance.prepare('Triage inbox items', operations, diagnostics);
  return { items, changeset, warnings };
}

/** Exact registry id, exact alias, or a type that already has a configured route. */
export function canonicalType(raw: string, routes: Record<string, Route>): string {
  const name = raw.trim();
  const nearest = nearestKnownType(name);
  if (nearest?.via === 'alias') return nearest.type;
  if (entityTypeSpec(name) || Object.prototype.hasOwnProperty.call(routes, name)) return name;
  throw new MemoryError('VALIDATION_ERROR', `Unknown type "${raw}". Pass a registry type, an exact alias, or a configured route.`);
}

export async function listInbox(memory: MemoryService, limit: number): Promise<InboxItem[]> {
  // Drop archived rows before the page size, or a page of archived items hides the live ones.
  const found = await memory.search({ types: ['inbox'], limit: 200 });
  return found.filter(entity => entity.metadata.status !== 'archived').slice(0, limit).map(entity => ({
    id: entity.metadata.id,
    title: entity.metadata.title,
    path: entity.path,
    revision: entity.revision,
    suggested_type: entity.metadata.suggested_type ?? null,
    classification_confidence: entity.metadata.classification_confidence ?? null,
    updated_at: entity.metadata.updated_at,
  }));
}
