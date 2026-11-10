import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { compose } from '../src/composition.js';
import type { AppConfig } from '../src/config/schema.js';
import type { Services } from '../src/composition.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup(readOnly = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'universal-memory-graph-')); roots.push(root);
  const vault = path.join(root, 'vault');
  const config: AppConfig = {
    name: 'Graph Test', vault_root: vault, read_only: readOnly, audit_dir: path.join(root, 'state', 'audit'),
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
  return { root, vault, services: await compose(config) };
}
async function entity(services: Services, id: string) { return services.memory.get(id); }

describe('resolve_entity', () => {
  it('resolves an exact title with full confidence', async () => {
    const { services } = await setup();
    const { entity: ada } = await services.people.create('Ada Lovelace', 'First programmer');
    const result = await services.graph.resolve({ query: 'Ada Lovelace' }) as { resolved?: { id: string; confidence: number; match: string }; ambiguous: boolean };
    expect(result.ambiguous).toBe(false);
    expect(result.resolved).toMatchObject({ id: ada.metadata.id, confidence: 1, match: 'exact' });
  });
  it('resolves an alias, a normalized form, and a compact form', async () => {
    const { services } = await setup();
    const gpu = await services.memory.create({ type: 'note', title: 'RTX 2070', metadata: { aliases: ['RTX 2070 Super'] } });
    const byAlias = await services.graph.resolve({ query: 'RTX 2070 Super' }) as { resolved?: { id: string; match: string } };
    expect(byAlias.resolved).toMatchObject({ id: gpu.metadata.id, match: 'exact' });
    const normalized = await services.graph.resolve({ query: 'rtx 2070' }) as { resolved?: { id: string; match: string; confidence: number } };
    expect(normalized.resolved).toMatchObject({ id: gpu.metadata.id, match: 'normalized', confidence: 0.9 });
    const compact = await services.graph.resolve({ query: 'rtx2070super' }) as { resolved?: { id: string; match: string; confidence: number } };
    expect(compact.resolved).toMatchObject({ id: gpu.metadata.id, match: 'compact', confidence: 0.8 });
  });
  it('reports ambiguity without selecting, and validates an optional hint', async () => {
    const { services } = await setup();
    const { entity: a } = await services.people.create('Jan Novák');
    const { entity: b } = await services.people.create('Jan Novák ml.');
    await services.memory.update(b.metadata.id, { metadata: { aliases: ['Jan Novák'] } }, b.revision);
    const first = await services.graph.resolve({ query: 'Jan Novák' }) as { ambiguous: boolean; resolved?: unknown; candidates: Array<{ id: string }> };
    expect(first.ambiguous).toBe(true);
    expect(first.resolved).toBeUndefined();
    expect(first.candidates.map(candidate => candidate.id).sort()).toEqual([a.metadata.id, b.metadata.id].sort());
    const hinted = await services.graph.resolve({ query: 'Jan Novák', hint_id: a.metadata.id }) as { hint: { hint_valid: boolean } };
    expect(hinted.hint).toEqual({ hint_id: a.metadata.id, hint_valid: true });
    const wrong = await services.graph.resolve({ query: 'Jan Novák', hint_id: '01ABCD' }) as { hint: { hint_valid: boolean } };
    expect(wrong.hint.hint_valid).toBe(false);
  });
  it('reports alias collisions through inspect diagnostics without resolving for anyone', async () => {
    const { services } = await setup();
    await services.people.create('Alpha One', '', { aliases: ['Shared'] });
    await services.people.create('Alpha Two', '', { aliases: ['Shared'] });
    const report = await services.maintenance.inspect({ kind: 'vault' });
    expect(report.diagnostics.filter(d => d.code === 'ALIAS_COLLISION').map(d => d.message).join('\n')).toContain('shared');
  });
});

describe('relations', () => {
  async function graph() {
    const { services, vault: setupVault } = await setup();
    const cpu = await services.memory.create({ type: 'note', title: 'CPU' });
    const board = await services.memory.create({ type: 'note', title: 'Motherboard' });
    const chassis = await services.memory.create({ type: 'note', title: 'Chassis' });
    return { services, cpu, board, chassis, vault: setupVault };
  }
  it('creates an idempotent relation with a marker section in the body', async () => {
    const { services, cpu, board, vault } = await graph();
    const first = await services.graph.createRelation({ entity_id: cpu.metadata.id, relation_type: 'installed_in', target_id: board.metadata.id, expected_revision: cpu.revision }) as { created: boolean; relation: { id: string } };
    expect(first.created).toBe(true);
    const file = await readFile(path.join(vault, cpu.path), 'utf8');
    expect(file).toContain('## Relations');
    expect(file).toContain(`- [[Motherboard]] <!-- rel:${first.relation.id} -->`);
    const second = await services.graph.createRelation({ entity_id: cpu.metadata.id, relation_type: 'installed_in', target_id: board.metadata.id, expected_revision: cpu.revision }) as { created: boolean; relation: { id: string } };
    expect(second.created).toBe(false);
    expect(second.relation.id).toBe(first.relation.id);
  });
  it('reads legacy relationships through the shim without rewriting the file', async () => {
    const { services, board } = await graph();
    await services.memory.create({
      type: 'note', title: 'Legacy Note',
      content: 'points at note', metadata: { relationships: [{ type: 'installed_in', target_id: board.metadata.id }] },
    });
    const legacy = (await services.memory.search({ types: ['note'], query: 'Legacy Note' }))[0]!;
    const listed = await services.graph.relationsOf(legacy.metadata.id) as { relations: Array<{ id: string; legacy?: boolean; target: { id: string } }> };
    expect(listed.relations[0]!.id).toMatch(/^legacy-[0-9a-f]{12}$/);
    expect(listed.relations[0]!.legacy).toBe(true);
    expect(listed.relations[0]!.target.id).toBe(board.metadata.id);
  });
  it('structures a legacy-only duplicate on write, no-ops against a structured twin, collapses on other writes', async () => {
    const { services, board } = await graph();
    const legacy = await services.memory.create({ type: 'note', title: 'Legacy Dup', metadata: { relationships: [{ type: 'installed_in', target_id: board.metadata.id }] } });
    // legacy-only duplicate: the write is the migration itself — it structures
    // the identity and collapses the shim copy (audited update)
    const migrated = await services.graph.createRelation({ entity_id: legacy.metadata.id, relation_type: 'installed_in', target_id: board.metadata.id, expected_revision: legacy.revision }) as { created: boolean; relation: { id: string } };
    expect(migrated.created).toBe(true);
    const after = await entity(services, legacy.metadata.id);
    expect(Array.isArray(after.metadata.relations)).toBe(true);
    expect(after.metadata).not.toHaveProperty('relationships');
    // structured duplicate: no write, same relation id back
    const dup = await services.graph.createRelation({ entity_id: legacy.metadata.id, relation_type: 'installed_in', target_id: board.metadata.id, expected_revision: after.revision }) as { created: boolean; relation: { id: string } };
    expect(dup.created).toBe(false);
    expect(dup.relation.id).toBe(migrated.relation.id);
    // a different-relation write on a legacy holder still collapses the twin
    const mixed = await services.memory.create({ type: 'note', title: 'Legacy Mix', metadata: { relationships: [{ type: 'contains', target_id: board.metadata.id }] } });
    const created = await services.graph.createRelation({ entity_id: mixed.metadata.id, relation_type: 'purchased_at', target_id: board.metadata.id, expected_revision: mixed.revision }) as { created: boolean };
    expect(created.created).toBe(true);
    const afterMix = await entity(services, mixed.metadata.id);
    expect(
      Array.isArray(afterMix.metadata.relationships) ? (afterMix.metadata.relationships as unknown[]).length : 0,
    ).toBe(1); // the untouched legacy twin stays
  });
  it('answers outgoing, incoming, type-filtered, and both-direction queries', async () => {
    const { services, cpu, board, chassis } = await graph();
    await services.graph.createRelation({ entity_id: cpu.metadata.id, relation_type: 'installed_in', target_id: board.metadata.id, expected_revision: cpu.revision });
    await services.graph.createRelation({ entity_id: chassis.metadata.id, relation_type: 'contains', target_id: board.metadata.id, expected_revision: chassis.revision });
    const outgoing = await services.graph.query({ entity_id: cpu.metadata.id, direction: 'outgoing' }) as { relations: Array<{ relation: { target_id: string } }> };
    expect(outgoing.relations.map(edge => edge.relation.target_id)).toEqual([board.metadata.id]);
    const incoming = await services.graph.query({ entity_id: board.metadata.id, direction: 'incoming' }) as { relations: Array<{ source_id: string }> };
    expect(incoming.relations.map(edge => edge.source_id).sort()).toEqual([cpu.metadata.id, chassis.metadata.id].sort());
    const typed = await services.graph.query({ entity_id: board.metadata.id, direction: 'incoming', relation_type: 'contains' }) as { relations: Array<{ source_id: string }> };
    expect(typed.relations.map(edge => edge.source_id)).toEqual([chassis.metadata.id]);
  });
  it('traverses depth 2 and stays cycle-safe', async () => {
    const { services, cpu, board, chassis } = await graph();
    await services.graph.createRelation({ entity_id: cpu.metadata.id, relation_type: 'installed_in', target_id: board.metadata.id, expected_revision: cpu.revision });
    await services.graph.createRelation({ entity_id: board.metadata.id, relation_type: 'installed_in', target_id: chassis.metadata.id, expected_revision: board.revision });
    const two = await services.graph.query({ entity_id: cpu.metadata.id, direction: 'outgoing', depth: 2 }) as { relations: Array<{ depth: number; relation: { target_id: string } }> };
    expect(two.relations.map(edge => edge.depth)).toEqual([1, 2]);
    expect(two.relations[1]!.relation.target_id).toBe(chassis.metadata.id);
    // a→b and b→a: depth-2 outgoing traversal terminates
    const boardEntity = await entity(services, board.metadata.id);
    await services.graph.createRelation({ entity_id: board.metadata.id, relation_type: 'powers', target_id: cpu.metadata.id, expected_revision: boardEntity.revision });
    const cycled = await services.graph.query({ entity_id: cpu.metadata.id, direction: 'outgoing', depth: 2 }) as { relations: Array<{ relation: { target_id: string } }> };
    expect(cycled.relations.length).toBe(3); // a→b (1), b→c and b→a (2) — no explosion, no duplicates
    expect(cycled.relations.filter(edge => edge.relation.target_id === cpu.metadata.id)).toHaveLength(1);
  });
  it('deletes one structured relation without touching other wikilinks, audits, and rolls back', async () => {
    const { services, cpu, board, vault } = await graph();
    await services.memory.create({ type: 'note', title: 'Human Link', content: 'see [[Motherboard]]' });
    const cpuEntity = await entity(services, cpu.metadata.id);
    const created = await services.graph.createRelation({ entity_id: cpu.metadata.id, relation_type: 'installed_in', target_id: board.metadata.id, expected_revision: cpuEntity.revision }) as { relation: { id: string } };
    const before = await entity(services, cpu.metadata.id);
    const deleted = await services.graph.deleteRelation(cpu.metadata.id, created.relation.id, before.revision) as { deleted: boolean };
    expect(deleted.deleted).toBe(true);
    const after = await entity(services, cpu.metadata.id);
    expect(after.metadata).not.toHaveProperty('relations');
    expect(after.content).not.toContain('<!-- rel:');
    const event = (await services.maintenance.history(cpu.metadata.id)).find(e => e.operation === 'delete_relation');
    expect(event).toBeDefined();
    const rollback = await services.maintenance.prepareRollback(event!.id);
    await services.maintenance.apply(rollback.id);
    const restored = await entity(services, cpu.metadata.id);
    expect((restored.metadata as unknown as { relations: unknown[] }).relations).toHaveLength(1);
    expect(restored.content).toContain(`<!-- rel:${created.relation.id} -->`);
    const raw = await readFile(path.join(vault, cpu.path), 'utf8');
    expect(raw).toContain('## Relations');
    const human = await entity(services, (await services.memory.search({ types: ['note'], query: 'Human Link' }))[0]!.metadata.id);
    expect(human.content).toContain('[[Motherboard]]'); // unrelated wikilinks untouched
  });
  it('rejects an unknown relation id and enforces revision discipline', async () => {
    const { services, cpu, board } = await graph();
    await expect(services.graph.deleteRelation(cpu.metadata.id, 'NOPE', cpu.revision)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(services.graph.createRelation({ entity_id: cpu.metadata.id, relation_type: 'x', target_id: board.metadata.id, expected_revision: 'stale' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(services.graph.createRelation({ entity_id: cpu.metadata.id, relation_type: 'x', target_id: cpu.metadata.id, expected_revision: cpu.revision })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('claims', () => {
  async function gpuWithSource() {
    const { services, vault } = await setup();
    const gpu = await services.memory.create({ type: 'note', title: 'GTX 1080 Ti' });
    const created = await services.sources.createSource({ title: 'Spec Sheet', provider: 'chatgpt', conversation_id: 'spec-conv-1' }) as { id: string };
    const source = await entity(services, created.id); // a source-type entity (§9: claims may reference sources only)
    return { services, gpu, source, vault };
  }
  it('creates a claim with a source reference and reports conflicts for the same predicate', async () => {
    const { services, gpu, source } = await gpuWithSource();
    const first = await services.graph.createClaim(gpu.metadata.id, { predicate: 'memory_size_gb', value: 11, source_ids: [source.metadata.id] }, gpu.revision) as { claim: { id: string; source_ids: string[] }; conflicts: string[] };
    expect(first.claim.source_ids).toEqual([source.metadata.id]);
    expect(first.conflicts).toEqual([]);
    const second = await services.graph.createClaim(gpu.metadata.id, { predicate: 'memory_size_gb', value: 12 }, (await entity(services, gpu.metadata.id)).revision) as { claim: { id: string }; conflicts: string[] };
    expect(second.conflicts).toEqual([first.claim.id]); // represented, not decided
    const both = await services.graph.claims({ entity_id: gpu.metadata.id }) as Array<{ predicate: string; valid_to: string | null }>;
    expect(both.filter(claim => claim.predicate === 'memory_size_gb' && claim.valid_to === null)).toHaveLength(2);
  });
  it('closes the previous claim when close_existing is set, without destroying it', async () => {
    const { services, gpu, source } = await gpuWithSource();
    const first = await services.graph.createClaim(gpu.metadata.id, { predicate: 'memory_size_gb', value: 11, source_ids: [source.metadata.id] }, gpu.revision) as { claim: { id: string } };
    const second = await services.graph.createClaim(gpu.metadata.id, { predicate: 'memory_size_gb', value: 12, close_existing: true }, (await entity(services, gpu.metadata.id)).revision) as { claim: { id: string }; closed: string[] };
    expect(second.closed).toEqual([first.claim.id]);
    const closed = (await services.graph.claims({ entity_id: gpu.metadata.id })) as Array<{ id: string; valid_to: string | null; status?: string }>;
    const oldClaim = closed.find(claim => claim.id === first.claim.id)!;
    expect(oldClaim.valid_to).not.toBeNull();
    expect(oldClaim.status).toBe('superseded');
  });
  it('queries validity windows in time', async () => {
    const { services, gpu } = await gpuWithSource();
    await services.graph.createClaim(gpu.metadata.id, { predicate: 'memory_size_gb', value: 11, valid_from: '2020-01-01' }, gpu.revision);
    await services.graph.createClaim(gpu.metadata.id, { predicate: 'memory_size_gb', value: 12, close_existing: true }, (await entity(services, gpu.metadata.id)).revision);
    const past = await services.graph.claims({ entity_id: gpu.metadata.id, valid_at: '2023-06-01' }) as Array<{ value: unknown }>;
    expect(past.map(claim => claim.value)).toEqual([11]);
    const before = await services.graph.claims({ entity_id: gpu.metadata.id, valid_at: '2019-06-01' }) as Array<{ value: unknown }>;
    expect(before).toEqual([]);
    const future = await services.graph.claims({ entity_id: gpu.metadata.id, valid_at: '2099-06-01' }) as Array<{ value: unknown }>;
    expect(future.map(claim => claim.value)).toEqual([12]);
  });
  it('updates and invalidates claims, keeping history', async () => {
    const { services, gpu } = await gpuWithSource();
    const created = await services.graph.createClaim(gpu.metadata.id, { predicate: 'warranty_state', value: 'manufacturer' }, gpu.revision) as { claim: { id: string } };
    const updated = await services.graph.updateClaim(gpu.metadata.id, created.claim.id, { value: 'store' }, (await entity(services, gpu.metadata.id)).revision) as { claim: { value: string; valid_to: string | null } };
    expect(updated.claim.value).toBe('store');
    expect(updated.claim.valid_to).toBeNull();
    const invalidated = await services.graph.invalidateClaim(gpu.metadata.id, created.claim.id, (await entity(services, gpu.metadata.id)).revision, 'test', 'out of warranty') as { claim: { status?: string; valid_to: string | null } };
    expect(invalidated.claim.status).toBe('invalidated');
    expect(invalidated.claim.valid_to).not.toBeNull();
    const visible = await services.graph.claims({ entity_id: gpu.metadata.id }) as Array<{ id: string }>;
    expect(visible.map(claim => claim.id)).not.toContain(created.claim.id);
    const all = await services.graph.claims({ entity_id: gpu.metadata.id, include_invalidated: true }) as Array<{ id: string }>;
    expect(all.map(claim => claim.id)).toContain(created.claim.id);
  });
  it('rejects unknown claim sources and empty predicates', async () => {
    const { services, gpu } = await gpuWithSource();
    await expect(services.graph.createClaim(gpu.metadata.id, { predicate: 'x', value: 1, source_ids: ['NOPE'] }, gpu.revision)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(services.graph.createClaim(gpu.metadata.id, { predicate: '  ', value: 1 }, gpu.revision)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    void gpu;
  });
  it('keeps the body bytes exact across a claim write — the reader no longer trims the frontmatter fence (§25 rollback fidelity)', async () => {
    const { services, vault } = await setup();
    const e = await services.memory.create({ type: 'note', title: 'Fidelity', content: 'Obsidian-preserved body.\n' });
    const abs = path.join(vault, (await entity(services, e.metadata.id)).path);
    const raw = await readFile(abs, 'utf8');
    const fence = raw.indexOf('---\n', 4) + 4; // end of the frontmatter block
    const withBlank = `${raw.slice(0, fence)}\n${raw.slice(fence)}`;
    await writeFile(abs, withBlank);
    await services.maintenance.reindex();
    const current = await entity(services, e.metadata.id);
    await services.graph.createClaim(e.metadata.id, { predicate: 'vendor', value: 'AMD', valid_from: '' }, current.revision);
    const after = await readFile(abs, 'utf8');
    // The body after the frontmatter fence (including the leading blank line)
    // must survive a claim write verbatim — that is exactly what a claim
    // rollback needs to reproduce the pre-migration bytes (§25).
    const bodyOf = (document: string) => document.slice(document.indexOf('---\n', 4) + 4);
    expect(bodyOf(after)).toBe(bodyOf(withBlank));
  });
  it('round-trips one Claim id: write → serialize → read → validate (unified CLAIM_ID rule, Phase-3B §3)', async () => {
    const { services, gpu, vault } = await gpuWithSource();
    const pin = '2026-10-07T18:00:00.000Z';
    // ids at the previously-diverging boundaries: a 5-char id could be written
    // by the 4–32 write rule and was silently dropped by the 6–64 read rule;
    // ULID (26) and migration `p3c-…` (24) must keep passing.
    for (const id of ['abcd', 'abcde', 'p3c-6e7f2d50e21d4a4c0c29']) {
      const revision = (await entity(services, gpu.metadata.id)).revision;
      const created = await services.graph.createClaim(gpu.metadata.id, { predicate: `id_check_${id.replace(/\W/g, '_')}`, value: id, claim_id: id, timestamp: pin }, revision) as { claim: { id: string } };
      expect(created.claim.id).toBe(id);
      const file = path.join(vault, (await entity(services, gpu.metadata.id)).path);
      const raw = await readFile(file, 'utf8'); // serialized frontmatter on disk
      expect(raw).toContain(`id: ${id}`);
      const reread = (await services.graph.claims({ entity_id: gpu.metadata.id })) as Array<{ id: string; value: unknown }>;
      const readable = reread.find(claim => claim.id === id); // parsed back through normalizeClaims
      expect(readable?.value).toBe(id);
    }
    // and the shared rule still rejects what both sides rejected: empty-ish and oversized
    await expect(services.graph.createClaim(gpu.metadata.id, { predicate: 'short', value: 1, claim_id: 'ab' }, (await entity(services, gpu.metadata.id)).revision)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(services.graph.createClaim(gpu.metadata.id, { predicate: 'long', value: 1, claim_id: 'a'.repeat(65) }, (await entity(services, gpu.metadata.id)).revision)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('timeline', () => {
  type Timeline = { entity_id: string; entity_title: string; as_of: string; counts: { past: number; present: number; planned: number; errors: number }; past: Array<{ id: string; predicate: string }>; present: Array<{ id: string; predicate: string }>; planned: Array<{ id: string; predicate: string }>; errors: Array<{ id: string; predicate: string }> };
  const revision = async (services: Services, id: string) => (await services.memory.get(id)).revision;
  it('classifies a future-dated open claim as planned, not present', async () => {
    const { services } = await setup();
    const note = await services.memory.create({ type: 'note', title: 'Timeline Note' });
    const planned = await services.graph.createClaim(note.metadata.id, { predicate: 'upgrade', value: 'RTX 4090', valid_from: '2027-01-01' }, note.revision) as { claim: { id: string } };
    const present = await services.graph.createClaim(note.metadata.id, { predicate: 'owner', value: 'me', valid_from: '2024-01-01' }, await revision(services, note.metadata.id)) as { claim: { id: string } };
    const result = await services.graph.timeline({ entity_id: note.metadata.id, as_of: '2026-10-09' }) as Timeline;
    expect(result.entity_id).toBe(note.metadata.id);
    expect(result.entity_title).toBe('Timeline Note');
    expect(result.as_of).toBe('2026-10-09');
    expect(result.counts).toEqual({ past: 0, present: 1, planned: 1, errors: 0 });
    expect(result.planned.map(claim => claim.id)).toEqual([planned.claim.id]);
    expect(result.present.map(claim => claim.id)).toEqual([present.claim.id]);
    expect(result.past).toEqual([]);
  });
  it('defaults as_of to today; unknown-valid_from claims count as present (last)', async () => {
    const { services } = await setup();
    const note = await services.memory.create({ type: 'note', title: 'Timeline Default' });
    const dated = await services.graph.createClaim(note.metadata.id, { predicate: 'vendor', value: 'AMD' }, note.revision) as { claim: { id: string } };
    const unknown = await services.graph.createClaim(note.metadata.id, { predicate: 'condition', value: 'good', valid_from: '' }, await revision(services, note.metadata.id)) as { claim: { id: string } };
    const result = await services.graph.timeline({ entity_id: note.metadata.id }) as Timeline;
    expect(result.as_of).toBe(new Date().toISOString().slice(0, 10));
    expect(result.counts).toEqual({ past: 0, present: 2, planned: 0, errors: 0 });
    // '' (unknown temporality) sorts after every real date in the present bucket.
    expect(result.present.map(claim => claim.id)).toEqual([dated.claim.id, unknown.claim.id]);
  });
  it('moves closed claims to past, newest close first, and out of present', async () => {
    const { services } = await setup();
    const note = await services.memory.create({ type: 'note', title: 'Timeline History' });
    const first = await services.graph.createClaim(note.metadata.id, { predicate: 'os', value: 'linux', valid_from: '2020-01-01' }, note.revision) as { claim: { id: string } };
    const second = await services.graph.createClaim(note.metadata.id, { predicate: 'os', value: 'macos', valid_from: '2022-01-01', close_existing: true }, await revision(services, note.metadata.id)) as { claim: { id: string }; closed: string[] };
    expect(second.closed).toEqual([first.claim.id]);
    // Pin explicit close dates so the newest-first order is deterministic.
    await services.graph.updateClaim(note.metadata.id, first.claim.id, { valid_to: '2023-01-01' }, await revision(services, note.metadata.id));
    await services.graph.updateClaim(note.metadata.id, second.claim.id, { valid_to: '2025-01-01' }, await revision(services, note.metadata.id));
    const result = await services.graph.timeline({ entity_id: note.metadata.id, as_of: '2026-10-09' }) as Timeline;
    expect(result.counts).toEqual({ past: 2, present: 0, planned: 0, errors: 0 });
    expect(result.past.map(claim => claim.id)).toEqual([second.claim.id, first.claim.id]);
    expect(result.present).toEqual([]);
  });
  it('orders planned claims soonest-first deterministically', async () => {
    const { services } = await setup();
    const note = await services.memory.create({ type: 'note', title: 'Timeline Plans' });
    const later = await services.graph.createClaim(note.metadata.id, { predicate: 'plan_later', value: '2028', valid_from: '2028-06-01' }, note.revision) as { claim: { id: string } };
    const sooner = await services.graph.createClaim(note.metadata.id, { predicate: 'plan_sooner', value: '2027', valid_from: '2027-01-01' }, await revision(services, note.metadata.id)) as { claim: { id: string } };
    const result = await services.graph.timeline({ entity_id: note.metadata.id, as_of: '2026-10-09' }) as Timeline;
    expect(result.planned.map(claim => claim.id)).toEqual([sooner.claim.id, later.claim.id]);
  });
  it('reclassifies claims when as_of shifts', async () => {
    const { services } = await setup();
    const note = await services.memory.create({ type: 'note', title: 'Timeline Shift' });
    const future = await services.graph.createClaim(note.metadata.id, { predicate: 'upgrade', value: 'RTX 4090', valid_from: '2027-01-01' }, note.revision) as { claim: { id: string } };
    const farFuture = await services.graph.timeline({ entity_id: note.metadata.id, as_of: '2028-01-01' }) as Timeline;
    expect(farFuture.counts).toEqual({ past: 0, present: 1, planned: 0, errors: 0 });
    expect(farFuture.present.map(claim => claim.id)).toEqual([future.claim.id]);
    const earlier = await services.graph.timeline({ entity_id: note.metadata.id, as_of: '2026-01-01' }) as Timeline;
    expect(earlier.planned.map(claim => claim.id)).toEqual([future.claim.id]);
    expect(earlier.present).toEqual([]);
  });
  it('rejects a non-ISO as_of', async () => {
    const { services } = await setup();
    const note = await services.memory.create({ type: 'note', title: 'Timeline Validation' });
    await expect(services.graph.timeline({ entity_id: note.metadata.id, as_of: 'not-a-date' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(services.graph.timeline({ entity_id: note.metadata.id, as_of: '2026-13-40' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('recorded_in_error correction', () => {
  async function gpuWithSource() {
    const { services, vault } = await setup();
    const gpu = await services.memory.create({ type: 'note', title: 'GTX 1080 Ti' });
    const created = await services.sources.createSource({ title: 'Spec Sheet', provider: 'chatgpt', conversation_id: 'error-conv-1' }) as { id: string };
    const source = await entity(services, created.id);
    return { services, gpu, source, vault };
  }
  const revision = async (services: Services, id: string) => (await services.memory.get(id)).revision;
  type Corrected = { entity_id: string; original: { id: string; status?: string; valid_to: string | null; error_reason?: string; corrected_at?: string; corrected_by?: string }; corrected: { id: string; status?: string; corrects?: string; valid_from: string; valid_to: string | null; source_ids: string[] } };

  it('marks the original erroneous and creates a linked correction without destroying the record', async () => {
    const { services, gpu, source, vault } = await gpuWithSource();
    const first = await services.graph.createClaim(gpu.metadata.id, { predicate: 'memory_size_gb', value: 11, source_ids: [source.metadata.id], valid_from: '2019-01-01' }, gpu.revision) as { claim: { id: string } };
    const result = await services.graph.correctClaim(gpu.metadata.id, first.claim.id, { value: 24, reason: 'transcribed from the wrong spec sheet' }, await revision(services, gpu.metadata.id)) as Corrected;
    // The original is marked, never deleted and never given an invented close date.
    expect(result.original.id).toBe(first.claim.id);
    expect(result.original.status).toBe('recorded_in_error');
    expect(result.original.error_reason).toBe('transcribed from the wrong spec sheet');
    expect(result.original.corrected_by).toBe(result.corrected.id);
    expect(result.original.corrected_at).toBeTruthy();
    expect(result.original.valid_to).toBeNull();
    // The correction is a fresh current claim pointing back to the mistake.
    expect(result.corrected.corrects).toBe(first.claim.id);
    expect(result.corrected.status).toBe('current');
    expect(result.corrected.valid_to).toBeNull();
    expect(result.corrected.valid_from).toBe('2019-01-01'); // inherited, not invented
    expect(result.corrected.source_ids).toEqual([source.metadata.id]); // inherited provenance
    // The erroneous body is still on disk, with its error marker.
    const raw = await readFile(path.join(vault, (await entity(services, gpu.metadata.id)).path), 'utf8');
    expect(raw).toContain('value: 11');
    expect(raw).toContain('status: recorded_in_error');
    expect(raw).toContain('error_reason: transcribed from the wrong spec sheet');
  });

  it('excludes erroneous claims from past/present/planned and reports them in errors', async () => {
    const { services, gpu } = await gpuWithSource();
    type Timeline = { counts: { past: number; present: number; planned: number; errors: number }; past: Array<{ id: string }>; present: Array<{ id: string }>; planned: Array<{ id: string }>; errors: Array<{ id: string; status?: string; corrected_at?: string }> };
    const wrongPast = await services.graph.createClaim(gpu.metadata.id, { predicate: 'wrong_past', value: 'closed-looking', valid_from: '2020-01-01' }, gpu.revision) as { claim: { id: string } };
    const wrongFuture = await services.graph.createClaim(gpu.metadata.id, { predicate: 'wrong_future', value: 'planned-looking', valid_from: '2027-01-01' }, await revision(services, gpu.metadata.id)) as { claim: { id: string } };
    const real = await services.graph.createClaim(gpu.metadata.id, { predicate: 'owner', value: 'me', valid_from: '2024-01-01' }, await revision(services, gpu.metadata.id)) as { claim: { id: string } };
    const first = await services.graph.correctClaim(gpu.metadata.id, wrongPast.claim.id, { value: 'corrected past', reason: 'wrong from the start' }, await revision(services, gpu.metadata.id)) as Corrected;
    const second = await services.graph.correctClaim(gpu.metadata.id, wrongFuture.claim.id, { value: 'corrected future', reason: 'wrong from the start' }, await revision(services, gpu.metadata.id)) as Corrected;
    const result = await services.graph.timeline({ entity_id: gpu.metadata.id, as_of: '2026-10-09' }) as Timeline;
    // The two erroneous claims are neither past nor present nor planned.
    expect(result.counts).toEqual({ past: 0, present: 2, planned: 1, errors: 2 });
    const bucketIds = [...result.past, ...result.present, ...result.planned].map(claim => claim.id);
    expect(bucketIds).not.toContain(wrongPast.claim.id);
    expect(bucketIds).not.toContain(wrongFuture.claim.id);
    // errors: newest corrected_at first, then id.
    expect(result.errors.map(claim => claim.id)).toEqual([second.original.id, first.original.id]);
    expect(result.errors.every(claim => claim.status === 'recorded_in_error')).toBe(true);
    // The corrections themselves behave like ordinary claims.
    expect(result.present.map(claim => claim.id)).toContain(real.claim.id);
    expect(result.planned.map(claim => claim.id)).toEqual([second.corrected.id]);
  });

  it('hides erroneous claims in claims() by default and returns them with include_errors', async () => {
    const { services, gpu } = await gpuWithSource();
    const wrong = await services.graph.createClaim(gpu.metadata.id, { predicate: 'vendor', value: 'NVIDIA', valid_from: '2018-01-01' }, gpu.revision) as { claim: { id: string } };
    const fixed = await services.graph.correctClaim(gpu.metadata.id, wrong.claim.id, { value: 'AMD', reason: 'brand mis-keyed' }, await revision(services, gpu.metadata.id)) as Corrected;
    const defaultView = await services.graph.claims({ entity_id: gpu.metadata.id }) as Array<{ id: string; status?: string }>;
    expect(defaultView.map(claim => claim.id)).not.toContain(wrong.claim.id);
    expect(defaultView.map(claim => claim.id)).toContain(fixed.corrected.id);
    const withErrors = await services.graph.claims({ entity_id: gpu.metadata.id, include_errors: true }) as Array<{ id: string; status?: string; error_reason?: string }>;
    const shown = withErrors.find(claim => claim.id === wrong.claim.id);
    expect(shown?.status).toBe('recorded_in_error');
    expect(shown?.error_reason).toBe('brand mis-keyed');
  });

  it('does not treat an erroneous claim as a current conflict for the same predicate', async () => {
    const { services, gpu } = await gpuWithSource();
    const wrong = await services.graph.createClaim(gpu.metadata.id, { predicate: 'memory_size_gb', value: 11 }, gpu.revision) as { claim: { id: string } };
    await services.graph.correctClaim(gpu.metadata.id, wrong.claim.id, { value: 24, reason: 'wrong capacity' }, await revision(services, gpu.metadata.id));
    const next = await services.graph.createClaim(gpu.metadata.id, { predicate: 'memory_size_gb', value: 32 }, await revision(services, gpu.metadata.id)) as { conflicts: string[]; closed: string[] };
    // The erroneous claim is not current, so it is not a conflict; the correction is.
    expect(next.conflicts).not.toContain(wrong.claim.id);
    expect(next.closed).toEqual([]);
  });

  it('scans same-source suspects read-only and never returns the erroneous claim itself', async () => {
    const { services, gpu, source } = await gpuWithSource();
    const wrong = await services.graph.createClaim(gpu.metadata.id, { predicate: 'memory_size_gb', value: 11, source_ids: [source.metadata.id] }, gpu.revision) as { claim: { id: string } };
    const sibling = await services.graph.createClaim(gpu.metadata.id, { predicate: 'memory_size_gb', value: 12, source_ids: [source.metadata.id] }, await revision(services, gpu.metadata.id)) as { claim: { id: string } };
    const otherPredicate = await services.graph.createClaim(gpu.metadata.id, { predicate: 'vendor', value: 'NVIDIA', source_ids: [source.metadata.id] }, await revision(services, gpu.metadata.id)) as { claim: { id: string } };
    const noSource = await services.graph.createClaim(gpu.metadata.id, { predicate: 'memory_size_gb', value: 13 }, await revision(services, gpu.metadata.id)) as { claim: { id: string } };
    const corrected = await services.graph.correctClaim(gpu.metadata.id, wrong.claim.id, { value: 24, reason: 'transcribed from the wrong sheet' }, await revision(services, gpu.metadata.id)) as Corrected;
    const before = await entity(services, gpu.metadata.id);
    const suspects = await services.graph.findSuspectClaims({ source_id: source.metadata.id, predicate: 'memory_size_gb' }) as { source_id: string; predicate: string | null; count: number; candidates: Array<{ entity_id: string; entity_title: string; id: string; predicate: string; value: unknown; status?: string; reason: string }> };
    expect(suspects.source_id).toBe(source.metadata.id);
    expect(suspects.predicate).toBe('memory_size_gb');
    const ids = suspects.candidates.map(candidate => candidate.id);
    expect(ids).toEqual([sibling.claim.id, corrected.corrected.id]); // deterministic entity/predicate/id order
    expect(ids).not.toContain(wrong.claim.id); // the erroneous claim is never a suspect
    expect(ids).not.toContain(noSource.claim.id); // different provenance
    expect(suspects.count).toBe(ids.length);
    expect(suspects.candidates[0]!.entity_id).toBe(gpu.metadata.id);
    expect(suspects.candidates[0]!.entity_title).toBe('GTX 1080 Ti');
    expect(suspects.candidates[0]!.reason).toBe('same source and predicate as a claim recorded in error');
    const unfiltered = await services.graph.findSuspectClaims({ source_id: source.metadata.id }) as { predicate: string | null; count: number; candidates: Array<{ id: string }> };
    expect(unfiltered.predicate).toBeNull();
    expect(unfiltered.count).toBe(suspects.count + 1); // the vendor claim joins the candidate set
    expect(unfiltered.candidates.map(candidate => candidate.id)).toContain(otherPredicate.claim.id); // predicate filter widened, not narrowed
    const after = await entity(services, gpu.metadata.id);
    expect(after.revision).toBe(before.revision); // read-only: nothing was written
  });

  it('rejects re-correcting an already erroneous claim, an unknown claim, and a stale revision', async () => {
    const { services, gpu } = await gpuWithSource();
    const wrong = await services.graph.createClaim(gpu.metadata.id, { predicate: 'vendor', value: 'NVIDIA' }, gpu.revision) as { claim: { id: string } };
    const corrected = await services.graph.correctClaim(gpu.metadata.id, wrong.claim.id, { value: 'AMD', reason: 'brand mis-keyed' }, await revision(services, gpu.metadata.id)) as Corrected;
    // The first correction succeeded, so the rejections below are about state, not setup.
    expect(corrected.corrected.status).toBe('current');
    expect(corrected.original.status).toBe('recorded_in_error');
    await expect(services.graph.correctClaim(gpu.metadata.id, wrong.claim.id, { value: 'Intel', reason: 'again' }, await revision(services, gpu.metadata.id))).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(services.graph.correctClaim(gpu.metadata.id, 'does-not-exist', { value: 1, reason: 'x' }, await revision(services, gpu.metadata.id))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(services.graph.correctClaim(gpu.metadata.id, wrong.claim.id, { value: 1, reason: 'x' }, 'stale-revision')).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(services.graph.correctClaim(gpu.metadata.id, wrong.claim.id, { value: 1, reason: '   ' }, await revision(services, gpu.metadata.id))).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(services.graph.findSuspectClaims({ source_id: '  ' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('sources', () => {
  it('creates, finds by conversation id and content hash, and imports idempotently', async () => {
    const { services } = await setup();
    const created = await services.sources.createSource({ title: 'Chat about GPU', provider: 'claude', conversation_id: 'conv-1', original_file: 'chat.md' }) as { created: boolean; id: string; path: string };
    expect(created.created).toBe(true);
    expect(created.path).toContain('Sources/claude/');
    const rediscovered = await services.sources.findSource({ provider: 'claude', conversation_id: 'conv-1' }) as Array<{ id: string }>;
    expect(rediscovered.map(source => source.id)).toEqual([created.id]);
    const again = await services.sources.createSource({ title: 'Chat about GPU (reimport)', provider: 'claude', conversation_id: 'conv-1', if_exists: 'return_existing' }) as { created: boolean; id: string };
    expect(again.created).toBe(false);
    expect(again.id).toBe(created.id);
    await expect(services.sources.createSource({ title: 'dup', provider: 'claude', conversation_id: 'conv-1' })).rejects.toMatchObject({ code: 'CONFLICT' });
    const hashed = await services.sources.createSource({ title: 'Notes file', provider: 'import', content_hash: 'sha256:abc' }) as { created: boolean; id: string };
    const byHash = await services.sources.findSource({ provider: 'import', content_hash: 'sha256:abc' }) as Array<{ id: string }>;
    expect(byHash.map(source => source.id)).toEqual([hashed.id]);
    await expect(services.sources.createSource({ title: 'No identity', provider: 'claude' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('merge', () => {
  it('transfers aliases, relations, and claims, rewrites wikilinks, archives the source, and rolls the whole bundle back', async () => {
    const { services, vault } = await setup();
    const dup = await services.memory.create({ type: 'note', title: 'Dup A' });
    const other = await services.memory.create({ type: 'note', title: 'Other Node' });
    const canonical = await services.memory.create({ type: 'note', title: 'Canonical B' });
    const watcher = await services.memory.create({ type: 'note', title: 'Watcher', content: 'see [[Dup A]] and their [[Other Node]]' });
    const revision = (await entity(services, dup.metadata.id)).revision;
    await services.graph.createRelation({ entity_id: dup.metadata.id, relation_type: 'located_in', target_id: other.metadata.id, expected_revision: revision });
    const dupWithClaim = await entity(services, dup.metadata.id);
    await services.graph.createClaim(dup.metadata.id, { predicate: 'capacity_tb', value: 4 }, dupWithClaim.revision);
    const cs = await services.maintenance.prepare(`Merge ${dup.metadata.id} into ${canonical.metadata.id}`, [{ kind: 'merge', entity_id: dup.metadata.id, expected_revision: (await entity(services, dup.metadata.id)).revision, target_id: canonical.metadata.id, expected_target_revision: canonical.revision }]);
    await services.maintenance.apply(cs.id, 'test:merge');
    const merged = await entity(services, canonical.metadata.id);
    // aliases
    expect(merged.metadata.aliases).toContain('Dup A');
    // relations transferred with their ids intact, minus the self-edge
    const relations = (merged.metadata as unknown as { relations: Array<{ id: string; type: string; target_id: string }> }).relations ?? [];
    expect(relations.some(edge => edge.type === 'located_in' && edge.target_id === other.metadata.id)).toBe(true);
    // claims transferred
    const claims = await services.graph.claims({ entity_id: canonical.metadata.id }) as Array<{ predicate: string; value: unknown }>;
    expect(claims.some(claim => claim.predicate === 'capacity_tb' && claim.value === 4)).toBe(true);
    // external wikilink rewritten in a third file
    const watcherRaw = await readFile(path.join(vault, watcher.path), 'utf8');
    expect(watcherRaw).toContain('[[Canonical B]]');
    // source archived with one audited merge event
    const source = await entity(services, dup.metadata.id);
    expect(source.metadata.status).toBe('archived');
    const event = (await services.maintenance.history()).find(e => e.operation === 'merge');
    expect(event).toBeDefined();
    expect(event!.details).toMatchObject({ target_id: canonical.metadata.id });
    // rollback restores the whole bundle
    const rollback = await services.maintenance.prepareRollback(event!.id);
    await services.maintenance.apply(rollback.id);
    const unmerged = await entity(services, dup.metadata.id);
    expect(unmerged.metadata.status).not.toBe('archived');
    const restoredWatcher = await entity(services, watcher.metadata.id);
    expect(restoredWatcher.content).toContain('[[Dup A]]');
    const restoredCanonical = await entity(services, canonical.metadata.id);
    expect((restoredCanonical.metadata as unknown as { relations?: unknown[] }).relations ?? []).toHaveLength(
      (canonical.metadata as unknown as { relations?: unknown[] }).relations?.length ?? 0,
    ); // target metadata wholesale-restored to its pre-merge state (no relations key)
    const restoredRaw = await readFile(path.join(vault, watcher.path), 'utf8');
    expect(restoredRaw).toContain('[[Dup A]]');
  });
  it('refuses to merge an entity into itself or with stale revisions', async () => {
    const { services } = await setup();
    const a = await services.memory.create({ type: 'note', title: 'Same' });
    const cs = await services.maintenance.prepare('Self merge', [{ kind: 'merge', entity_id: a.metadata.id, expected_revision: a.revision, target_id: a.metadata.id, expected_target_revision: a.revision }]);
    await expect(services.maintenance.apply(cs.id)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    const other = await services.memory.create({ type: 'note', title: 'Other' });
    const stale = await services.maintenance.prepare('stale', [{ kind: 'merge', entity_id: a.metadata.id, expected_revision: 'stale', target_id: other.metadata.id, expected_target_revision: other.revision }]);
    await expect(services.maintenance.apply(stale.id)).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('backward compatibility', () => {
  it('serves old entities without relations, claims, or sources; generic updates without graph keys still work', async () => {
    const { services } = await setup();
    const legacy = await services.memory.create({ type: 'note', title: 'Plain Old Note', content: 'plain [[Other Note]] body' });
    const other = await services.memory.create({ type: 'note', title: 'Other Note' });
    expect((await services.memory.related(legacy.metadata.id)).map(r => r.entity.metadata.id)).toContain(other.metadata.id);
    const updated = await services.memory.update(legacy.metadata.id, { content: 'still plain' }, legacy.revision);
    expect(updated.content).toContain('still plain');
    const claims = await services.graph.claims({ entity_id: legacy.metadata.id });
    expect(claims).toEqual([]);
    expect((await services.graph.relationsOf(legacy.metadata.id) as { relations: unknown[] }).relations).toEqual([]);
  });
  it('blocks graph keys in generic patches while keeping the legacy relationships key writable', async () => {
    const { services } = await setup();
    const note = await services.memory.create({ type: 'note', title: 'Guarded' });
    await expect(services.memory.update(note.metadata.id, { metadata: { relations: [] } }, note.revision)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(services.memory.update(note.metadata.id, { metadata: { claims: [] } }, note.revision)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    const legacyOk = await services.memory.update(note.metadata.id, { metadata: { relationships: [{ type: 'see_also', target_id: note.metadata.id }] } }, note.revision);
    expect(legacyOk.metadata.relationships).toHaveLength(1);
    await expect(services.memory.create({ type: 'note', title: 'Guarded Create', metadata: { relations: [] } })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(services.memory.create({ type: 'note', title: 'Guarded Create 2', metadata: { claims: [] } })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
  it('keeps legacy wikilink-only graphs working through related()', async () => {
    const { services } = await setup();
    const target = await services.memory.create({ type: 'note', title: 'Wiki Target' });
    const linker = await services.memory.create({ type: 'note', title: 'Wiki Linker', content: 'see [[Wiki Target]]' });
    expect((await services.memory.related(linker.metadata.id)).map(r => r.entity.metadata.id)).toContain(target.metadata.id);
    expect(await services.maintenance.brokenLinks()).toEqual([]);
  });
});