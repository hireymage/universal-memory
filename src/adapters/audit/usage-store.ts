import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertContained, confine } from '../../domain/path-safety.js';

/**
 * Optional read counters. The file lives under the audit/state directory, never
 * in the vault, so Markdown stays the only source of truth. Disabled stores
 * do not create the file and report every count as zero. A file that cannot
 * be parsed is left untouched.
 */
export class UsageStore {
  private readonly file: string;
  private counts = new Map<string, number>();
  private loaded = false;
  /** A corrupt usage file is kept. Later bumps do not overwrite it. */
  private broken = false;
  private tail: Promise<void> = Promise.resolve();

  constructor(auditDir: string, private readonly enabled: boolean) {
    this.file = confine(auditDir, path.join(auditDir, 'usage.json'));
  }

  get isEnabled(): boolean { return this.enabled; }

  async bump(ids: string[]): Promise<void> {
    if (!this.enabled || this.broken) return;
    const unique = [...new Set(ids.map(id => id.trim()).filter(Boolean))];
    if (!unique.length) return;
    await this.enqueue(async () => {
      await this.load();
      if (this.broken) return;
      for (const id of unique) this.counts.set(id, (this.counts.get(id) ?? 0) + 1);
      await this.flush();
    });
  }

  async countsFor(ids: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!this.enabled || !ids.length) return out;
    await this.enqueue(async () => { await this.load(); });
    if (this.broken) return out;
    for (const id of ids) out.set(id, this.counts.get(id) ?? 0);
    return out;
  }

  /** One in-flight mutation at a time, so two recalls cannot drop a count. */
  private enqueue(work: () => Promise<void>): Promise<void> {
    const run = this.tail.then(work);
    this.tail = run.then(() => undefined, () => undefined);
    return run.catch(() => undefined);
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      await assertContained(path.dirname(this.file), this.file);
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as { counts?: Record<string, unknown> };
      const counts = raw.counts ?? {};
      for (const [id, count] of Object.entries(counts)) {
        if (typeof count === 'number' && Number.isFinite(count) && count > 0) this.counts.set(id, count);
      }
      this.loaded = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.loaded = true;
        return;
      }
      // Mark loaded only after the failure is recorded, and never flush over the bad file.
      this.broken = true;
      this.loaded = true;
    }
  }

  private async flush(): Promise<void> {
    if (this.broken) return;
    const dir = path.dirname(this.file);
    await mkdir(dir, { recursive: true });
    await assertContained(dir, this.file);
    const body = JSON.stringify({ counts: Object.fromEntries(this.counts) });
    const tmp = confine(dir, path.join(dir, `.usage-${process.pid}-${randomBytes(4).toString('hex')}.tmp`));
    await writeFile(tmp, body, { mode: 0o600 });
    try { await rename(tmp, this.file); }
    catch (error) {
      await unlink(tmp).catch(() => undefined);
      throw error;
    }
  }
}
