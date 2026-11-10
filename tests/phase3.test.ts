import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readFile as read, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { compose } from '../src/composition.js';
import type { AppConfig } from '../src/config/schema.js';
import type { Services } from '../src/composition.js';
import { canonicalJson, opFingerprint, MigrationLedger as LedgerType } from '../src/adapters/migration/migration-ledger.js';
import { claimKey as claimKeyOf, structuredRelations } from '../src/domain/model.js';
import {
  applyStage, planClaims, planRelations, preflight, rollbackStage, validateStage, vaultManifest,
  type Phase3Opts,
} from '../src/migration/phase3.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function setup(): Promise<{ root: string; vault: string; services: Services; ledger: LedgerType; opts: Phase3Opts }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'universal-memory-phase3-')); roots.push(root);
  const vault = path.join(root, 'vault');
  const auditDir = path.join(root, 'state', 'audit');
  const config: AppConfig = {
    name: 'Phase-3 Test', vault_root: vault, read_only: false, audit_dir: auditDir,
    transport: 'stdio', http: { bind: '127.0.0.1', port: 3333, allowed_origins: [], bearer_token_env: 'TEST_TOKEN' },
    routing: {
      memory: { backend: 'markdown', path: '03 Knowledge/{slug}.md' },
      note: { backend: 'markdown', path: '03 Knowledge/{slug}.md' },
      person: { backend: 'markdown', path: 'People/{slug}.md' },
      project: { backend: 'markdown', path: '02 Projects/{slug}/index.md' },
      inbox: { backend: 'markdown', path: '01 Inbox/{date}-{slug}.md' },
      source: { backend: 'markdown', path: 'Sources/{provider}/{date}-{slug}.md' },
    },
  };
  const services = await compose(config);
  const ledger = new LedgerType(path.join(root, 'ledger', 'migration-ledger.jsonl'));
  const opts: Phase3Opts = { stage: 'relations', migrationTime: '2026-10-07T12:00:00.000Z', ledger };
  return { root, vault, services, ledger, opts };
}

function entity(services: Services, id: string) { return services.memory.get(id); }

describe('migration ledger', () => {
  it('derives stage-sensitive fingerprints from canonical json', async () => {
    const a = opFingerprint({ stage: 'relations', kind: 'relation', entity_id: 'E1', relation_type: 'parent', target_id: 'E2' });
    const b = opFingerprint({ stage: 'claims', kind: 'claim', entity_id: 'E1', predicate: 'cores', value: 6 });
    expect(a).not.toBe(b);
    // canonical json is object-key-order independent
    expect(opFingerprint({ stage: 'relations', target_id: 'E2', entity_id: 'E1', relation_type: 'parent', kind: 'relation' })).toBe(a);
  });
  it('resolves the latest entry per fingerprint — applied then rolled_back reads rolled_back', async () => {
    const { ledger } = await setup();
    const entry = { migration_id: 'm1', stage: 'relations', source_file: 'f.md', operation_type: 'relation', fingerprint: 'fp1', status: 'applied', timestamp: '2026-10-07T12:00:00.000Z' };
    await ledger.record(entry as never);
    expect(await ledger.statusOf('fp1')).toBe('applied');
    await ledger.record({ ...entry, status: 'rolled_back', timestamp: '2026-10-07T12:01:00.000Z' } as never);
    expect(await ledger.statusOf('fp1')).toBe('rolled_back');
    const all = await ledger.all();
    expect(all).toHaveLength(2);
  });
  it('is byte-safe on a missing ledger file', async () => {
    const { ledger } = await setup();
    expect(await ledger.statusOf('nothing')).toBeUndefined();
    expect(await ledger.all()).toEqual([]);
  });
});

describe('planRelations (batch 3A)', () => {
  async function fixture() {
    const setupResult = await setup();
    const { services } = setupResult;
    const target = await services.memory.create({ type: 'note', title: 'Target Note' });
    const good = await services.memory.create({
      type: 'note', title: 'Good Source',
      metadata: { relationships: [{ type: 'related', target_id: target.metadata.id }] },
    });
    const broken = await services.memory.create({
      type: 'note', title: 'Broken Source',
      metadata: { relationships: [{ type: 'related', target_id: '01NOPE' }] },
    });
    const malformed = await services.memory.create({
      type: 'note', title: 'Malformed Source',
      metadata: { relationships: [{ target: 'no-type-field' }] },
    });
    // structured + matching legacy twin on one entity — the migration must
    // leave this identity alone (§7: never write twice). relations is a
    // graph-managed key, so the structured twin is written via storage.write.
    const structured0 = await services.memory.create({
      type: 'note', title: 'Already Structured',
      metadata: { relationships: [{ type: 'related', target_id: target.metadata.id }] },
    });
    const structuredCur = await entity(services, structured0.metadata.id);
    await services.storage.write(structured0.metadata.id, {
      ...structuredCur.metadata,
      relations: [{ id: '01FIXTUREX', type: 'related', target_id: target.metadata.id, created_at: '2026-10-07T00:00:00.000Z', updated_at: '2026-10-07T00:00:00.000Z' }],
    } as never, structuredCur.content, structuredCur.revision);
    const structured = await entity(services, structured0.metadata.id);
    return { ...setupResult, target, good, broken, malformed, structured };
  }

  it('plans only safe legacy entries and reviews the rest', async () => {
    const f = await fixture();
    const plan = await planRelations(f.services, f.opts);
    expect(plan.counts.planned).toBe(1);
    expect(plan.ops[0]!.entity_id).toBe(f.good.metadata.id);
    expect(plan.ops[0]!.relation_id).toMatch(/^p3r-[0-9a-f]{20}$/);
    expect(plan.ops[0]!.timestamp).toBe('2026-10-07T12:00:00.000Z');
    const reviewDetail = plan.review.map(item => item.detail).join('|');
    expect(reviewDetail).toContain('does not resolve');
    expect(reviewDetail).toContain('malformed relationships entry');
    expect(reviewDetail).toContain('already structured');
  });

  it('is deterministic — two dry-runs share the planned hash (§20)', async () => {
    const f = await fixture();
    const first = await planRelations(f.services, f.opts);
    const second = await planRelations(f.services, f.opts);
    expect(first.planned_hash).toBe(second.planned_hash);
  });

  it('applies as a changeset, collapses the legacy entry, audits, and skips on re-run (§7/§26)', async () => {
    const f = await fixture();
    const first = await applyStage(f.services, f.opts, false);
    expect(first.result?.applied).toBe(1);
    expect(first.result?.failed).toBeNull();
    const after = await entity(f.services, f.good.metadata.id);
    const rel = after.metadata.relations as Array<{ id: string; type: string; target_id: string }>;
    expect(rel).toHaveLength(1);
    expect(rel[0]!.type).toBe('related');
    expect(rel[0]!.target_id).toBe(f.target.metadata.id);
    expect(after.metadata).not.toHaveProperty('relationships');
    const file = await readFile(path.join(f.vault, after.path), 'utf8');
    expect(file).toContain(`- [[Target Note]] <!-- rel:${rel[0]!.id} -->`);
    // audit event with the migration client
    const events = await f.services.audit.list(f.good.metadata.id, 10);
    expect(events.some(ev => ev.operation === 'create_relation' && ev.client === 'phase-3-migration')).toBe(true);
    // §26: second run — the legacy copy is collapsed, so nothing is planned
    // or written
    const second = await applyStage(f.services, f.opts, false);
    expect(second.result?.applied).toBe(0);
    expect(second.plan.counts.planned).toBe(0);
    const stable = await entity(f.services, f.good.metadata.id);
    expect(stable.revision).toBe(after.revision);
    // if the legacy entry reappears, its applied fingerprint skips — never a
    // duplicate write (§19)
    await f.services.storage.write(f.good.metadata.id, {
      ...after.metadata, updated_at: after.metadata.updated_at,
      relationships: [{ type: 'related', target_id: f.target.metadata.id }],
    } as never, after.content, after.revision, { timestamp: after.metadata.updated_at });
    const reAddedPlan = await planRelations(f.services, f.opts);
    expect(reAddedPlan.counts.planned).toBe(0);
    expect(reAddedPlan.skipped.map(skip => skip.reason)).toEqual(['already_applied']);
  });

  it('rolls back to the pre-migration state and re-applies byte-identically (§25)', async () => {
    const f = await fixture();
    const vault = f.vault;
    const sourceFile = await entity(f.services, f.good.metadata.id);
    const baseline = await readFile(path.join(vault, sourceFile.path), 'utf8');
    const first = await applyStage(f.services, f.opts, false);
    expect(first.result?.applied).toBe(1);
    const migratedFile = await readFile(path.join(vault, sourceFile.path), 'utf8');
    expect(migratedFile).not.toBe(baseline);
    // rollback through the canonical audit rollback path
    const rolled = await rollbackStage(f.services, f.opts);
    expect(rolled.errors).toEqual([]);
    expect(rolled.rolled_back).toBe(1);
    const restored = await readFile(path.join(vault, sourceFile.path), 'utf8');
    // §25: restore must be byte-identical to the baseline file — the
    // production round trip (same YAML engine both sides) is byte-stable.
    expect(restored).toBe(baseline);
    const parsed = await entity(f.services, f.good.metadata.id);
    expect(Array.isArray(parsed.metadata.relationships)).toBe(true);
    expect(parsed.metadata).not.toHaveProperty('relations');
    expect(parsed.content).not.toContain('<!-- rel:');
    // re-apply: deterministic ids mean the same relation id comes back
    const again = await applyStage(f.services, f.opts, false);
    expect(again.result?.applied).toBe(1);
    expect(again.result?.planned_hash).toBe(first.result?.planned_hash);
    const reApplied = await entity(f.services, f.good.metadata.id);
    const rels = reApplied.metadata.relations as Array<{ id: string }>;
    expect(rels[0]!.id).toBe(first.plan.ops[0]!.relation_id);
    // and the re-applied file must be identical to the first migration result
    const migratedAgain = await read(path.join(vault, reApplied.path), 'utf8');
    expect(migratedAgain).toBe(migratedFile);
    const rolledBackEntries = await f.ledger.all();
    expect(rolledBackEntries.filter(entry => entry.status === 'rolled_back').length).toBe(1);
  });
});

describe('planClaims (batch 3B)', () => {
  it('plans scalar fact keys with unknown temporality (valid_from empty) and reviews prose', async () => {
    const { services, ledger, opts: base } = await setup();
    const opts = { ...base, stage: 'claims' as const };
    await services.memory.create({ type: 'note', title: 'Fact Holder', metadata: { vendor: 'AMD', cores: 6, poznámka: 'freeform', SOURCE_URL: 'x', TASK_ID_3: 'y' } });
    await services.memory.create({ type: 'note', title: 'Long Prose', metadata: { popis: 'x'.repeat(250) } });
    const plan = await planClaims(services, opts);
    const planned = plan.ops.map(op => op.predicate).sort();
    expect(planned).toEqual(['cores', 'vendor']);
    for (const op of plan.ops) expect(op.valid_from).toBe('');
    expect(plan.review.some(item => item.detail.includes('oversized value for popis'))).toBe(true);
    const nonPredicate = plan.review.filter(item => /predicate form|non-scalar/.test(item.detail));
    expect(nonPredicate.some(item => item.entity_id !== undefined)).toBe(true);
    void ledger;
  });
  it('skips a key that already holds an identical current claim', async () => {
    const { services, opts: base } = await setup();
    const opts = { ...base, stage: 'claims' as const };
    const holder = await services.memory.create({ type: 'note', title: 'Already Claimed', metadata: { vendor: 'AMD' } });
    await services.graph.createClaim(holder.metadata.id, { predicate: 'vendor', value: 'AMD', valid_from: '' }, holder.revision);
    const plan = await planClaims(services, opts);
    expect(plan.counts.planned).toBe(0);
    expect(plan.skipped.some(skip => skip.entity_id === holder.metadata.id && skip.reason === 'already_claimed')).toBe(true);
  });
  it('reviews a key whose current claim holds a different value — never auto-converts (§10)', async () => {
    const { services, opts: base } = await setup();
    const opts = { ...base, stage: 'claims' as const };
    const holder = await services.memory.create({ type: 'note', title: 'Conflict', metadata: { vendor: 'AMD' } });
    await services.graph.createClaim(holder.metadata.id, { predicate: 'vendor', value: 'Intel', valid_from: '' }, holder.revision);
    const plan = await planClaims(services, opts);
    expect(plan.counts.planned).toBe(0);
    expect(plan.review.some(item => item.detail.includes('holds different value'))).toBe(true);
  });
});

describe('planClaimsFromPreview (batch 3B execution — §4 the preview is authoritative)', () => {
  async function previewFixture() {
    const setupResult = await setup();
    const { opts: base, vault } = setupResult;
    return { ...setupResult, base, vault };
  }
  const writePreview = async (file: string, ops: unknown[], model?: unknown): Promise<void> => {
    const fsMod = await import('node:fs/promises');
    await fsMod.writeFile(file, JSON.stringify({ model: model ?? {}, note: 'approved preview', ops }, null, 2));
  };
  const approvedOp = (holder: Awaited<ReturnType<Services['memory']['get']>>, predicate: string, value: unknown) => ({
    operation_type: 'claim_changeset_op', entity_id: holder.metadata.id, predicate, value,
    canonical_value: value, classification: 'SAFE_CLAIM', provenance: 'EXPLICIT_SOURCE',
    reason: 'test', temporal: 'unknown', source_ids: [], valid_from: '', valid_to: null,
    source_field: predicate, source_file: holder.path, status: null, confidence: 0.9,
    claim_id: `p3c-${createHash('sha256').update(`${holder.metadata.id}|${claimKeyOf({ predicate, value, valid_to: null })}`).digest('hex').slice(0, 20)}`,
    fingerprint: opFingerprint({ stage: 'claims', kind: 'claim', entity_id: holder.metadata.id, predicate, value, valid_from: '' }),
  });
  const optsFor = (base: Phase3Opts, previewPath: string): Phase3Opts & { previewPath: string } => ({ ...base, stage: 'claims' as const, previewPath });
  const importAll = async () => {
    const mod = await import('../src/migration/phase3.js');
    return { planClaimsFromPreview: mod.planClaimsFromPreview };
  };

  it('plans exactly the approved ops, executes them, and re-plans to zero (idempotence, §17/§27)', async () => {
    const f = await previewFixture();
    const { planClaimsFromPreview } = await importAll();
    const holder = await f.services.memory.create({ type: 'note', title: 'Approved', metadata: { vendor: 'AMD', cores: 6 } });
    const previewFile = path.join(f.root, 'preview.json');
    await writePreview(previewFile, [approvedOp(holder, 'vendor', 'AMD'), approvedOp(holder, 'cores', 6)]);
    const opts = optsFor(f.base, previewFile);
    const plan = await planClaimsFromPreview(f.services, opts);
    expect(plan.preview_errors).toEqual([]);
    expect(plan.preview_validation?.approved).toBe(2);
    expect((plan.preview_validation as { unique_fingerprints?: number }).unique_fingerprints).toBe(2);
    expect(plan.counts.planned).toBe(2);
    expect(plan.ops.every(op => op.valid_from === '' &&op.source_ids?.length===0)).toBe(true);
    const applied = await applyStage(f.services, opts, false);
    expect(applied.result?.applied).toBe(2);
    const after = await f.services.memory.get(holder.metadata.id);
    expect((after.metadata.claims as Array<{ predicate: string; value: unknown; valid_from: string }>).map(c => [c.predicate, c.value, c.valid_from]).sort()).toEqual([['cores', 6, ''], ['vendor', 'AMD', '']]);
    // idempotent re-plan: every applied fingerprint reads `already_applied`
    const replan = await planClaimsFromPreview(f.services, opts);
    expect(replan.counts.planned).toBe(0);
    expect(replan.skipped.every(s => s.reason === 'already_applied')).toBe(true);
  });

  it('skips an already-equivalent live claim and blocks a live conflicting claim (§13)', async () => {
    const f = await previewFixture();
    const { planClaimsFromPreview } = await importAll();
    const same = await f.services.memory.create({ type: 'note', title: 'Same', metadata: { vendor: 'AMD' } });
    await f.services.graph.createClaim(same.metadata.id, { predicate: 'vendor', value: 'AMD', valid_from: '' }, same.revision);
    const previewFile = path.join(f.root, 'preview.json');
    await writePreview(previewFile, [approvedOp(same, 'vendor', 'AMD')]);
    const plan = await planClaimsFromPreview(f.services, optsFor(f.base, previewFile));
    expect(plan.preview_errors).toEqual([]);
    expect(plan.counts.planned).toBe(0);
    expect(plan.skipped[0]?.reason).toBe('already_claimed');
    const conflicting = await f.services.memory.create({ type: 'note', title: 'Other', metadata: { vendor: 'AMD' } });
    await f.services.graph.createClaim(conflicting.metadata.id, { predicate: 'vendor', value: 'Intel', valid_from: '' }, conflicting.revision);
    const badFile = path.join(f.root, 'preview-conflict.json');
    await writePreview(badFile, [approvedOp(conflicting, 'vendor', 'AMD')]);
    const badPlan = await planClaimsFromPreview(f.services, optsFor(f.base, badFile));
    expect(badPlan.preview_errors?.some(e => e.includes('live conflict'))).toBe(true);
    expect((badPlan.preview_validation as { conflicting_claims?: number }).conflicting_claims).toBe(1);
    await expect(applyStage(f.services, optsFor(f.base, badFile), false)).rejects.toThrow(/preview validation failed/);
  });

  it('blocks preview inconsistencies: wrong fingerprint, wrong claim id, non-SAFE classification, malformed field (§6–§8)', async () => {
    const f = await previewFixture();
    const { planClaimsFromPreview } = await importAll();
    const holder = await f.services.memory.create({ type: 'note', title: 'Guarded', metadata: { vendor: 'AMD' } });
    const good = approvedOp(holder, 'vendor', 'AMD');
    const cases: Array<[string, Record<string, unknown>]> = [
      ['fingerprint mismatch', { ...good, fingerprint: '0'.repeat(64) }],
      ['claim_id mismatch', { ...good, claim_id: 'p3c-00000000000000000000' }],
      ['deferred classification', { ...good, classification: 'REVIEW' }],
      ['inferred valid_from', { ...good, valid_from: '2026-10-07' }],
      ['invented source', { ...good, source_ids: ['01SRC'] }],
      ['entity moved', { ...good, source_file: 'elsewhere/x.md' }],
      ['status mapped', { ...good, status: 'current' }],
      ['value/canonical divergence', { ...good, canonical_value: 'AMD ' }],
    ];
    for (const [label, op] of cases) {
      const file = path.join(f.root, `preview-${label.replace(/\W+/g, '-')}.json`);
      await writePreview(file, [op]);
      const plan = await planClaimsFromPreview(f.services, optsFor(f.base, file));
      expect(plan.preview_errors?.length, label).toBe(1);
      expect(plan.counts.planned, label).toBe(0);
    }
    // missing entity in the live vault
    const file2 = path.join(f.root, 'preview-missing.json');
    await writePreview(file2, [approvedOp(holder, 'vendor', 'AMD'), { ...approvedOp(holder, 'cores', 6), entity_id: '01MISSING' }]);
    void file2;
    const bad = await planClaimsFromPreview(f.services, optsFor(f.base, file2));
    expect(bad.preview_errors?.some(e => e.includes('01MISSING'))).toBe(true);
  });

  it('refuses a claims apply without a preview path (§4 authorization guard)', async () => {
    const f = await previewFixture();
    await f.services.memory.create({ type: 'note', title: 'No Preview', metadata: { vendor: 'AMD' } });
    await expect(applyStage(f.services, { ...f.base, stage: 'claims' }, false)).rejects.toThrow(/claims stage requires --preview/);
  });

  it('runs a preview-driven claims round trip: apply → rollback byte-identical → re-apply (§25/§26)', async () => {
    const f = await previewFixture();
    const { planClaimsFromPreview } = await importAll();
    const holder = await f.services.memory.create({ type: 'note', title: 'Rolltrip', metadata: { vendor: 'AMD' } });
    const previewFile = path.join(f.root, 'preview.json');
    await writePreview(previewFile, [approvedOp(holder, 'vendor', 'AMD')]);
    const opts = optsFor(f.base, previewFile);
    // first plan (to learn claim_id), then apply once via the same path
    const plan = await planClaimsFromPreview(f.services, opts);
    expect(plan.preview_errors).toEqual([]);
    const fileBefore = await read(path.join(f.vault, holder.path), 'utf8');
    const first = await applyStage(f.services, opts, false);
    expect(first.result?.applied).toBe(1);
    const migrated = await read(path.join(f.vault, holder.path), 'utf8');
    expect(migrated).not.toBe(fileBefore);
    const rollback = await rollbackStage(f.services, opts);
    expect(rollback.errors).toEqual([]);
    expect(rollback.rolled_back).toBe(1);
    expect(await read(path.join(f.vault, holder.path), 'utf8')).toBe(fileBefore);
    const again = await applyStage(f.services, opts, false);
    expect(again.result?.applied).toBe(1);
    expect(again.plan.ops[0]?.claim_id).toBe(plan.ops[0]?.claim_id);
    expect(await read(path.join(f.vault, holder.path), 'utf8')).toBe(migrated);
    const final = await planClaimsFromPreview(f.services, opts);
    expect(final.counts.planned).toBe(0);
    expect(final.skipped.map(s => s.reason)).toEqual(['already_applied']);
  });
});

describe('pre-flight (§22)', () => {
  it('matches a freshly written manifest and reports drift', async () => {
    const { root, services, ledger, opts } = await setup();
    await services.memory.create({ type: 'note', title: 'One' });
    await services.memory.create({ type: 'note', title: 'Two' });
    const fsMod = await import('node:fs/promises');
    const { text, count } = await vaultManifest(services);
    expect(count).toBe(2);
    const manifestPath = path.join(root, 'manifest.txt');
    await fsMod.writeFile(manifestPath, text);
    const baseline = await preflight(services, opts, { baselineManifest: manifestPath, expected_count: 2 });
    expect(baseline.ok).toBe(true);
    expect(baseline.baseline_manifest.checked).toBe(true);
    expect(baseline.baseline_manifest.identical).toBe(true);
    // drift: touch the file
    const one = (await services.memory.search({ query: 'One' }))[0]!;
    await services.memory.update(one.metadata.id, { content: 'changed' }, one.revision);
    void ledger;
    const drifted = await preflight(services, opts, { baselineManifest: manifestPath, expected_count: 2 });
    expect(drifted.ok).toBe(false);
    expect(drifted.baseline_manifest.changed).toHaveLength(1);
  });
  it('flags the audit log when it changed since the baseline snapshot', async () => {
    const { root, services, ledger, opts } = await setup();
    // nothing written to the vault after creation — file count 1
    await services.memory.create({ type: 'note', title: 'One' });
    const auditPath = path.join(root, 'state', 'audit', 'events.jsonl');
    const baselineAudit = path.join(root, 'state', 'baseline-events.jsonl');
    const fsMod = await import('node:fs/promises');
    await fsMod.copyFile(auditPath, baselineAudit);
    const clean = await preflight(services, opts, { auditPath, baselineAudit, expected_count: 1 });
    expect(clean.audit_log.unchanged).toBe(true);
    expect(clean.ok).toBe(true);
    // append an extra event → unchanged must flip
    await fsMod.appendFile(auditPath, `${canonicalJson({ tampered: 1 })}\n`);
    const changed = await preflight(services, opts, { auditPath, baselineAudit, expected_count: 1 });
    expect(changed.audit_log.unchanged).toBe(false);
    expect(changed.ok).toBe(false);
    void ledger;
  });
});

describe('validateStage (§24)', () => {
  it('verifies migrated relations, markers, and the resolver checks', async () => {
    const setupResult = await setup();
    const { services, opts } = setupResult;
    const a = await services.memory.create({ type: 'note', title: 'Alpha', metadata: { relationships: [{ type: 'related', target_id: '' }] } });
    const b = await services.memory.create({ type: 'note', title: 'Beta', metadata: { aliases: ['Bee'] } });
    const current = await entity(services, a.metadata.id);
    await services.storage.write(a.metadata.id, { ...current.metadata, relationships: [{ type: 'related', target_id: b.metadata.id }] } as never, current.content, current.revision);
    await applyStage(services, opts, false);
    const validation = await validateStage(services, opts);
    expect(validation.migrated_relations.missing).toEqual([]);
    expect(validation.migrated_relations.intentionally_deleted).toEqual([]);
    expect(validation.migrated_relations.found).toBe(1);
    expect(validation.markers_missing).toBe(0);
    expect(validation.duplicate_identities).toEqual([]);
    expect(validation.resolver).toEqual({ id: true, title: true, alias: true, path: true, broken_path_is_empty: true, path_collision_ambiguous: false });
    expect(validation.resolver_probe).toEqual({ status: 'active', source_id: a.metadata.id, target_id: b.metadata.id });
  });

  it('never probes an archived endpoint: reports no_valid_active_probe instead of a false failure', async () => {
    const { services, opts } = await setup();
    const a = await services.memory.create({ type: 'note', title: 'Alpha', metadata: { relationships: [{ type: 'related', target_id: '' }] } });
    const b = await services.memory.create({ type: 'note', title: 'Beta', metadata: { aliases: ['Bee'] } });
    const current = await entity(services, a.metadata.id);
    await services.storage.write(a.metadata.id, { ...current.metadata, relationships: [{ type: 'related', target_id: b.metadata.id }] } as never, current.content, current.revision);
    await applyStage(services, opts, false);
    const before = await validateStage(services, opts);
    expect(before.resolver_probe).toEqual({ status: 'active', source_id: a.metadata.id, target_id: b.metadata.id });

    await services.memory.archive(b.metadata.id, (await entity(services, b.metadata.id)).revision, 'test:archive');
    const after = await validateStage(services, opts);
    // No fallback to the archived pair, and no include_archived: the probe is simply unavailable.
    expect(after.resolver_probe).toEqual({ status: 'no_valid_active_probe' });
    expect(after.resolver).toEqual({ id: false, title: false, alias: false, path: false, broken_path_is_empty: false, path_collision_ambiguous: false });
    // Migration integrity itself is unaffected by the archive.
    expect(after.migrated_relations.found).toBe(1);
    expect(after.migrated_relations.missing).toEqual([]);
    expect(after.markers_missing).toBe(0);
  });

  it('prefers an active pair when an archived pair is planned earlier in the ledger', async () => {
    const { services, opts } = await setup();
    const archivedHolder = await services.memory.create({ type: 'note', title: 'ArchivedHolder', metadata: { relationships: [{ type: 'related', target_id: '' }] } });
    const archivedTarget = await services.memory.create({ type: 'note', title: 'ArchivedTarget' });
    const first = await entity(services, archivedHolder.metadata.id);
    await services.storage.write(archivedHolder.metadata.id, { ...first.metadata, relationships: [{ type: 'related', target_id: archivedTarget.metadata.id }] } as never, first.content, first.revision);
    await services.memory.archive(archivedHolder.metadata.id, (await entity(services, archivedHolder.metadata.id)).revision, 'test:archive');

    const activeHolder = await services.memory.create({ type: 'note', title: 'ActiveHolder', metadata: { relationships: [{ type: 'related', target_id: '' }] } });
    const activeTarget = await services.memory.create({ type: 'note', title: 'ActiveTarget' });
    const second = await entity(services, activeHolder.metadata.id);
    await services.storage.write(activeHolder.metadata.id, { ...second.metadata, relationships: [{ type: 'related', target_id: activeTarget.metadata.id }] } as never, second.content, second.revision);

    await applyStage(services, opts, false);
    const validation = await validateStage(services, opts);
    expect(validation.migrated_relations.found).toBe(2);
    expect(validation.resolver_probe.status).toBe('active');
    expect(validation.resolver_probe.source_id).not.toBe(archivedHolder.metadata.id);
    expect(validation.resolver_probe.source_id).toBe(activeHolder.metadata.id);
    expect(validation.resolver_probe.target_id).toBe(activeTarget.metadata.id);
    expect(validation.resolver.id).toBe(true);
    expect(validation.resolver.title).toBe(true);
  });

  it('an archived entity does not create a path collision for the basename probe', async () => {
    const { services, opts } = await setup();
    // Two project entities share the basename "index" (02 Projects/<slug>/index.md).
    const projectA = await services.memory.create({ type: 'project', title: 'Project One', metadata: { relationships: [{ type: 'related', target_id: '' }] } });
    const projectB = await services.memory.create({ type: 'project', title: 'Project Two' });
    const partner = await services.memory.create({ type: 'note', title: 'ProbePartner' });
    const current = await entity(services, projectA.metadata.id);
    await services.storage.write(projectA.metadata.id, { ...current.metadata, relationships: [{ type: 'related', target_id: partner.metadata.id }] } as never, current.content, current.revision);
    await applyStage(services, opts, false);

    const before = await validateStage(services, opts);
    expect(before.resolver_probe.status).toBe('active');
    expect(before.resolver.path_collision_ambiguous).toBe(true);

    await services.memory.archive(projectB.metadata.id, (await entity(services, projectB.metadata.id)).revision, 'test:archive');
    const after = await validateStage(services, opts);
    expect(after.resolver_probe.status).toBe('active');
    expect(after.resolver.path_collision_ambiguous).toBe(false);
  });
});

describe('validateStage: migration history vs. later audited mutations (§24F)', () => {
  async function migrateOneRelation(services: Services, opts: Phase3Opts) {
    const a = await services.memory.create({ type: 'note', title: 'Alpha', metadata: { relationships: [{ type: 'related', target_id: '' }] } });
    const b = await services.memory.create({ type: 'note', title: 'Beta' });
    const current = await entity(services, a.metadata.id);
    await services.storage.write(a.metadata.id, { ...current.metadata, relationships: [{ type: 'related', target_id: b.metadata.id }] } as never, current.content, current.revision);
    const plan = await planRelations(services, opts);
    await applyStage(services, opts, false);
    return { a, b, relationId: plan.ops[0]!.relation_id! };
  }

  it('an audited delete_relation is reconciliation, not migration drift', async () => {
    const { services, opts } = await setup();
    const { a, relationId } = await migrateOneRelation(services, opts);
    const holder = await entity(services, a.metadata.id);
    await services.graph.deleteRelation(a.metadata.id, relationId, holder.revision, 'test:cleanup');
    const validation = await validateStage(services, opts);
    expect(validation.migrated_relations.expected).toBe(1);
    expect(validation.migrated_relations.found).toBe(0);
    expect(validation.migrated_relations.missing).toEqual([]);
    expect(validation.migrated_relations.intentionally_deleted).toHaveLength(1);
    const item = validation.migrated_relations.intentionally_deleted[0]!;
    expect(item.entity_id).toBe(a.metadata.id);
    expect(item.relation_id).toBe(relationId);
    expect(item.audit_event_id).toMatch(/^[0-9A-Z]{26}$/);
    expect(item.deleted_at).toBeTypeOf('string');
    expect(item.deleted_by).toBe('test:cleanup');
  });

  it('a relation removed without an audit event stays missing', async () => {
    const { services, opts } = await setup();
    const { a, relationId } = await migrateOneRelation(services, opts);
    const holder = await entity(services, a.metadata.id);
    const metadata = { ...holder.metadata } as Record<string, unknown>;
    delete metadata.relations;
    await services.storage.write(a.metadata.id, metadata as never, holder.content, holder.revision);
    const validation = await validateStage(services, opts);
    expect(validation.migrated_relations.expected).toBe(1);
    expect(validation.migrated_relations.found).toBe(0);
    expect(validation.migrated_relations.intentionally_deleted).toEqual([]);
    expect(validation.migrated_relations.missing).toEqual([{ entity_id: a.metadata.id, relation_id: relationId }]);
  });

  it('an audited deletion of a different relation never excuses the missing one', async () => {
    const { services, opts } = await setup();
    const a = await services.memory.create({ type: 'note', title: 'Alpha', metadata: { relationships: [{ type: 'related', target_id: '' }, { type: 'related', target_id: '' }] } });
    const b = await services.memory.create({ type: 'note', title: 'Beta' });
    const c = await services.memory.create({ type: 'note', title: 'Gamma' });
    const current = await entity(services, a.metadata.id);
    await services.storage.write(a.metadata.id, { ...current.metadata, relationships: [{ type: 'related', target_id: b.metadata.id }, { type: 'related', target_id: c.metadata.id }] } as never, current.content, current.revision);
    const plan = await planRelations(services, opts);
    await applyStage(services, opts, false);
    const relationToC = plan.ops.find(op => op.target_id === c.metadata.id)!.relation_id!;
    const relationToB = plan.ops.find(op => op.target_id === b.metadata.id)!.relation_id!;
    const holder = await entity(services, a.metadata.id);
    await services.graph.deleteRelation(a.metadata.id, relationToC, holder.revision, 'test:cleanup');
    // B is then stripped straight from storage — no audit trail at all.
    const afterDelete = await entity(services, a.metadata.id);
    const metadata = { ...afterDelete.metadata } as Record<string, unknown>;
    metadata.relations = structuredRelations(afterDelete.metadata).filter(edge => edge.id !== relationToB);
    await services.storage.write(a.metadata.id, metadata as never, afterDelete.content, afterDelete.revision);
    const validation = await validateStage(services, opts);
    expect(validation.migrated_relations.expected).toBe(2);
    expect(validation.migrated_relations.found).toBe(0);
    expect(validation.migrated_relations.intentionally_deleted).toHaveLength(1);
    expect(validation.migrated_relations.intentionally_deleted[0]!.relation_id).toBe(relationToC);
    expect(validation.migrated_relations.missing).toEqual([{ entity_id: a.metadata.id, relation_id: relationToB }]);
  });

  it('a delete event whose before snapshot does not contain the relation is not accepted', async () => {
    const { services, opts } = await setup();
    const { a, relationId } = await migrateOneRelation(services, opts);
    const holder = await entity(services, a.metadata.id);
    const metadata = { ...holder.metadata } as Record<string, unknown>;
    delete metadata.relations;
    await services.storage.write(a.metadata.id, metadata as never, holder.content, holder.revision);
    const stripped = await entity(services, a.metadata.id);
    // A malformed/foreign audit event: right entity, right relation id in the
    // details, but the snapshots prove the relation was never removed by it.
    await services.audit.append({
      id: '01TESTSNAPSHOTMISMATCH000000',
      timestamp: new Date().toISOString(),
      operation: 'delete_relation',
      entity_id: a.metadata.id,
      client: 'test:malformed',
      before_snapshot: '01TESTSNAPSHOTMISMATCH000000-before.json',
      after_snapshot: '01TESTSNAPSHOTMISMATCH000000-after.json',
      details: { relation_id: relationId, type: 'related', target_id: stripped.metadata.id },
    }, stripped, stripped);
    const validation = await validateStage(services, opts);
    expect(validation.migrated_relations.intentionally_deleted).toEqual([]);
    expect(validation.migrated_relations.missing).toEqual([{ entity_id: a.metadata.id, relation_id: relationId }]);
  });

  it('a delete event older than the migration entry is not accepted', async () => {
    const { services, opts } = await setup();
    const { a, relationId } = await migrateOneRelation(services, opts);
    const holder = await entity(services, a.metadata.id);
    const metadata = { ...holder.metadata } as Record<string, unknown>;
    delete metadata.relations;
    await services.storage.write(a.metadata.id, metadata as never, holder.content, holder.revision);
    const ledgerEntry = (await opts.ledger.all()).find(entry => entry.details?.relation_id === relationId)!;
    const stripped = await entity(services, a.metadata.id);
    const earlier = new Date(Date.parse(ledgerEntry.timestamp) - 60_000).toISOString();
    await services.audit.append({
      id: '01TESTDELETIONBEFOREMIGRATION00',
      timestamp: earlier,
      operation: 'delete_relation',
      entity_id: a.metadata.id,
      client: 'test:out-of-order',
      before_snapshot: '01TESTDELETIONBEFOREMIGRATION00-before.json',
      after_snapshot: '01TESTDELETIONBEFOREMIGRATION00-after.json',
      details: { relation_id: relationId, type: 'related', target_id: stripped.metadata.id },
    }, stripped, stripped);
    const validation = await validateStage(services, opts);
    expect(validation.migrated_relations.intentionally_deleted).toEqual([]);
    expect(validation.migrated_relations.missing).toEqual([{ entity_id: a.metadata.id, relation_id: relationId }]);
  });

  it('a relation deleted and then re-added with the same id is found again', async () => {
    const { services, opts } = await setup();
    const { a, b, relationId } = await migrateOneRelation(services, opts);
    const holder = await entity(services, a.metadata.id);
    await services.graph.deleteRelation(a.metadata.id, relationId, holder.revision, 'test:cleanup');
    const afterDelete = await entity(services, a.metadata.id);
    const relations = structuredRelations(afterDelete.metadata);
    relations.push({ id: relationId, type: 'related', target_id: b.metadata.id, created_at: opts.migrationTime, updated_at: opts.migrationTime });
    await services.storage.write(a.metadata.id, { ...afterDelete.metadata, relations } as never, `${afterDelete.content}\n- rel:${relationId}`, afterDelete.revision);
    const validation = await validateStage(services, opts);
    expect(validation.migrated_relations.expected).toBe(1);
    expect(validation.migrated_relations.found).toBe(1);
    expect(validation.migrated_relations.intentionally_deleted).toEqual([]);
    expect(validation.migrated_relations.missing).toEqual([]);
    expect(validation.markers_missing).toBe(0);
  });
});