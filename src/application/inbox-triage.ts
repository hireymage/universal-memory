import type { MaintenanceService } from './maintenance-service.js';
import type { MemoryService } from './memory-service.js';
import { MemoryError } from '../domain/errors.js';
import type { Changeset } from '../domain/types.js';

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
): Promise<{ items: InboxItem[]; changeset?: Changeset }> {
  const items = await listInbox(memory, input.limit ?? 20);
  if (!input.decisions?.length) return { items };
  for (const decision of input.decisions) {
    const entity = await memory.get(decision.id);
    if (entity.metadata.type !== 'inbox') throw new MemoryError('VALIDATION_ERROR', `Not an inbox item: ${decision.id}`);
    if (entity.revision !== decision.expected_revision) {
      throw new MemoryError('CONFLICT', `Inbox item changed since it was read: ${decision.id}`, {
        expectedRevision: decision.expected_revision,
        actualRevision: entity.revision,
      });
    }
  }
  const changeset = await maintenance.prepare('Triage inbox items', input.decisions.map(decision => ({
    kind: 'update' as const,
    entity_id: decision.id,
    expected_revision: decision.expected_revision,
    patch: { metadata: { type: decision.type, status: 'processed' } },
  })));
  return { items, changeset };
}

export async function listInbox(memory: MemoryService, limit: number): Promise<InboxItem[]> {
  const found = await memory.search({ types: ['inbox'], limit });
  return found.filter(entity => entity.metadata.status !== 'archived').map(entity => ({
    id: entity.metadata.id,
    title: entity.metadata.title,
    path: entity.path,
    revision: entity.revision,
    suggested_type: entity.metadata.suggested_type ?? null,
    classification_confidence: entity.metadata.classification_confidence ?? null,
    updated_at: entity.metadata.updated_at,
  }));
}
