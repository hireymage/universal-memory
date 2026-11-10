import path from 'node:path';
import { MemoryError } from './errors.js';

export interface Route { backend: string; path: string }

export function slugify(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'untitled';
}

export class StorageRouter {
  constructor(private readonly vaultRoot: string, private readonly routes: Record<string, Route>) {}

  route(type: string, title: string, date = new Date(), metadata: Record<string, unknown> = {}): { backend: string; absolutePath: string; relativePath: string } {
    const route = this.routes[type] ?? this.routes.memory;
    if (!route) throw new MemoryError('VALIDATION_ERROR', `No route configured for entity type: ${type}`);
    let relativePath = route.path
      .replaceAll('{slug}', slugify(title))
      .replaceAll('{date}', date.toISOString().slice(0, 10));
    relativePath = relativePath.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, key: string) => key === 'collection_path'
      ? safeCollectionPath(metadata[key], key)
      : safeRouteValue(metadata[key], key));
    const absolutePath = this.resolve(relativePath);
    return { backend: route.backend, absolutePath, relativePath: path.relative(this.vaultRoot, absolutePath) };
  }

  resolve(relativePath: string): string {
    if (path.isAbsolute(relativePath)) throw new MemoryError('PATH_ESCAPE', 'Absolute paths are not allowed');
    const resolved = path.resolve(this.vaultRoot, relativePath);
    const prefix = `${path.resolve(this.vaultRoot)}${path.sep}`;
    if (resolved !== path.resolve(this.vaultRoot) && !resolved.startsWith(prefix)) {
      throw new MemoryError('PATH_ESCAPE', `Path escapes vault root: ${relativePath}`);
    }
    return resolved;
  }
}

function safeCollectionPath(value: unknown, key: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new MemoryError('VALIDATION_ERROR', `Missing routing metadata: ${key}`);
  const normalized = value.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.includes('\0'))) {
    throw new MemoryError('PATH_ESCAPE', `Unsafe routing metadata: ${key}`);
  }
  return segments.join('/');
}

function safeRouteValue(value: unknown, key: string): string {
  if (typeof value !== 'string') throw new MemoryError('VALIDATION_ERROR', `Missing routing metadata: ${key}`);
  if (!value) return '';
  const trailing = value.endsWith('/');
  const normalized = value.split('/').filter(Boolean).map(slugify).join('/');
  return trailing && normalized ? `${normalized}/` : normalized;
}
