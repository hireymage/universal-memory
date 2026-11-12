import { dateFieldsFor, entityTypeSpec, isInvalidDate, normalizeTags } from './entity-types.js';
import { compactForm } from './similarity.js';
import type { EntityDraft, EntityPatch } from './types.js';

/**
 * Frontmatter key synonyms applied on write. Lookup is the accent-stripped
 * compact form, so `Svátek`, `svatek`, and `name-day` can share a target.
 * The canonical key is never renamed. A synonym is renamed only when the
 * canonical key is absent or holds the same value. Differing values are both
 * kept and reported; nothing is dropped quietly.
 */
const SYNONYMS = new Map<string, string>([
  ['deadline', 'due'],
  ['termin', 'due'],
  ['narozeniny', 'birth_date'],
  ['birthday', 'birth_date'],
  ['datumnarozeni', 'birth_date'],
  ['svatek', 'name_day'],
  ['jmeniny', 'name_day'],
  ['nameday', 'name_day'],
]);

export interface NormalizationChange {
  kind: 'key' | 'tag';
  from: string;
  to: string;
}

export interface SynonymConflict {
  from: string;
  to: string;
}

export interface WriteWarning {
  code: string;
  /** Same scale as the health check: missing `required` and invalid dates are errors. */
  severity: 'info' | 'warning' | 'error';
  message: string;
  field?: string;
  candidate_id?: string;
}

export interface NormalizedMetadata {
  metadata: Record<string, unknown>;
  changes: NormalizationChange[];
  conflicts: SynonymConflict[];
}

const TITLE_MAX = 180;
const SHORT_CONTENT = 40;
/** Cosine similarity at or above this is a likely vector duplicate. */
export const VECTOR_DUPLICATE_SCORE = 0.85;

export function normalizeMetadata(metadata: Record<string, unknown> | undefined): NormalizedMetadata {
  const input = metadata ?? {};
  const changes: NormalizationChange[] = [];
  const conflicts: SynonymConflict[] = [];
  const next: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    const canonical = synonymTarget(key);
    if (!canonical) {
      next[key] = value;
      continue;
    }
    const existing = Object.prototype.hasOwnProperty.call(next, canonical)
      ? next[canonical]
      : (Object.prototype.hasOwnProperty.call(input, canonical) ? input[canonical] : undefined);
    const canonicalPresent = existing !== undefined || Object.prototype.hasOwnProperty.call(input, canonical) || Object.prototype.hasOwnProperty.call(next, canonical);
    if (!canonicalPresent) {
      next[canonical] = value;
      changes.push({ kind: 'key', from: key, to: canonical });
      continue;
    }
    if (sameValue(existing, value)) {
      if (!Object.prototype.hasOwnProperty.call(next, canonical)) next[canonical] = existing;
      changes.push({ kind: 'key', from: key, to: canonical });
      continue;
    }
    next[key] = value;
    if (!Object.prototype.hasOwnProperty.call(next, canonical) && existing !== undefined) next[canonical] = existing;
    conflicts.push({ from: key, to: canonical });
  }

  if (Array.isArray(next.tags)) {
    const tags = next.tags.filter((tag): tag is string => typeof tag === 'string');
    const normalized = normalizeTags(tags);
    const seen = new Set<string>();
    for (const tag of tags) {
      const single = normalizeTags([tag]).tags[0];
      if (!single || seen.has(single)) {
        changes.push({ kind: 'tag', from: tag, to: '' });
        continue;
      }
      seen.add(single);
      if (single !== tag) changes.push({ kind: 'tag', from: tag, to: single });
    }
    if (normalized.changed || tags.length !== next.tags.length) next.tags = normalized.tags;
  }

  return { metadata: next, changes, conflicts };
}

export function normalizeDraft(draft: EntityDraft): { draft: EntityDraft; changes: NormalizationChange[]; conflicts: SynonymConflict[] } {
  const normalized = normalizeMetadata(draft.metadata);
  return {
    draft: { ...draft, metadata: normalized.metadata },
    changes: normalized.changes,
    conflicts: normalized.conflicts,
  };
}

export function normalizePatch(patch: EntityPatch): { patch: EntityPatch; changes: NormalizationChange[]; conflicts: SynonymConflict[] } {
  if (!patch.metadata) return { patch, changes: [], conflicts: [] };
  const normalized = normalizeMetadata(patch.metadata);
  return {
    patch: { ...patch, metadata: normalized.metadata },
    changes: normalized.changes,
    conflicts: normalized.conflicts,
  };
}

export interface DuplicateHint {
  id: string;
  score: number;
  via: 'title' | 'vector';
}

export function writeWarnings(input: {
  type: string;
  title: string;
  content: string;
  metadata: Record<string, unknown>;
  duplicates?: DuplicateHint[];
  conflicts?: SynonymConflict[];
}): WriteWarning[] {
  const warnings: WriteWarning[] = [];
  const spec = entityTypeSpec(input.type);
  if (spec) {
    const required = new Set(spec.required);
    for (const key of spec.required) {
      if (blank(input.metadata[key])) {
        warnings.push({
          code: 'MISSING_FRONTMATTER', severity: 'error', field: key,
          message: `Missing required frontmatter "${key}" for type ${input.type}`,
        });
      }
    }
    for (const key of spec.expected) {
      if (required.has(key) || !blank(input.metadata[key])) continue;
      warnings.push({
        code: 'MISSING_FRONTMATTER', severity: 'warning', field: key,
        message: `Missing expected frontmatter "${key}" for type ${input.type}`,
      });
    }
  }
  for (const field of dateFieldsFor(input.type)) {
    if (!Object.prototype.hasOwnProperty.call(input.metadata, field.key)) continue;
    const value = input.metadata[field.key];
    if (value == null || value === '') continue;
    if (!isInvalidDate(value, field.kind)) continue;
    warnings.push({
      code: 'INVALID_DATE', severity: 'error', field: field.key,
      message: `${field.key} is not a valid ISO ${field.kind === 'month-day' ? 'month-day or date' : field.kind}: ${JSON.stringify(value)}`,
    });
  }
  if (!input.title.trim()) {
    warnings.push({ code: 'TITLE_EMPTY', severity: 'warning', field: 'title', message: 'Title is empty' });
  } else if (input.title.trim().length > TITLE_MAX) {
    warnings.push({
      code: 'TITLE_TOO_LONG', severity: 'warning', field: 'title',
      message: `Title is ${input.title.trim().length} characters; titles over ${TITLE_MAX} are hard to scan`,
    });
  }
  if (input.content.trim().length < SHORT_CONTENT) {
    warnings.push({
      code: 'SHORT_CONTENT', severity: 'warning', field: 'content',
      message: `Content is ${input.content.trim().length} characters; under ${SHORT_CONTENT} is usually incomplete`,
    });
  }
  const seen = new Set<string>();
  for (const duplicate of input.duplicates ?? []) {
    if (!duplicate.id || seen.has(duplicate.id)) continue;
    const likely = duplicate.via === 'title' ? duplicate.score >= 0.9 : duplicate.score >= VECTOR_DUPLICATE_SCORE;
    if (!likely) continue;
    seen.add(duplicate.id);
    warnings.push({
      code: duplicate.via === 'vector' ? 'VECTOR_SIMILARITY' : 'DUPLICATE_TITLE',
      severity: 'warning',
      candidate_id: duplicate.id,
      message: duplicate.via === 'vector'
        ? `Vector similarity ${duplicate.score} with ${duplicate.id}`
        : `Title or alias similarity ${duplicate.score} with ${duplicate.id}`,
    });
  }
  for (const conflict of input.conflicts ?? []) {
    warnings.push({
      code: 'SYNONYM_CONFLICT', severity: 'warning', field: conflict.from,
      message: `Kept both "${conflict.from}" and "${conflict.to}" because the values differ`,
    });
  }
  return warnings;
}

function synonymTarget(key: string): string | undefined {
  const target = SYNONYMS.get(compactForm(key));
  if (!target || target === key) return undefined;
  return target;
}

function sameValue(left: unknown, right: unknown): boolean {
  if (typeof left === 'string' && typeof right === 'string') return left.trim() === right.trim();
  return JSON.stringify(left) === JSON.stringify(right);
}

function blank(value: unknown): boolean {
  return value == null || value === '' || (typeof value === 'string' && value.trim() === '') || (Array.isArray(value) && value.length === 0);
}
