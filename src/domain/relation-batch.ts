import { MemoryError } from './errors.js';

/**
 * One edge request in a relation batch. `target` is any resolvable reference
 * (stable id, exact title, alias, normalized/compact alias, or vault path) —
 * resolution itself is the GraphService resolver's job, this module only
 * validates the shape. `inverse` (optional) names the relation type to write
 * back on the target entity: reciprocity is explicit, both edges are written,
 * exactly like the existing directed-edge semantics. There is no canonical
 * relation-type registry — types are free-form, as everywhere else.
 */
export interface RelationSpec {
  target: string;
  type: string;
  inverse?: string;
}

/** Hard cap for one batch, mirroring the changeset-operation discipline. */
export const MAX_RELATION_BATCH = 100;

/**
 * Validate and normalize a batch: trim every field, reject empty type/target,
 * reject an empty `inverse` when the key is present, reject duplicate
 * identical (type, target) entries within the batch, reject an empty batch,
 * and cap the batch size. Returns trimmed specs with `inverse` omitted when
 * it was not supplied.
 */
export function normalizeRelationSpecs(specs: readonly RelationSpec[]): RelationSpec[] {
  if (!Array.isArray(specs) || specs.length === 0) {
    throw new MemoryError('VALIDATION_ERROR', 'relations batch must contain at least one spec');
  }
  if (specs.length > MAX_RELATION_BATCH) {
    throw new MemoryError('VALIDATION_ERROR', `relations batch is capped at ${MAX_RELATION_BATCH} specs, got ${specs.length}`);
  }
  const normalized: RelationSpec[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of specs.entries()) {
    const target = typeof raw?.target === 'string' ? raw.target.trim() : '';
    const type = typeof raw?.type === 'string' ? raw.type.trim() : '';
    const hasInverse = raw?.inverse !== undefined;
    const inverse = hasInverse ? (typeof raw.inverse === 'string' ? raw.inverse.trim() : '') : undefined;
    if (!target) throw new MemoryError('VALIDATION_ERROR', `relations[${index}]: target must not be empty`);
    if (!type) throw new MemoryError('VALIDATION_ERROR', `relations[${index}]: type must not be empty`);
    if (hasInverse && !inverse) throw new MemoryError('VALIDATION_ERROR', `relations[${index}]: inverse must not be empty when present`);
    const identity = `${type}|${target}`;
    if (seen.has(identity)) {
      throw new MemoryError('VALIDATION_ERROR', `relations[${index}]: duplicate spec (type=${type}, target=${target}) in the same batch`);
    }
    seen.add(identity);
    normalized.push({ target, type, ...(inverse ? { inverse } : {}) });
  }
  return normalized;
}
