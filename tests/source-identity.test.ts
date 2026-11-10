/**
 * Phase-3C execution tests — VARIANTA B typed Source identity (§4–§9),
 * claim provenance type safety, and the preview-driven sources migration
 * cycle (plan → apply → byte-identical rollback → re-apply).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { compose, type Services } from '../src/composition.js';
import type { AppConfig } from '../src/config/schema.js';
import { MigrationLedger } from '../src/adapters/migration/migration-ledger.js';
import { applyStage, planSourcesFromPreview, rollbackStage, type Phase3Opts } from '../src/migration/phase3.js';
import { canonicalizeUrl, sourceIdentity } from '../src/domain/source-identity.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function setup(): Promise<{ root: string; vault: string; services: Services; ledger: MigrationLedger; opts: Phase3Opts }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'universal-memory-p3c-')); roots.push(root);
  const vault = path.join(root, 'vault');
  const config: AppConfig = {
    name: 'P3C Identity Tests', vault_root: vault, read_only: false, audit_dir: path.join(root, 'state', 'audit'),
    transport: 'stdio', http: { bind: '127.0.0.1', port: 3333, allowed_origins: [], bearer_token_env: 'TEST_TOKEN' },
    routing: {
      memory: { backend: 'markdown', path: '03 Knowledge/{slug}.md' },
      note: { backend: 'markdown', path: '03 Knowledge/{slug}.md' },
      source: { backend: 'markdown', path: 'Sources/{provider}/{date}-{slug}.md' },
    },
  };
  const services = await compose(config);
  const ledger = new MigrationLedger(path.join(root, 'ledger', 'migration-ledger.jsonl'));
  const opts: Phase3Opts = { stage: 'sources', migrationTime: '2026-10-07T12:00:00.000Z', ledger };
  return { root, vault, services, ledger, opts };
}

const codeOf = (error: unknown): string => String((error as { code?: string }).code ?? '?');

describe('VARIANTA B typed source identity', () => {
  it('creates a web-URL source: identity_type url, no conversation_id, url mirrored', async () => {
    const { services } = await setup();
    const created = await services.sources.createSource({ title: 'X', provider: 'web', identity_type: 'url', identity_value: 'https://example.com/a' }) as { id: string; identity_type?: string; identity_value?: string; conversation_id?: unknown; url?: string; created?: boolean };
    expect(created.created).toBe(true);
    expect(created.identity_type).toBe('url');
    expect(created.identity_value).toBe('https://example.com/a');
    expect(created.url).toBe('https://example.com/a');
    expect(created.conversation_id).toBeUndefined();
    const stored = await services.memory.get(created.id);
    expect(stored.metadata.conversation_id).toBeUndefined();
    expect(stored.metadata.identity_type).toBe('url');
  });

  it('dedups by canonical triple — same identity twice → CONFLICT, return_existing → same id', async () => {
    const { services } = await setup();
    const first = await services.sources.createSource({ title: 'A', provider: 'web', identity_type: 'url', identity_value: 'https://example.com/a' }) as { id: string };
    await expect(services.sources.createSource({ title: 'B', provider: 'web', identity_type: 'url', identity_value: 'https://example.com/a' })).rejects.toMatchObject({ code: 'CONFLICT' });
    const again = await services.sources.createSource({ title: 'B', provider: 'web', identity_type: 'url', identity_value: 'https://example.com/a', if_exists: 'return_existing' }) as { id: string; created?: boolean };
    expect(again.id).toBe(first.id);
    expect(again.created).toBe(false);
  });

  it('canonicalizes surrounding whitespace only (§6): padded identity matches the bare one', async () => {
    const { services } = await setup();
    await services.sources.createSource({ title: 'A', provider: 'web', identity_type: 'url', identity_value: 'https://example.com/a' });
    // Surrounding whitespace trims to the identical identity → detected as duplicate.
    await expect(services.sources.createSource({ title: 'B', provider: 'web', identity_type: 'url', identity_value: '   https://example.com/a  ' })).rejects.toMatchObject({ code: 'CONFLICT' });
    // Query-string difference stays a distinct identity (never stripped).
    const other = await services.sources.createSource({ title: 'C', provider: 'web', identity_type: 'url', identity_value: 'https://example.com/a?x=1', if_exists: 'return_existing' }) as { id: string; created?: boolean };
    expect(other.created).toBe(true);
  });

  it('rejects the forbidden shapes (§2/§4): URL in conversation_id, url identity + conversation_id, unknown type', async () => {
    const { services } = await setup();
    await expect(services.sources.createSource({ title: 'X', provider: 'web', conversation_id: 'https://example.com/a' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(services.sources.createSource({ title: 'X', provider: 'web', identity_type: 'url', identity_value: 'https://example.com/a', conversation_id: 'c' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(services.sources.createSource({ title: 'X', provider: 'web', identity_type: 'ftp' as unknown as 'url', identity_value: 'https://example.com/a' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(services.sources.createSource({ title: 'X', provider: 'web', identity_type: 'url', identity_value: '  ' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('legacy shapes keep working and normalize into the typed identity space (§8)', async () => {
    const { services } = await setup();
    const legacy = await services.sources.createSource({ title: 'L', provider: 'chatgpt', conversation_id: 'conv-1' }) as { id: string };
    const stored = await services.memory.get(legacy.id);
    expect(stored.metadata.conversation_id).toBe('conv-1');
    expect(stored.metadata.identity_type).toBe('conversation');
    expect(sourceIdentity(stored.metadata)).toEqual({ provider: 'chatgpt', identity_type: 'conversation', identity_value: 'conv-1' });
    // Legacy lookup finds the typed-normalized row.
    expect(await services.sources.findSource({ provider: 'chatgpt', conversation_id: 'conv-1' })).toHaveLength(1);
    // A typed create with the same triple detects the legacy source (CONFLICT).
    await expect(services.sources.createSource({ title: 'L2', provider: 'chatgpt', identity_type: 'conversation', identity_value: 'conv-1' })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('finds typed url sources by typed filter and rejects url-only create without identity_type', async () => {
    const { services } = await setup();
    const created = await services.sources.createSource({ title: 'W', provider: 'web', identity_type: 'url', identity_value: 'https://example.com/w' }) as { id: string };
    const found = await services.sources.findSource({ provider: 'web', identity_type: 'url', identity_value: 'https://example.com/w' }) as Array<{ id?: string }>;
    expect(found.map(f => f.id)).toContain(created.id);
    // url passthrough alone is NOT an identity — must be rejected, never stored as conversation_id
    await expect(services.sources.createSource({ title: 'Y', provider: 'web', url: 'https://example.com/y' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('claim source_ids type safety (§9)', () => {
  it('accepts source ids, rejects non-source entities with INVALID_SOURCE_TYPE and missing ids with NOT_FOUND', async () => {
    const { services } = await setup();
    const source = await services.sources.createSource({ title: 'S', provider: 'web', identity_type: 'url', identity_value: 'https://example.com/s' }) as { id: string };
    const note = await services.memory.create({ type: 'note', title: 'Holder' });
    const revision = (await services.memory.get(note.metadata.id)).revision;
    const ok = await services.graph.createClaim(note.metadata.id, { predicate: 'vendor', value: 'AMD', source_ids: [source.id] }, revision) as { claim?: { source_ids?: string[] } };
    expect(ok.claim?.source_ids).toEqual([source.id]);
    const fresh = (await services.memory.get(note.metadata.id)).revision;
    await expect(services.graph.createClaim(note.metadata.id, { predicate: 'host', value: 'x', source_ids: [note.metadata.id] }, fresh))
      .rejects.toMatchObject({ code: 'INVALID_SOURCE_TYPE' });
    const fresh2 = (await services.memory.get(note.metadata.id)).revision;
    await expect(services.graph.createClaim(note.metadata.id, { predicate: 'ghost', value: 'x', source_ids: ['01NOPE99999999999999999999'] }, fresh2))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('updateClaim enforces the same type rule', async () => {
    const { services } = await setup();
    const source = await services.sources.createSource({ title: 'S2', provider: 'web', identity_type: 'url', identity_value: 'https://example.com/s2' }) as { id: string };
    const note = await services.memory.create({ type: 'note', title: 'Holder2' });
    const made = await services.graph.createClaim(note.metadata.id, { predicate: 'vendor', value: 'AMD' }, (await services.memory.get(note.metadata.id)).revision) as { claim?: { id?: string } };
    const claimId = made.claim?.id ?? '';
    const revision = (await services.memory.get(note.metadata.id)).revision;
    await services.graph.updateClaim(note.metadata.id, claimId, { source_ids: [source.id] }, revision);
    const fresh = (await services.memory.get(note.metadata.id)).revision;
    await expect(services.graph.updateClaim(note.metadata.id, claimId, { source_ids: [note.metadata.id] }, fresh))
      .rejects.toMatchObject({ code: 'INVALID_SOURCE_TYPE' });
  });
});

describe('sources migration cycle (plan → apply → rollback → re-apply)', () => {
  const URL = '  https://example.com/phase3c  '; // padded to exercise §6 canonicalization

  function previewOp(entityId: string, url: string, fingerprint: string) {
    return {
      entity_id: entityId,
      source_candidate: { provider: 'web', conversation_id: url, content_hash: null, url },
      classification: 'REVIEW',
      reason: 'approved web-provenance candidate',
      fingerprint,
    };
  }

  it('plan skips UNSAFE/deferred preview candidates as deferred review, not blockers (§18)', async () => {
    const { root, services, opts } = await setup();
    const owner = await services.memory.create({ type: 'note', title: 'Src Owner', metadata: { source_url: URL } });
    const urlB = 'https://example.com/unsafe-subject';
    const previewFile = path.join(root, 'preview-unsafe.json');
    await writeFile(previewFile, JSON.stringify({ ops: [
      previewOp(owner.metadata.id, URL, __importOpFingerprint({ stage: 'sources', kind: 'create_source', provider: 'web', conversation_id: URL })),
      { ...previewOp(owner.metadata.id, urlB, __importOpFingerprint({ stage: 'sources', kind: 'create_source', provider: 'web', conversation_id: urlB })), classification: 'UNSAFE' },
    ] }));
    const plan = await planSourcesFromPreview(services, { ...opts, previewPath: previewFile });
    expect(plan.preview_errors).toEqual([]);
    expect(plan.counts.planned).toBe(1);
    expect(plan.counts.review).toBe(1);
    expect((plan.preview_validation as { deferred_or_unknown_classification?: number }).deferred_or_unknown_classification).toBe(1);
  });

  it('plan flags an unrecognizable preview fingerprint as a blocker', async () => {
    const { root, services, opts } = await setup();
    const owner = await services.memory.create({ type: 'note', title: 'Src Owner', metadata: { source_url: URL } });
    const previewFile = path.join(root, 'preview-bad.json');
    await writeFile(previewFile, JSON.stringify({ ops: [previewOp(owner.metadata.id, URL, 'deadbeef')] }));
    const plan = await planSourcesFromPreview(services, { ...opts, previewPath: previewFile });
    expect(plan.preview_errors?.some(e => e.includes('fingerprint mismatch'))).toBe(true);
    expect((plan.preview_validation as { fingerprint_mismatches?: number }).fingerprint_mismatches).toBe(1);
  });

  it('applies one approved source, then rollback removes it byte-exactly, then re-apply reproduces bytes', async () => {
    const { root, services, opts, vault } = await setup();
    const owner = await services.memory.create({ type: 'note', title: 'Src Owner', metadata: { source_url: URL } });
    const canonical = canonicalizeUrl(URL);
    const expectedSourceId = `p3s-${createHash('sha256').update(`web|url|${canonical}`).digest('hex').slice(0, 20)}`;
    const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
    const beforeManifest = new Map<string, string>();
    for (const dir of ['03 Knowledge', 'Sources'])
      for (const file of (await readDir(path.join(vault, dir))).filter(f => f.endsWith('.md')))
        beforeManifest.set(path.join(dir, file), sha(await readFile(path.join(vault, dir, file))));

    const previewFile = path.join(root, 'preview.json');
    await writeFile(previewFile, JSON.stringify({
      ops: [previewOp(owner.metadata.id, URL, __importOpFingerprint({ stage: 'sources', kind: 'create_source', provider: 'web', conversation_id: URL }))],
    }));
    const planner = { ...opts, previewPath: previewFile };
    const plan = await planSourcesFromPreview(services, planner);
    expect(plan.preview_errors).toEqual([]);
    expect(plan.counts.planned).toBe(1);
    expect((plan.preview_validation as { preview_fingerprints_verified?: number }).preview_fingerprints_verified).toBe(1);

    const result = await applyStage(services, planner, false);
    expect(result.result?.applied).toBe(1);
    const source = await services.memory.get(expectedSourceId);
    expect(source.metadata.identity_type).toBe('url');
    expect(source.metadata.identity_value).toBe('https://example.com/phase3c');
    expect(source.metadata.derived_from).toBe(owner.metadata.id);
    expect(source.metadata.created_at).toBe('2026-10-07T12:00:00.000Z');
    expect(source.metadata.updated_at).toBe('2026-10-07T12:00:00.000Z');
    expect(source.metadata.conversation_id).toBeUndefined();
    expect(source.metadata.content_hash).toBeUndefined();
    const afterApplySha = sha(await readFile(path.join(vault, source.path)));

    const rollback = await rollbackStage(services, opts);
    expect(rollback.rolled_back).toBe(1);
    expect(rollback.lost).toEqual([]);
    expect(rollback.errors).toEqual([]);
    // Byte-identical vault after rollback (§27)
    const afterRollback = new Map<string, string>();
    for (const dir of ['03 Knowledge', 'Sources'])
      for (const file of (await readDir(path.join(vault, dir))).filter(f => f.endsWith('.md')))
        afterRollback.set(path.join(dir, file), sha(await readFile(path.join(vault, dir, file))));
    expect(afterRollback).toEqual(beforeManifest);

    // Re-apply reproduces the same bytes (§28)
    const reapply = await applyStage(services, planner, false);
    expect(reapply.result?.applied).toBe(1);
    const again = await services.memory.get(expectedSourceId);
    expect(sha(await readFile(path.join(vault, again.path)))).toBe(afterApplySha);

    // Final plan: fully applied → nothing planned (§29)
    const finalPlan = await planSourcesFromPreview(services, planner);
    expect(finalPlan.counts.planned).toBe(0);
    expect(finalPlan.skipped.every(s => s.reason === 'already_applied')).toBe(true);
  }, 30000);

  it('the delete changeset kind is restricted to migration-created sources', async () => {
    const { services } = await setup();
    const plain = await services.sources.createSource({ title: 'Plain', provider: 'web', identity_type: 'url', identity_value: 'https://example.com/plain' }) as { id: string };
    const cs = await services.maintenance.prepare('probe', [{ kind: 'delete', entity_id: plain.id }], []);
    await expect(services.maintenance.apply(cs.id, 'probe')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    const staged = await services.memory.get(plain.id);
    expect(staged.metadata.type).toBe('source'); // untouched — no generic delete
    void stat; void mkdir; void codeOf;
  }, 30000);
});

async function readDir(dir: string): Promise<string[]> {
  try { const nested = await readdir(dir, { withFileTypes: true }); return nested.filter(e => e.isFile() && e.name.endsWith('.md')).map(e => e.name); }
  catch { return []; }
}

function __importOpFingerprint(op: Record<string, unknown>): string {
  // canonical JSON + SHA-256, mirroring src/adapters/migration/migration-ledger.ts
  const canonical = (value: unknown): string => {
    if (value === undefined || value === null) return 'null';
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(v => canonical(v)).join(',')}]`;
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  };
  return createHash('sha256').update(canonical(op)).digest('hex');
}