import { mkdir, readFile, readdir, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import type { AuditBundleItem, AuditSink, ChangesetStore } from '../../ports/index.js';
import type { AuditEvent, Changeset, Entity } from '../../domain/types.js';

export class FileAuditSink implements AuditSink {
  private readonly log: string;
  constructor(private readonly root: string) { this.log = path.join(root, 'events.jsonl'); }
  async append(event: AuditEvent, before?: Entity, after?: Entity, bundle?: AuditBundleItem[]): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const snapshot = (name: string, entity: Entity): Promise<void> =>
      writeFile(path.join(this.root, name), JSON.stringify(entity, null, 2), { flag: 'wx', mode: 0o600 });
    if (before) await snapshot(`${event.id}-before.json`, before);
    if (after) await snapshot(`${event.id}-after.json`, after);
    await Promise.all((bundle ?? []).flatMap((item, index) => [
      ...(item.before ? [snapshot(`${event.id}-bundle-${index}-before.json`, item.before)] : []),
      ...(item.after ? [snapshot(`${event.id}-bundle-${index}-after.json`, item.after)] : []),
    ]));
    await appendFile(this.log, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  }
  async list(entityId?: string, limit=100): Promise<AuditEvent[]> {
    let raw=''; try { raw=await readFile(this.log,'utf8'); } catch (e) { if((e as NodeJS.ErrnoException).code==='ENOENT') return []; throw e; }
    return raw.trim().split('\n').filter(Boolean).map((line)=>JSON.parse(line) as AuditEvent)
      .filter((event)=>!entityId||event.entity_id===entityId).slice(-limit).reverse();
  }
  async readSnapshot(eventId:string,which:'before'|'after'):Promise<Entity|undefined>{try{return JSON.parse(await readFile(path.join(this.root,`${eventId}-${which}.json`),'utf8')) as Entity;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw e;}}
  async readBundle(eventId: string): Promise<AuditBundleItem[]> {
    try { await readdir(this.root); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
    const items: AuditBundleItem[] = [];
    const files = (await readdir(this.root)).filter(name => name.startsWith(`${eventId}-bundle-`)).sort();
    for (const name of files) {
      const match = name.match(new RegExp(`^${eventId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-bundle-(\\d+)-(before|after)\\.json$`));
      if (!match) continue;
      const index = Number(match[1]), slot = match[2] as 'before' | 'after';
      const entity = JSON.parse(await readFile(path.join(this.root, name), 'utf8')) as Entity;
      while (items.length <= index) items.push({ entity_id: entity.metadata.id, path: entity.path });
      items[index] = { ...items[index], entity_id: items[index]!.entity_id || entity.metadata.id, path: items[index]!.path || entity.path, ...(slot === 'before' ? { before: entity } : { after: entity }) };
    }
    return items.filter(item => item.entity_id);
  }
}

export class FileChangesetStore implements ChangesetStore {
  constructor(private readonly root: string) {}
  async save(changeset: Changeset): Promise<void> { await mkdir(this.root,{recursive:true}); await writeFile(path.join(this.root,`${changeset.id}.json`),JSON.stringify(changeset,null,2),{mode:0o600}); }
  async get(id: string): Promise<Changeset|undefined> { try{return JSON.parse(await readFile(path.join(this.root,`${id}.json`),'utf8')) as Changeset;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw e;} }
}