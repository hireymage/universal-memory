import { createHash } from 'node:crypto';
import { mkdir, readFile, appendFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * A ledger entry records one applied (or rolled-back, or skipped) migration
 * operation. Only one line is the truth per fingerprint: the newest entry for
 * a fingerprint decides its status, so a rollback simply appends a
 * `rolled_back` line and the operation becomes eligible again.
 */
export interface LedgerEntry {
  migration_id: string;
  stage: string;
  source_file?: string;
  operation_type: string;
  fingerprint: string;
  status: 'applied' | 'rolled_back' | 'skipped';
  timestamp: string;
  changeset_id?: string;
  details?: Record<string, unknown>;
}

/** Canonical JSON: sorted object keys, depth-first — deterministic on every host. */
export const canonicalJson = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonicalJson).join(',')}]`
    : value !== null && typeof value === 'object'
      ? `{${Object.keys(value as Record<string, unknown>).sort()
          .map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key as never])}`).join(',')}}`
      : JSON.stringify(value) ?? 'null';

/** Operation fingerprint: SHA-256 over the canonical JSON of the operation. */
export const opFingerprint = (operation: unknown): string =>
  createHash('sha256').update(canonicalJson(operation)).digest('hex');

/**
 * Persistent, append-only migration ledger outside the Markdown vault. A
 * repeated migration reads this file first: any operation whose newest entry
 * is `applied` is skipped, never written twice.
 */
export class MigrationLedger {
  private entries: LedgerEntry[] | undefined;
  constructor(private readonly file: string) {}
  private async load(): Promise<LedgerEntry[]> {
    if (this.entries) return this.entries;
    let raw = '';
    try { raw = await readFile(this.file, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.entries = raw.split('\n').filter(Boolean).map(line => JSON.parse(line) as LedgerEntry);
    return this.entries;
  }
  /** Newest status of the fingerprint — undefined when never seen. */
  async statusOf(fingerprint: string): Promise<LedgerEntry['status'] | undefined> {
    const entries = await this.load();
    const newest = entries.filter(entry => entry.fingerprint === fingerprint).at(-1);
    return newest?.status;
  }
  async record(entry: LedgerEntry): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    await appendFile(this.file, `${JSON.stringify(entry)}\n`, { flag: 'a', mode: 0o600 });
    if (this.entries) this.entries.push(entry);
  }
  async all(): Promise<LedgerEntry[]> { return [...await this.load()]; }
}