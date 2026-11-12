import { createHash } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import YAML from 'yaml';
import { ulid } from 'ulid';
import { syncCollectionIndexes, type SyncStorage } from '../../domain/collection-sync.js';
import type { EntityStorage, SearchIndex } from '../../ports/index.js';
import type { Entity, EntityDraft, EntityMetadata, EntityPatch, ExternalFile } from '../../domain/types.js';
import { MemoryError } from '../../domain/errors.js';
import { assertContained, parseYamlMapping } from '../../domain/path-safety.js';
import { StorageRouter } from '../../domain/routing.js';
import { vaultLockActive, withVaultLock } from '../../domain/vault-lock.js';

const REQUIRED = ['id', 'type', 'title', 'created_at', 'updated_at', 'schema_version'] as const;
const wikilinkPattern = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;

function sha(bytes: string): string { return `sha256:${createHash('sha256').update(bytes).digest('hex')}`; }
function links(content: string): string[] {
  return [...content.matchAll(wikilinkPattern)].map((m) => m[1]!.trim()).filter(Boolean);
}

export class MarkdownStorage implements EntityStorage {
  constructor(
    private readonly vaultRoot: string,
    private readonly router: StorageRouter,
    private readonly index: SearchIndex,
    private readonly readOnly: boolean,
    private readonly followSymlinks = false,
  ) {}

  async create(draft: EntityDraft): Promise<Entity> {
    if (!vaultLockActive()) return withVaultLock(() => this.create(draft));
    this.assertWritable();
    const now = new Date().toISOString();
    const id = typeof draft.metadata?.id === 'string' ? draft.metadata.id : ulid();
    const metadata: EntityMetadata = {
      ...(draft.metadata ?? {}), id, type: draft.type, title: draft.title,
      created_at: typeof draft.metadata?.created_at === 'string' ? draft.metadata.created_at : now,
      // A pinned updated_at makes deterministic migration creates byte-
      // reproducible across rollback/re-apply (Phase-3C §28). Normal callers
      // never set it, so the wall clock stays.
      updated_at: typeof draft.metadata?.updated_at === 'string' ? draft.metadata.updated_at : now,
      aliases: asStrings(draft.metadata?.aliases), tags: asStrings(draft.metadata?.tags),
      status: typeof draft.metadata?.status === 'string' ? draft.metadata.status : 'active',
      schema_version: typeof draft.metadata?.schema_version === 'number' ? draft.metadata.schema_version : 1,
    };
    // Time-partitioned routes (for example project decisions) use an explicit
    // domain timestamp when supplied; otherwise they derive from the entity's
    // own created_at (pinned for deterministic migration creates — a wall-
    // clock route moment would break byte-reproducible re-apply, Phase-3C §28).
    const routeTimestamp = typeof metadata.decided_at === 'string'
      ? new Date(metadata.decided_at)
      : new Date(metadata.created_at);
    const routed = this.router.route(draft.type, draft.title, Number.isNaN(routeTimestamp.getTime()) ? new Date() : routeTimestamp, metadata);
    if (routed.backend !== 'markdown') throw new MemoryError('VALIDATION_ERROR', `Unsupported backend: ${routed.backend}`);
    let target = routed.absolutePath;
    await this.guard(target);
    try { await stat(target); target = withSuffix(target, id.slice(-6)); await this.guard(target); }
    catch (error) { if (error instanceof MemoryError) throw error; /* available */ }
    const entity = await this.writeNew(target, metadata, draft.content ?? '');
    await this.index.upsert(entity);
    return entity;
  }

  async get(id: string): Promise<Entity | undefined> {
    const indexed = await this.index.findById(id);
    if (indexed) {
      const entity = await this.getByPath(indexed.path);
      if (entity?.metadata.id === id) return entity;
    }
    for await (const entity of this.scan()) if (entity.metadata.id === id) return entity;
    return undefined;
  }

  async getByPath(relativePath: string): Promise<Entity | undefined> {
    const absolute = await this.locate(relativePath);
    try { return this.parse(absolute, await readFile(absolute, 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async update(id: string, patch: EntityPatch, expectedRevision: string): Promise<Entity> {
    if (!vaultLockActive()) return withVaultLock(() => this.update(id, patch, expectedRevision));
    this.assertWritable();
    const current = await this.get(id);
    if (!current) throw new MemoryError('NOT_FOUND', `Entity not found: ${id}`);
    if (current.revision !== expectedRevision) throw new MemoryError('CONFLICT', 'Entity changed since it was read', { expectedRevision, actualRevision: current.revision });
    const now = new Date().toISOString();
    const metadata: EntityMetadata = {
      ...current.metadata, ...(patch.metadata ?? {}), id: current.metadata.id,
      type: typeof patch.metadata?.type === 'string' ? patch.metadata.type : current.metadata.type,
      title: patch.title ?? current.metadata.title, created_at: current.metadata.created_at, updated_at: now,
      aliases: asStrings(patch.metadata?.aliases ?? current.metadata.aliases),
      tags: asStrings(patch.metadata?.tags ?? current.metadata.tags),
      status: typeof patch.metadata?.status === 'string' ? patch.metadata.status : current.metadata.status,
      schema_version: typeof patch.metadata?.schema_version === 'number' ? patch.metadata.schema_version : current.metadata.schema_version,
    };
    const currentPath = await this.locate(current.path);
    let targetPath = currentPath;
    // Explicit type change (update_memory / memory.update with the caller's
    // expected_revision). The file is renamed onto the new type's route.
    // MemoryService records from_path/to_path on the update audit event.
    // Health checks must not call this; they only prepare a dry-run changeset.
    if(metadata.type!==current.metadata.type){
      targetPath=this.router.route(metadata.type,metadata.title,new Date(),metadata).absolutePath;
      await this.guard(targetPath);
      if(targetPath!==currentPath){
        await mkdir(path.dirname(targetPath),{recursive:true});
        try{await stat(targetPath);throw new MemoryError('CONFLICT',`Move target already exists: ${this.display(targetPath)}`);}catch(error){if(error instanceof MemoryError)throw error;}
        await rename(currentPath,targetPath);
      }
    }
    let entity:Entity;
    try{entity=await this.atomicWrite(targetPath,metadata,patch.content??current.content);}catch(error){if(targetPath!==currentPath)await rename(targetPath,currentPath).catch(()=>undefined);throw error;}
    await this.index.upsert(entity);
    await syncCollectionIndexes(this as unknown as SyncStorage, entity);
    return entity;
  }

  /**
   * Full-metadata write for the managed graph paths (relations, claims,
   * merge, restore). Unlike update, the supplied metadata replaces the
   * stored set wholesale so removed keys — an emptied `relations` array, a
   * claim key dropped by restore — actually disappear from frontmatter.
   */
  async write(id: string, metadata: EntityMetadata, content: string, expectedRevision: string, options?: { timestamp?: string }): Promise<Entity> {
    if (!vaultLockActive()) return withVaultLock(() => this.write(id, metadata, content, expectedRevision, options));
    this.assertWritable();
    const current = await this.get(id);
    if (!current) throw new MemoryError('NOT_FOUND', `Entity not found: ${id}`);
    if (current.revision !== expectedRevision) throw new MemoryError('CONFLICT', 'Entity changed since it was read', { expectedRevision, actualRevision: current.revision });
    const complete: EntityMetadata = {
      ...metadata, id: current.metadata.id, created_at: current.metadata.created_at,
      updated_at: options?.timestamp ?? new Date().toISOString(),
      aliases: asStrings(metadata.aliases), tags: asStrings(metadata.tags),
      status: String(metadata.status ?? current.metadata.status),
      schema_version: Number(metadata.schema_version ?? current.metadata.schema_version),
      type: String(metadata.type ?? current.metadata.type),
      title: String(metadata.title ?? current.metadata.title),
    };
    const currentPath = await this.locate(current.path);
    let targetPath = currentPath;
    if (complete.type !== current.metadata.type) {
      targetPath = this.router.route(complete.type, complete.title, new Date(), complete).absolutePath;
      await this.guard(targetPath);
      // A type whose route resolves to the current path is an in-place retype.
      // stat() would otherwise see this file and report a false conflict.
      if (targetPath !== currentPath) {
        await mkdir(path.dirname(targetPath), { recursive: true });
        try { await stat(targetPath); throw new MemoryError('CONFLICT', `Move target already exists: ${this.display(targetPath)}`); }
        catch (error) { if (error instanceof MemoryError) throw error; }
        await rename(currentPath, targetPath);
      }
    }
    let entity: Entity;
    try { entity = await this.atomicWrite(targetPath, complete, content); }
    catch (error) { if (targetPath !== currentPath) await rename(targetPath, currentPath).catch(() => undefined); throw error; }
    await this.index.upsert(entity);
    return entity;
  }

  async move(id: string, destination: string, expectedRevision: string): Promise<Entity> {
    if (!vaultLockActive()) return withVaultLock(() => this.move(id, destination, expectedRevision));
    this.assertWritable();
    const current = await this.get(id);
    if (!current) throw new MemoryError('NOT_FOUND', `Entity not found: ${id}`);
    if (current.revision !== expectedRevision) throw new MemoryError('CONFLICT', 'Entity changed since it was read', { expectedRevision, actualRevision: current.revision });
    if (!destination.toLowerCase().endsWith('.md')) throw new MemoryError('VALIDATION_ERROR', 'Move destination must be a Markdown file');
    const source = await this.locate(current.path);
    const target = await this.locate(destination);
    if (source === target) return current;
    try { await stat(target); throw new MemoryError('CONFLICT', `Move target already exists: ${destination}`); }
    catch (error) { if (error instanceof MemoryError) throw error; }
    await mkdir(path.dirname(target), { recursive: true });
    await rename(source, target);
    const moved = this.parse(target, await readFile(target, 'utf8'));
    await this.index.upsert(moved);
    return moved;
  }

  async adopt(relativePath: string, draft: EntityDraft, expectedRevision: string): Promise<Entity> {
    if (!vaultLockActive()) return withVaultLock(() => this.adopt(relativePath, draft, expectedRevision));
    this.assertWritable();
    const absolute = await this.locate(relativePath);
    const raw = await readFile(absolute, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') throw new MemoryError('NOT_FOUND', `External file not found: ${relativePath}`);
      throw error;
    });
    const actualRevision = sha(raw);
    if (actualRevision !== expectedRevision) throw new MemoryError('CONFLICT', 'External file changed since it was scanned', { expectedRevision, actualRevision });
    try { this.parse(absolute, raw); throw new MemoryError('CONFLICT', `File is already managed: ${relativePath}`); }
    catch (error) { if (error instanceof MemoryError && error.code === 'CONFLICT') throw error; }
    const now = new Date().toISOString();
    const metadata: EntityMetadata = {
      ...(draft.metadata ?? {}), id: typeof draft.metadata?.id === 'string' ? draft.metadata.id : ulid(),
      type: draft.type, title: draft.title, created_at: now, updated_at: now,
      aliases: asStrings(draft.metadata?.aliases), tags: asStrings(draft.metadata?.tags),
      status: typeof draft.metadata?.status === 'string' ? draft.metadata.status : 'active',
      schema_version: typeof draft.metadata?.schema_version === 'number' ? draft.metadata.schema_version : 1,
      adopted_from_external_file: true,
    };
    const entity = await this.atomicWrite(absolute, metadata, raw);
    await this.index.upsert(entity);
    return entity;
  }

  archive(id: string, expectedRevision: string): Promise<Entity> {
    return this.update(id, { metadata: { status: 'archived', archived_at: new Date().toISOString() } }, expectedRevision);
  }

  /** Physical removal of one managed entity file (Phase-3C §27 rollback).
   * Resolves the entity first so unknown ids never delete blind; the index
   * entry is retracted before the unlink. */
  async remove(id: string): Promise<void> {
    if (!vaultLockActive()) return withVaultLock(() => this.remove(id));
    this.assertWritable();
    const current = await this.get(id);
    if (!current) throw new MemoryError('NOT_FOUND', `Entity not found: ${id}`);
    await this.index.remove(id);
    await unlink(await this.locate(current.path));
  }

  async *scan(): AsyncIterable<Entity> {
    for (const absolute of await walkMarkdown(this.vaultRoot)) {
      try { yield this.parse(absolute, await readFile(absolute, 'utf8')); } catch { /* inspection reports malformed files */ }
    }
  }

  async inspectFiles(): Promise<Array<{ path: string; entity?: Entity; error?: string }>> {
    const results: Array<{ path: string; entity?: Entity; error?: string }> = [];
    for (const absolute of await walkMarkdown(this.vaultRoot)) {
      const relative = path.relative(this.vaultRoot, absolute);
      try { results.push({ path: relative, entity: this.parse(absolute, await readFile(absolute, 'utf8')) }); }
      catch (error) { results.push({ path: relative, error: error instanceof Error ? error.message : String(error) }); }
    }
    return results;
  }

  async externalFiles(): Promise<ExternalFile[]> {
    const results: ExternalFile[] = [];
    for (const absolute of await walkMarkdown(this.vaultRoot)) {
      const raw = await readFile(absolute, 'utf8');
      try { this.parse(absolute, raw); }
      catch (error) { results.push({ path: path.relative(this.vaultRoot, absolute), revision: sha(raw), bytes: Buffer.byteLength(raw), content: raw, error: error instanceof Error ? error.message : String(error) }); }
    }
    return results;
  }

  private parse(absolute: string, raw: string): Entity {
    // Same YAML engine on both sides of the round trip: `matter`'s default
    // js-yaml parses a plain unquoted `2020-01-01` into a Date (its 1.1
    // timestamp tag), while our writer (`YAML.stringify`) emits date strings
    // unquoted — that asymmetry corrupted claim dates on every read-rewrite.
    const parsed = matter(raw, { engines: { yaml: { parse: (value) => parseYamlMapping(value), stringify: (value) => YAML.stringify(value) } }, language: 'yaml' });
    for (const key of REQUIRED) if (parsed.data[key] === undefined) throw new MemoryError('VALIDATION_ERROR', `Missing frontmatter field '${key}' in ${path.relative(this.vaultRoot, absolute)}`);
    const metadata = {
      ...parsed.data,
      id: String(parsed.data.id), type: String(parsed.data.type), title: String(parsed.data.title),
      created_at: isoString(parsed.data.created_at), updated_at: isoString(parsed.data.updated_at),
      aliases: asStrings(parsed.data.aliases), tags: asStrings(parsed.data.tags), status: String(parsed.data.status ?? 'active'),
      schema_version: Number(parsed.data.schema_version),
    } as EntityMetadata;
    for (const field of ['birth_date', 'name_day', 'started_at', 'completed_at'] as const) {
      if (parsed.data[field] instanceof Date) metadata[field] = parsed.data[field].toISOString().slice(0, 10);
    }
    // Round-trip fidelity: the body is kept as read (leading blank lines
    // included). The former `.trimStart()` silently consumed blank lines at
    // the frontmatter fence on every read→rewrite cycle — the first Phase-3B
    // claim batch exposed it when rollback could not reproduce the exact
    // baseline bytes for 14 files. Write-side normalization (trimEnd) is the
    // only whitespace rule the canonical serialization applies.
    return { metadata, content: parsed.content, path: path.relative(this.vaultRoot, absolute), revision: sha(raw), wikilinks: links(parsed.content) };
  }

  private async writeNew(target: string, metadata: EntityMetadata, content: string): Promise<Entity> {
    await this.guard(target);
    try { await stat(target); throw new MemoryError('CONFLICT', `Target already exists: ${this.display(target)}`); }
    catch (error) { if (error instanceof MemoryError) throw error; }
    return this.atomicWrite(target, metadata, content);
  }

  private async atomicWrite(target: string, metadata: EntityMetadata, content: string): Promise<Entity> {
    await this.guard(target);
    await mkdir(path.dirname(target), { recursive: true });
    const raw = matter.stringify(content.trimEnd() ? `${content.trimEnd()}\n` : '', metadata, { engines: { yaml: { parse: (value) => parseYamlMapping(value), stringify: (value) => YAML.stringify(value) } }, language: 'yaml' });
    const temp = path.join(path.dirname(target), `.${path.basename(target)}.${ulid()}.tmp`);
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(raw, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    try { await rename(temp, target); } catch (error) { await unlink(temp).catch(() => undefined); throw error; }
    return this.parse(target, raw);
  }

  private assertWritable(): void { if (this.readOnly) throw new MemoryError('READ_ONLY', 'Server is configured read-only'); }

  private async locate(relativePath: string): Promise<string> {
    const absolute = this.router.resolve(relativePath);
    await this.guard(absolute);
    return absolute;
  }

  private async guard(absolute: string): Promise<void> {
    if (!this.followSymlinks) await assertContained(this.vaultRoot, absolute);
  }

  private display(absolute: string): string {
    const relative = path.relative(this.vaultRoot, absolute);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return 'vault path';
    return relative;
  }
}

function asStrings(value: unknown): string[] { return Array.isArray(value) ? value.map(String) : value == null ? [] : [String(value)]; }
function isoString(value: unknown): string { return value instanceof Date ? value.toISOString() : String(value); }
function withSuffix(file: string, suffix: string): string { const ext = path.extname(file); return `${file.slice(0, -ext.length)}-${suffix}${ext}`; }

async function walkMarkdown(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) found.push(absolute);
    }
  }
  await walk(root);
  return found.sort();
}
