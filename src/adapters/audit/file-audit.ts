import { mkdir, readFile, readdir, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import type { AuditBundleItem, AuditSink, ChangesetStore } from '../../ports/index.js';
import type { AuditEvent, Changeset, Entity } from '../../domain/types.js';
import { MemoryError } from '../../domain/errors.js';
import { assertContained, assertSafeId, confine } from '../../domain/path-safety.js';

export class FileAuditSink implements AuditSink {
  private readonly log: string;
  constructor(private readonly root: string) { this.log = path.join(root, 'events.jsonl'); }
  async append(event: AuditEvent, before?: Entity, after?: Entity, bundle?: AuditBundleItem[]): Promise<void> {
    assertSafeId(event.id, 'audit event id');
    await mkdir(this.root, { recursive: true });
    const snapshot = (name: string, entity: Entity): Promise<void> => this.writeNew(name, JSON.stringify(entity, null, 2));
    if (before) await snapshot(`${event.id}-before.json`, before);
    if (after) await snapshot(`${event.id}-after.json`, after);
    await Promise.all((bundle ?? []).flatMap((item, index) => [
      ...(item.before ? [snapshot(`${event.id}-bundle-${index}-before.json`, item.before)] : []),
      ...(item.after ? [snapshot(`${event.id}-bundle-${index}-after.json`, item.after)] : []),
    ]));
    await assertContained(this.root, this.log);
    await appendFile(this.log, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  }
  private async writeNew(name: string, body: string): Promise<void> {
    const file = this.entry(name);
    await assertContained(this.root, file);
    await writeFile(file, body, { flag: 'wx', mode: 0o600 });
  }
  private entry(name: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,240}$/.test(name)) throw new MemoryError('VALIDATION_ERROR', 'Unsupported audit file name');
    return confine(this.root, path.join(this.root, name));
  }
  async list(entityId?: string, limit=100): Promise<AuditEvent[]> {
    let raw=''; try { raw=await readFile(this.log,'utf8'); } catch (e) { if((e as NodeJS.ErrnoException).code==='ENOENT') return []; throw e; }
    return raw.trim().split('\n').filter(Boolean).map((line)=>JSON.parse(line) as AuditEvent)
      .filter((event)=>!entityId||event.entity_id===entityId).slice(-limit).reverse();
  }
  async readSnapshot(eventId:string,which:'before'|'after'):Promise<Entity|undefined>{
    assertSafeId(eventId, 'audit event id');
    const file = this.entry(`${eventId}-${which}.json`);
    try { await assertContained(this.root, file); return JSON.parse(await readFile(file, 'utf8')) as Entity; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; }
  }
  async readBundle(eventId: string): Promise<AuditBundleItem[]> {
    try { await readdir(this.root); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
    const items: AuditBundleItem[] = [];
    const files = (await readdir(this.root)).filter(name => name.startsWith(`${eventId}-bundle-`)).sort();
    for (const name of files) {
      const match = name.match(new RegExp(`^${eventId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-bundle-(\\d+)-(before|after)\\.json$`));
      if (!match) continue;
      const index = Number(match[1]), slot = match[2] as 'before' | 'after';
      const entity = JSON.parse(await readFile(this.entry(name), 'utf8')) as Entity;
      while (items.length <= index) items.push({ entity_id: entity.metadata.id, path: entity.path });
      items[index] = { ...items[index], entity_id: items[index]!.entity_id || entity.metadata.id, path: items[index]!.path || entity.path, ...(slot === 'before' ? { before: entity } : { after: entity }) };
    }
    return items.filter(item => item.entity_id);
  }
}

export class FileChangesetStore implements ChangesetStore {
  constructor(private readonly root: string) {}
  private file(id: string): string {
    assertSafeId(id, 'changeset id');
    return confine(this.root, path.join(this.root, `${id}.json`));
  }
  async save(changeset: Changeset): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const file = this.file(changeset.id);
    await assertContained(this.root, file);
    await writeFile(file, JSON.stringify(changeset, null, 2), { mode: 0o600 });
  }
  async get(id: string): Promise<Changeset|undefined> {
    const file = this.file(id);
    try { await assertContained(this.root, file); return JSON.parse(await readFile(file, 'utf8')) as Changeset; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; }
  }
}