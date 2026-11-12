import path from 'node:path';
import type { ResponseMode } from '../../config/schema.js';
import { oneSentence } from '../../domain/snippet.js';

/** Approximate ceiling for one compact tool result (JSON chars, o200k is ~4 chars/token). */
export const RESPONSE_CHAR_BUDGET = 8_000;
const COMPACT_CONTENT_CHARS = 480;
const DETAIL_CONTENT_CHARS = 2_400;

const CORE_META = new Set(['id', 'type', 'title', 'created_at', 'updated_at', 'aliases', 'tags', 'status', 'schema_version']);

export interface PresentOptions {
  mode: ResponseMode;
  /** `detail: true` on the tool input keeps frontmatter and a longer body. */
  detail?: boolean;
  vaultRoot?: string;
  /** When true, the same envelope is also returned as structuredContent. */
  duplicate?: boolean;
  budgetChars?: number;
}

interface ToolText {
  type: 'text';
  text: string;
}

export interface ToolPayload {
  content: ToolText[];
  structuredContent?: Record<string, unknown>;
  isError?: true;
}

export function presentSuccess(data: unknown, options: PresentOptions): ToolPayload {
  return packageEnvelope(true, data, options);
}

export function presentFailure(error: { code: string; message: string; details?: unknown }, options: PresentOptions): ToolPayload {
  const payload = packageEnvelope(false, error, options);
  return { ...payload, isError: true };
}

function packageEnvelope(ok: boolean, dataOrError: unknown, options: PresentOptions): ToolPayload {
  const duplicate = options.duplicate === true || options.mode === 'full';
  const body = options.mode === 'full' ? dataOrError : fitBudget(compactValue(dataOrError, options), options.budgetChars ?? RESPONSE_CHAR_BUDGET);
  const envelope: Record<string, unknown> = ok
    ? { ok: true, data: body }
    : { ok: false, error: body };
  if (options.mode === 'full' || options.duplicate) {
    envelope.meta = { api_version: '1', request_id: crypto.randomUUID() };
  }
  const text = JSON.stringify(envelope);
  if (!duplicate) return { content: [{ type: 'text', text }] };
  return { content: [{ type: 'text', text }], structuredContent: envelope };
}

export function compactValue(value: unknown, options: PresentOptions): unknown {
  if (value == null) return undefined;
  if (typeof value === 'string') return value === '' ? undefined : value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    if (!options.detail && value.length > 0 && value.every(item => !!item && typeof item === 'object' && !Array.isArray(item) && isEntity(item as Record<string, unknown>))) {
      return value.map(item => entityIndex(item as Record<string, unknown>, options));
    }
    return value.map(item => compactValue(item, options)).filter(item => item !== undefined);
  }
  const record = value as Record<string, unknown>;
  if (isEntity(record)) return compactEntity(record, options);
  if (isSimilarCandidate(record)) return compactCandidate(record, options);
  if (isAssociate(record)) return compactAssociate(record, options);
  if (isFindResult(record)) return compactFind(record, options);
  if (isLexicalHit(record)) return compactLexical(record, options);
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    const next = compactValue(child, options);
    if (next === undefined) continue;
    if (Array.isArray(next) && next.length === 0) continue;
    if (isEmptyObject(next)) continue;
    out[key] = next;
  }
  return out;
}

function isEntity(value: Record<string, unknown>): boolean {
  const meta = value.metadata;
  return typeof value.content === 'string'
    && typeof value.path === 'string'
    && typeof value.revision === 'string'
    && !!meta && typeof meta === 'object' && !Array.isArray(meta)
    && typeof (meta as Record<string, unknown>).id === 'string'
    && typeof (meta as Record<string, unknown>).title === 'string';
}

function compactEntity(value: Record<string, unknown>, options: PresentOptions): Record<string, unknown> {
  const meta = value.metadata as Record<string, unknown>;
  const { metadata: _metadata, content, path: entityPath, revision, wikilinks, ...rest } = value;
  const body = String(content);
  const clipped = clip(body, options.detail ? DETAIL_CONTENT_CHARS : COMPACT_CONTENT_CHARS);
  const header: Record<string, unknown> = {
    id: meta.id,
    type: meta.type,
    title: meta.title,
    path: displayPath(String(entityPath), options.vaultRoot),
    revision,
    status: meta.status,
    updated_at: meta.updated_at,
  };
  if (Array.isArray(meta.aliases) && meta.aliases.length) header.aliases = meta.aliases;
  if (Array.isArray(meta.tags) && meta.tags.length) header.tags = meta.tags;
  if (options.detail) header.metadata = compactValue(meta, options);
  else {
    const fields = scalarFields(meta);
    if (Object.keys(fields).length) header.fields = fields;
  }
  if (clipped.text) header.content = clipped.text;
  if (clipped.truncated) {
    header.content_truncated = true;
    header.content_chars = body.length;
  }
  if (Array.isArray(wikilinks) && wikilinks.length) header.wikilinks = wikilinks;
  const extras = compactValue(rest, options);
  if (extras && typeof extras === 'object' && !Array.isArray(extras)) Object.assign(header, extras);
  return header;
}

/** A list of entities is an index, not ten copies of the note. `detail: true` keeps the longer read. */
function entityIndex(value: Record<string, unknown>, options: PresentOptions): Record<string, unknown> {
  const meta = value.metadata as Record<string, unknown>;
  const out: Record<string, unknown> = {
    id: meta.id,
    type: meta.type,
    title: meta.title,
    path: displayPath(String(value.path), options.vaultRoot),
    snippet: oneSentence(String(value.content), undefined, 140),
  };
  if (Array.isArray(meta.tags) && meta.tags.length) out.tags = meta.tags;
  return out;
}

function scalarFields(meta: Record<string, unknown>): Record<string, string | number | boolean> {
  const fields: Record<string, string | number | boolean> = {};
  for (const [key, val] of Object.entries(meta)) {
    if (CORE_META.has(key) || val == null || val === '') continue;
    if (typeof val === 'number' || typeof val === 'boolean') fields[key] = val;
    else if (typeof val === 'string') fields[key] = val.length > 160 ? `${val.slice(0, 159)}…` : val;
  }
  return fields;
}

function isSimilarCandidate(value: Record<string, unknown>): boolean {
  return typeof value.score === 'number' && !!value.entity && typeof value.entity === 'object' && isEntity(value.entity as Record<string, unknown>);
}

function compactCandidate(value: Record<string, unknown>, options: PresentOptions): Record<string, unknown> {
  const entity = compactEntity(value.entity as Record<string, unknown>, options);
  delete entity.content;
  delete entity.content_truncated;
  delete entity.content_chars;
  return { score: value.score, ...(typeof value.reason === 'string' && value.reason ? { reason: value.reason } : {}), entity };
}

function isAssociate(value: Record<string, unknown>): boolean {
  return value.method === 'bdh-hebbian-v1' && Array.isArray(value.results);
}

function compactAssociate(value: Record<string, unknown>, options: PresentOptions): Record<string, unknown> {
  const results = (value.results as unknown[]).map(hit => compactSideHit(hit, options)).filter(hit => hit !== undefined);
  const vectors = Array.isArray(value.vector_results)
    ? (value.vector_results as unknown[]).map(hit => compactSideHit(hit, options)).filter(hit => hit !== undefined)
    : [];
  const out: Record<string, unknown> = { advisory: true };
  if (value.enabled !== undefined) out.enabled = value.enabled;
  if (value.available !== undefined) out.available = value.available;
  if (value.degraded === true) out.degraded = true;
  if (typeof value.mode === 'string' && value.mode !== 'neural') out.mode = value.mode;
  if (typeof value.warning === 'string' && value.warning) out.warning = value.warning;
  out.results = results;
  if (value.vector_available === true) out.vector_available = true;
  if (vectors.length) out.vector_results = vectors;
  return out;
}

function compactSideHit(hit: unknown, options: PresentOptions): unknown {
  if (!hit || typeof hit !== 'object' || Array.isArray(hit)) return compactValue(hit, options);
  const record = hit as Record<string, unknown>;
  const { snippet: _snippet, status: _status, revision: _revision, note: _note, ...rest } = record;
  const out = compactValue(rest, options);
  if (!out || typeof out !== 'object' || Array.isArray(out)) return out;
  if (typeof record.snippet === 'string' && record.snippet && options.detail) {
    (out as Record<string, unknown>).snippet = clip(record.snippet, 180).text;
  }
  return out;
}

function isFindResult(value: Record<string, unknown>): boolean {
  return Array.isArray(value.hits) && typeof value.query === 'string' && !!value.parsed && typeof value.parsed === 'object';
}

function compactFind(value: Record<string, unknown>, options: PresentOptions): Record<string, unknown> {
  const parsed = value.parsed as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (hasNonTextFilter(parsed)) {
    const { text: _text, ...filters } = parsed;
    out.parsed = compactValue(filters, options);
  }
  if (value.order && value.order !== 'relevance') out.order = value.order;
  out.hits = compactValue(value.hits, options);
  return out;
}

function hasNonTextFilter(parsed: Record<string, unknown>): boolean {
  return ['types', 'tags', 'person', 'project', 'due', 'since'].some(key => {
    const value = parsed[key];
    if (Array.isArray(value)) return value.length > 0;
    return value != null && value !== '';
  });
}

function isLexicalHit(value: Record<string, unknown>): boolean {
  return typeof value.id === 'string'
    && typeof value.title === 'string'
    && typeof value.snippet === 'string'
    && typeof value.path === 'string'
    && typeof value.revision === 'string'
    && value.score === undefined
    && value.reason === undefined
    && value.metadata === undefined;
}

function compactLexical(value: Record<string, unknown>, options: PresentOptions): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: value.id,
    type: value.type,
    title: value.title,
    path: displayPath(String(value.path), options.vaultRoot),
    snippet: value.snippet,
  };
  if (options.detail) {
    out.revision = value.revision;
    if (value.status) out.status = value.status;
    if (value.updated_at) out.updated_at = value.updated_at;
  }
  if (Array.isArray(value.tags) && value.tags.length) out.tags = value.tags;
  if (value.overdue === true) out.overdue = true;
  return out;
}

export function displayPath(filePath: string, vaultRoot?: string): string {
  const normalized = filePath.replaceAll('\\', '/');
  if (!vaultRoot || !path.isAbsolute(filePath)) return normalized;
  const relative = path.relative(vaultRoot, filePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return normalized;
  return relative.split(path.sep).join('/');
}

function clip(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`, truncated: true };
}

function isEmptyObject(value: unknown): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value as object).length === 0;
}

export function fitBudget(value: unknown, maxChars: number): unknown {
  if (JSON.stringify(value).length <= maxChars) return value;
  let current = value;
  for (const cap of [320, 160, 80]) {
    current = clipStrings(current, cap);
    if (JSON.stringify(current).length <= maxChars) return markTruncated(current);
  }
  let guard = 0;
  while (JSON.stringify(current).length > maxChars && guard < 8) {
    const next = halveLargestArray(current);
    if (!next.halved) break;
    current = next.value;
    guard += 1;
  }
  return markTruncated(current);
}

function markTruncated(value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return { ...(value as Record<string, unknown>), _truncated: true };
  }
  return { _truncated: true, value };
}

function clipStrings(value: unknown, max: number): unknown {
  if (typeof value === 'string') return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
  if (Array.isArray(value)) return value.map(item => clipStrings(item, max));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) out[key] = clipStrings(child, max);
    return out;
  }
  return value;
}

function halveLargestArray(value: unknown): { value: unknown; halved: boolean } {
  let best: unknown[] | undefined;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      if (!best || node.length > best.length) best = node;
      for (const item of node) visit(item);
      return;
    }
    if (node && typeof node === 'object') for (const child of Object.values(node as Record<string, unknown>)) visit(child);
  };
  visit(value);
  if (!best || best.length < 2) return { value, halved: false };
  const target = best;
  const keep = Math.max(1, Math.ceil(target.length / 2));
  const omitted = target.length - keep;
  const replacement = target.slice(0, keep);
  return { value: replaceArray(value, target, replacement, omitted), halved: true };
}

function replaceArray(node: unknown, target: unknown[], replacement: unknown[], omitted: number): unknown {
  if (node === target) return replacement;
  if (Array.isArray(node)) return node.map(item => replaceArray(item, target, replacement, omitted));
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (child === target) {
        out[key] = replacement;
        out[`${key}_omitted`] = omitted;
      } else out[key] = replaceArray(child, target, replacement, omitted);
    }
    return out;
  }
  return node;
}
