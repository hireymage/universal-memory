import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { MemoryError } from './errors.js';

/** ULID, migration ids (`p3r-…`), and other server-generated keys. Never a path. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,200}$/;

export function assertSafeId(id: string, label = 'id'): void {
  if (!SAFE_ID.test(id)) throw new MemoryError('VALIDATION_ERROR', `${label} contains unsupported characters`);
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Text placed inside `[[...]]`. Brackets, aliases, and newlines would break
 * out of the link and inject Markdown into another note.
 */
export function wikilinkLabel(value: string): string {
  return value.replace(/[\[\]|#\r\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

function isInside(root: string, candidate: string): boolean {
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return candidate === root || candidate.startsWith(prefix);
}

/** Resolved `target` must stay inside `root`. Rejects `..` after normalization. */
export function confine(root: string, target: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(target);
  if (!isInside(resolvedRoot, resolved)) throw new MemoryError('PATH_ESCAPE', 'Path escapes its root');
  return resolved;
}

/**
 * Reject symlinks and paths whose real location leaves `root`. Missing final
 * components are allowed so a new file can be created; every existing
 * component must be a real directory or file inside the root.
 */
export async function assertContained(root: string, absolute: string): Promise<void> {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(absolute);
  if (!isInside(resolvedRoot, resolved)) throw new MemoryError('PATH_ESCAPE', 'Path escapes its root');
  let rootReal = resolvedRoot;
  try { rootReal = await realpath(resolvedRoot); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const relative = path.relative(resolvedRoot, resolved);
  const segments = relative.split(path.sep).filter(Boolean);
  let current = resolvedRoot;
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!;
    if (!segment || segment === '.' || segment === '..' || segment.includes('\0')) {
      throw new MemoryError('PATH_ESCAPE', 'Path escapes its root');
    }
    current = path.join(current, segment);
    let stats;
    try { stats = await lstat(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (index === 0) return;
      const parentReal = await realpath(path.dirname(current));
      if (!isInside(rootReal, parentReal)) throw new MemoryError('PATH_ESCAPE', 'Path escapes its root');
      return;
    }
    if (stats.isSymbolicLink()) throw new MemoryError('PATH_ESCAPE', 'Symlinks are not followed');
  }
  try {
    const real = await realpath(current);
    if (!isInside(rootReal, real)) throw new MemoryError('PATH_ESCAPE', 'Path escapes its root');
  } catch (error) {
    if (error instanceof MemoryError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

/**
 * Frontmatter and config are untrusted YAML. The `yaml` package does not
 * execute tags; alias expansion is capped so a note cannot billion-laugh the
 * process. Anchors below the cap still work.
 */
export function parseYamlMapping(value: string): Record<string, unknown> {
  if (!value.trim()) return {};
  const parsed = YAML.parse(value, { maxAliasCount: 10, schema: 'core' }) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new MemoryError('VALIDATION_ERROR', 'YAML must be a mapping');
  }
  return parsed as Record<string, unknown>;
}
