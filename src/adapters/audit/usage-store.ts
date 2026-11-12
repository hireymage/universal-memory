import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertContained, confine } from '../../domain/path-safety.js';

/**
 * Optional read counters. The file lives under the audit/state directory, never
 * in the vault, so Markdown stays the only source of truth. Disabled stores
 * do not create the file and report every count as zero.
 */
export class UsageStore {
  private readonly file: string;
  private counts = new Map<string, number>();
  private loaded = false;

  constructor(auditDir: string, private readonly enabled: boolean) {
    this.file = confine(auditDir, path.join(auditDir, 'usage.json'));
  }

  get isEnabled(): boolean { return this.enabled; }

  async bump(ids: string[]): Promise<void> {
    if (!this.enabled) return;
    const unique = [...new Set(ids.map(id => id.trim()).filter(Boolean))];
    if (!unique.length) return;
    try {
      await this.load();
      for (const id of unique) this.counts.set(id, (this.counts.get(id) ?? 0) + 1);
      await this.flush();
    } catch {
      // A usage-file failure must not fail the read that triggered it.
    }
  }

  async countsFor(ids: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!this.enabled || !ids.length) return out;
    try { await this.load(); } catch { return out; }
    for (const id of ids) out.set(id, this.counts.get(id) ?? 0);
    return out;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      await assertContained(path.dirname(this.file), this.file);
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as { counts?: Record<string, unknown> };
      const counts = raw.counts ?? {};
      for (const [id, count] of Object.entries(counts)) {
        if (typeof count === 'number' && Number.isFinite(count) && count > 0) this.counts.set(id, count);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private async flush(): Promise<void> {
    const dir = path.dirname(this.file);
    await mkdir(dir, { recursive: true });
    await assertContained(dir, this.file);
    const body = JSON.stringify({ counts: Object.fromEntries(this.counts) });
    const tmp = confine(dir, path.join(dir, `.usage-${process.pid}.tmp`));
    await writeFile(tmp, body, { mode: 0o600 });
    await rename(tmp, this.file);
  }
}
