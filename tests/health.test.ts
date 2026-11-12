import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { compose } from '../src/composition.js';
import { createHttpApp } from '../src/transports/http/server.js';
import { HealthService } from '../src/application/health-service.js';
import { startHealthScheduler } from '../src/application/health-schedule.js';
import { InMemoryIndex } from '../src/adapters/index/in-memory-index.js';
import { loadConfig, resolveHealth } from '../src/config/schema.js';
import { MemoryError } from '../src/domain/errors.js';
import type { AppConfig } from '../src/config/schema.js';
import type { NeuralAssociativeMemory } from '../src/ports/neural.js';

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await close(server);
  for (const root of roots.splice(0)) if (root) await rm(root, { recursive: true, force: true });
});

const routing: AppConfig['routing'] = {
  note: { backend: 'markdown', path: '03 Knowledge/{slug}.md' },
  person: { backend: 'markdown', path: 'People/{slug}.md' },
  decision: { backend: 'markdown', path: '10 Decisions/{slug}.md' },
  task: { backend: 'markdown', path: '11 Tasks/{slug}.md' },
  memory: { backend: 'markdown', path: 'Memory/{slug}.md' },
  source: { backend: 'markdown', path: 'Sources/{slug}.md' },
};

async function setup(extra: Partial<AppConfig> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'health-test-'));
  roots.push(root);
  const vault = path.join(root, 'vault');
  const audit = path.join(root, 'state', 'audit');
  await mkdir(vault, { recursive: true });
  const config: AppConfig = {
    name: 'Health Test', vault_root: vault, read_only: false, audit_dir: audit, transport: 'stdio',
    http: { bind: '127.0.0.1', port: 3333, allowed_origins: [], bearer_token_env: 'HEALTH_TEST_TOKEN' },
    routing, ...extra,
  };
  return { root, vault, audit, config, services: await compose(config) };
}

describe('health check', () => {
  it('prepares a dry-run move for a type/folder mismatch and does not touch the vault', async () => {
    const { vault, audit, services } = await setup();
    const note = await services.memory.create({ type: 'note', title: 'Move me' });
    const moved = await services.memory.move(note.metadata.id, 'People/wrong.md', note.revision);
    const before = await readFile(path.join(vault, moved.path), 'utf8');
    const report = await services.health.run();
    expect(report.applied).toBe(false);
    expect(report.recommend_reindex).toBe(false);
    expect(report.findings.some(finding => finding.code === 'TYPE_FOLDER_MISMATCH')).toBe(true);
    expect(report.changesets.length).toBeGreaterThan(0);
    const changeset = JSON.parse(await readFile(path.join(audit, 'changesets', `${report.changesets[0]!.id}.json`), 'utf8')) as { status: string; operations: Array<{ kind: string; destination?: string }> };
    expect(changeset.status).toBe('prepared');
    expect(changeset.operations.some(op => op.kind === 'delete')).toBe(false);
    expect(changeset.operations.some(op => op.kind === 'move' && op.destination?.includes('03 Knowledge/'))).toBe(true);
    expect(await readFile(path.join(vault, moved.path), 'utf8')).toBe(before);
    await expect(readFile(path.join(vault, '03 Knowledge', 'move-me.md'))).rejects.toThrow();
    const events = await services.audit.list(undefined, 20);
    expect(events.some(event => event.operation === 'health_check' && event.details && (event.details as { applied?: boolean }).applied === false)).toBe(true);
    const history = await readdir(path.join(audit, 'health'));
    expect(history).toContain('latest.json');
    expect(history.some(name => name.includes(report.audit_event_id) && name !== 'latest.json')).toBe(true);
    expect(path.join(audit, 'health')).not.toContain(`${path.sep}vault${path.sep}`);
  });

  it('groups diacritic titles with compactForm and normalizes tags only inside a changeset', async () => {
    const { vault, services } = await setup();
    const accented = await services.memory.create({ type: 'note', title: 'Novák', metadata: { tags: ['Rodina', 'rodina'] } });
    await services.memory.create({ type: 'note', title: 'Novak', metadata: { tags: ['Kafka'] } });
    const groups = await services.maintenance.duplicates();
    expect(groups.some(group => group.length === 2 && group.every(item => item.title === 'Novak' || item.title === 'Novák'))).toBe(true);
    const report = await services.health.run({ maxOps: 1, maxChangesets: 1 });
    expect(report.findings.some(finding => finding.code === 'DUPLICATE_TITLE')).toBe(true);
    expect(report.findings.some(finding => finding.code === 'TAG_NORMALIZATION')).toBe(true);
    expect(report.changesets).toHaveLength(1);
    expect(report.operations_omitted).toBeGreaterThanOrEqual(1);
    expect(await readFile(path.join(vault, accented.path), 'utf8')).toMatch(/Rodina/);
  });

  it('repairs a legacy relation link only as a dry-run content update', async () => {
    const { services } = await setup();
    const alpha = await services.memory.create({ type: 'note', title: 'Alpha' });
    const beta = await services.memory.create({ type: 'note', title: 'Beta', content: 'See [[No Such Note]]\n' });
    await services.storage.write(alpha.metadata.id, {
      ...alpha.metadata,
      relations: [{ id: 'REL1', type: 'related', target_id: beta.metadata.id, created_at: alpha.metadata.created_at, updated_at: alpha.metadata.updated_at }],
    }, '- [[Beta]] <!-- rel:REL1 -->\n', alpha.revision);
    const report = await services.health.run();
    expect(report.findings.some(finding => finding.code === 'BROKEN_LINK')).toBe(true);
    const changeset = JSON.parse(await readFile(path.join(services.config.audit_dir, 'changesets', `${report.changesets[0]!.id}.json`), 'utf8')) as { operations: Array<{ kind: string; patch?: { content?: string } }> };
    expect(changeset.operations.some(op => op.kind === 'update' && op.patch?.content?.includes('[[beta|Beta]] <!-- rel:REL1 -->'))).toBe(true);
    const current = await services.memory.get(alpha.metadata.id);
    expect(current.content).toContain('[[Beta]]');
    expect(current.content).not.toContain('[[beta|Beta]]');
  });

  it('flags invalid dates, missing source frontmatter, and an unrouted alias without applying a fix', async () => {
    const { services } = await setup();
    const person = await services.memory.create({
      type: 'person', title: 'Eva',
      metadata: { birth_date: '12.5.1990', name_day: '32-13' },
    });
    await services.memory.create({ type: 'source', title: 'Bare source' });
    await services.memory.create({ type: 'todo', title: 'Později' });
    const report = await services.health.run();
    expect(report.findings.filter(finding => finding.code === 'INVALID_DATE' && finding.entity_id === person.metadata.id).length).toBeGreaterThanOrEqual(2);
    expect(report.findings.some(finding => finding.code === 'MISSING_FRONTMATTER' && finding.severity === 'error' && finding.message.includes('provider'))).toBe(true);
    expect(report.findings.some(finding => finding.code === 'UNKNOWN_TYPE' && finding.message.includes('task'))).toBe(true);
    const stored = await services.memory.get(person.metadata.id);
    expect(stored.metadata.birth_date).toBe('12.5.1990');
    expect(report.applied).toBe(false);
  });

  it('recommends reindex for index drift and does not run it', async () => {
    const { services } = await setup();
    const note = await services.memory.create({ type: 'note', title: 'Indexed' });
    const index = services.index as InMemoryIndex;
    const stored = index.entities.get(note.metadata.id);
    if (!stored) throw new Error('missing index entry');
    index.entities.set(note.metadata.id, { ...stored, revision: 'stale-index' });
    const report = await services.health.run();
    expect(report.findings.some(finding => finding.code === 'INDEX_DRIFT')).toBe(true);
    expect(report.recommend_reindex).toBe(true);
    expect(report.recommendations).toEqual(['reindex']);
    expect(index.entities.get(note.metadata.id)?.revision).toBe('stale-index');
  });

  it('compares sidecar revisions and stays quiet when the sidecar is only down', async () => {
    const { vault, audit, config, services } = await setup();
    const note = await services.memory.create({ type: 'note', title: 'Sidecar note' });
    const drifted = new HealthService(services.storage, services.index, services.maintenance, services.audit, fakeNeural({
      async revisions() { return { available: true, bdh: { [note.metadata.id]: 'stale' }, vector: null }; },
    }), vault, config.routing, audit, false, 5);
    const drift = await drifted.run();
    expect(drift.findings.some(finding => finding.code === 'SIDECAR_DRIFT' && finding.message.includes('bdh'))).toBe(true);
    expect(drift.recommend_reindex).toBe(true);
    const down = new HealthService(services.storage, services.index, services.maintenance, services.audit, fakeNeural({
      async revisions() { return { available: false, warning: 'down' }; },
    }), vault, config.routing, audit, false, 5);
    const unavailable = await down.run();
    expect(unavailable.findings.some(finding => finding.code === 'SIDECAR_UNAVAILABLE')).toBe(true);
    expect(unavailable.findings.some(finding => finding.code === 'SIDECAR_DRIFT')).toBe(false);
  });

  it('writes the report from a read-only server and refuses a second concurrent run', async () => {
    const { vault, audit, services } = await setup({ read_only: true });
    await mkdir(path.join(vault, '03 Knowledge'), { recursive: true });
    const file = path.join(vault, '03 Knowledge', 'maminka.md');
    const body = [
      '---',
      'id: 01PERSONHEALTH',
      'type: person',
      'title: Maminka',
      'created_at: "2026-01-01T00:00:00.000Z"',
      'updated_at: "2026-01-01T00:00:00.000Z"',
      'aliases: []',
      'tags:',
      '  - Rodina',
      '  - rodina',
      'status: active',
      'schema_version: 1',
      'birth_date: "12.5.1990"',
      'name_day: "32-13"',
      '---',
      '',
      'Ahoj',
      '',
    ].join('\n');
    await writeFile(file, body);
    const first = services.health.run();
    await expect(services.health.run()).rejects.toMatchObject({ code: 'CONFLICT' });
    const report = await first;
    expect(report.read_only).toBe(true);
    expect(report.applied).toBe(false);
    expect(await readFile(file, 'utf8')).toBe(body);
    expect(report.findings.some(finding => finding.code === 'INVALID_DATE')).toBe(true);
    expect(report.findings.some(finding => finding.code === 'TYPE_FOLDER_MISMATCH')).toBe(true);
    await expect(readFile(path.join(vault, 'People', 'maminka.md'))).rejects.toThrow();
    const latest = JSON.parse(await readFile(path.join(audit, 'health', 'latest.json'), 'utf8')) as { audit_event_id: string };
    expect(latest.audit_event_id).toBe(report.audit_event_id);
  });

  it('proposes a retype when an unrouted alias already sits in that type folder', async () => {
    const { vault, audit, services } = await setup();
    await mkdir(path.join(vault, '11 Tasks'), { recursive: true });
    const file = path.join(vault, '11 Tasks', 'koupit-mleko.md');
    const body = [
      '---',
      'id: 01TODOHEALTH',
      'type: todo',
      'title: Koupit mleko',
      'created_at: "2026-01-01T00:00:00.000Z"',
      'updated_at: "2026-01-01T00:00:00.000Z"',
      'aliases: []',
      'tags: []',
      'status: active',
      'schema_version: 1',
      '---',
      '',
      'do pátku',
      '',
    ].join('\n');
    await writeFile(file, body);
    const report = await services.health.run();
    expect(await readFile(file, 'utf8')).toBe(body);
    const changeset = JSON.parse(await readFile(path.join(audit, 'changesets', `${report.changesets[0]!.id}.json`), 'utf8')) as { id: string; operations: Array<{ kind: string; patch?: { metadata?: { type?: string } } }> };
    expect(changeset.operations.some(op => op.kind === 'update' && op.patch?.metadata?.type === 'task')).toBe(true);
    const applied = await services.maintenance.apply(changeset.id);
    expect(applied.changeset.status).toBe('applied');
    const stored = await services.memory.get('01TODOHEALTH');
    expect(stored.metadata.type).toBe('task');
    expect(stored.path.replaceAll('\\', '/')).toBe('11 Tasks/koupit-mleko.md');
  });

  it('audits an explicit type change that re-routes the file', async () => {
    const { services } = await setup();
    const note = await services.memory.create({ type: 'note', title: 'Move me' });
    const decision = await services.memory.update(note.metadata.id, { metadata: { type: 'decision' } }, note.revision, 'tester');
    expect(decision.metadata.type).toBe('decision');
    expect(decision.path).toMatch(/^10 Decisions\//);
    expect(decision.path).not.toBe(note.path);
    const update = (await services.audit.list(note.metadata.id, 10)).find(event => event.operation === 'update');
    expect(update?.details).toMatchObject({
      rerouted: true, from_type: 'note', to_type: 'decision', from_path: note.path, to_path: decision.path,
    });
  });

  it('serves POST /api/v1/health/run and GET /api/v1/health/latest with the same auth as other routes', async () => {
    const { services } = await setup();
    const open = createHttpApp(services);
    const openServer = await listen(open);
    const openPort = portOf(openServer);
    const missing = await fetch(`http://127.0.0.1:${openPort}/api/v1/health/latest`);
    expect(missing.status).toBe(404);
    await close(openServer);

    const previous = process.env.HEALTH_TEST_TOKEN;
    process.env.HEALTH_TEST_TOKEN = 'secret';
    try {
      const locked = await setup();
      const app = createHttpApp(locked.services);
      const server = await listen(app);
      const base = `http://127.0.0.1:${portOf(server)}`;
      const denied = await fetch(`${base}/api/v1/health/run`, { method: 'POST' });
      expect(denied.status).toBe(401);
      const accepted = await fetch(`${base}/api/v1/health/run`, { method: 'POST', headers: { authorization: 'Bearer secret' } });
      expect(accepted.status).toBe(200);
      const body = await accepted.json() as { applied: boolean; generated_at: string };
      expect(body.applied).toBe(false);
      const latest = await fetch(`${base}/api/v1/health/latest`, { headers: { authorization: 'Bearer secret' } });
      expect(latest.status).toBe(200);
      expect((await latest.json() as { generated_at: string }).generated_at).toBe(body.generated_at);
      await close(server);
    } finally {
      if (previous === undefined) delete process.env.HEALTH_TEST_TOKEN;
      else process.env.HEALTH_TEST_TOKEN = previous;
    }
  });

  it('exposes health_report on minimal and run_health_check only on full', async () => {
    const full = await setup();
    const minimal = await setup({ toolset: 'minimal' });
    const fullClient = await connect(full.services);
    const before = data(await fullClient.callTool({ name: 'health_report', arguments: {} }));
    expect(before.last_run_at).toBeNull();
    expect(before.top_findings).toEqual([]);
    const ran = data(await fullClient.callTool({ name: 'run_health_check', arguments: {} }));
    expect(ran.last_run_at).toEqual(expect.any(String));
    expect(ran.changeset_ids).toEqual(expect.any(Array));
    expect(ran.top_findings.length).toBeLessThanOrEqual(5);
    expect(ran).not.toHaveProperty('findings');
    const detailed = data(await fullClient.callTool({ name: 'health_report', arguments: { detail: true, page: 1, page_size: 2 } }));
    expect(detailed.total_findings).toEqual(expect.any(Number));
    expect(detailed.findings.length).toBeLessThanOrEqual(2);
    await fullClient.close();

    const minimalClient = await connect(minimal.services);
    const names = (await minimalClient.listTools()).tools.map(tool => tool.name);
    expect(names).toContain('health_report');
    expect(names).not.toContain('run_health_check');
    await minimalClient.close();
  });
});

describe('health schedule and config', () => {
  it('runs on an HTTP interval and stays off for stdio and when disabled', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const enabled = { transport: 'http', health: { enabled: true, interval_hours: 24, startup_delay_s: 0, max_changesets: 5 } } as AppConfig;
      const stop = startHealthScheduler(async () => { calls += 1; return { findings: [], changesets: [] } as never; }, enabled, () => 0);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
      expect(calls).toBe(2);
      stop();
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
      expect(calls).toBe(2);

      const stdio = startHealthScheduler(async () => { calls += 1; return {} as never; }, { ...enabled, transport: 'stdio' }, () => 0);
      const disabled = startHealthScheduler(async () => { calls += 1; return {} as never; }, { ...enabled, health: { ...enabled.health!, enabled: false } }, () => 0);
      await vi.advanceTimersByTimeAsync(48 * 60 * 60 * 1000);
      expect(calls).toBe(2);
      stdio();
      disabled();

      const busy = startHealthScheduler(async () => { throw new MemoryError('CONFLICT', 'busy'); }, enabled, () => 0);
      await vi.advanceTimersByTimeAsync(1);
      busy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('loads health defaults and honors MEMORY_HEALTH_INTERVAL_HOURS', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'health-config-'));
    roots.push(root);
    const file = path.join(root, 'config.yml');
    const yaml = 'name: Cfg\nvault_root: ./vault\nread_only: true\naudit_dir: ./.state/audit\nrouting:\n  note:\n    backend: markdown\n    path: "Notes/{slug}.md"\n';
    await writeFile(file, yaml);
    expect((await loadConfig(file)).health).toEqual({ enabled: false, interval_hours: 24, startup_delay_s: 60, max_changesets: 5 });
    await writeFile(file, `health:\n  enabled: true\n  interval_hours: 12\n${yaml}`);
    await withEnv('MEMORY_HEALTH_INTERVAL_HOURS', '6', async () => {
      expect((await loadConfig(file)).health).toMatchObject({ enabled: true, interval_hours: 6, max_changesets: 5 });
    });
    await withEnv('MEMORY_HEALTH_INTERVAL_HOURS', 'nope', async () => {
      await expect(loadConfig(file)).rejects.toThrow(/MEMORY_HEALTH_INTERVAL_HOURS/);
    });
    expect(resolveHealth({ enabled: true }, '')).toMatchObject({ enabled: true, interval_hours: 24 });
  });
});

function fakeNeural(impl: Partial<NeuralAssociativeMemory>): NeuralAssociativeMemory {
  return {
    enabled: true,
    async upsert() { /* unused */ },
    async remove() { /* unused */ },
    async associate() { return { available: true, results: [] }; },
    async rebuild() { return { available: true, indexed: 0 }; },
    async health() { return { enabled: true, available: true }; },
    async revisions() { return { available: false, warning: 'unset' }; },
    ...impl,
  };
}

interface HealthToolData {
  last_run_at: string | null;
  top_findings: unknown[];
  changeset_ids: string[];
  findings: unknown[];
  total_findings?: number;
}

function data(call: { structuredContent?: unknown }): HealthToolData {
  return (call.structuredContent as { data: HealthToolData }).data;
}

function listen(app: ReturnType<typeof createHttpApp>): Promise<Server> {
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => { servers.push(server); resolve(server); });
  });
}
function portOf(server: Server): number {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return address.port;
}
function close(server: Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}
async function connect(services: Awaited<ReturnType<typeof compose>>): Promise<Client> {
  const app = createHttpApp(services);
  const server = await listen(app);
  const client = new Client({ name: 'health-test', version: '1' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${portOf(server)}/mcp`)));
  return client;
}
async function withEnv(name: string, value: string, run: () => Promise<void>): Promise<void> {
  const previous = process.env[name];
  process.env[name] = value;
  try { await run(); } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}
