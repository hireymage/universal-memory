import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { compose } from '../src/composition.js';
import { loadConfig } from '../src/config/schema.js';
import { createHttpApp } from '../src/transports/http/server.js';
import { InMemoryIndex } from '../src/adapters/index/in-memory-index.js';
import { BdhSidecarClient } from '../src/adapters/neural/bdh-client.js';
import { MirroringIndex } from '../src/adapters/neural/mirroring-index.js';
import { NeuralMemoryService } from '../src/application/neural-memory-service.js';
import type { NeuralAssociativeMemory, NeuralDocument } from '../src/ports/neural.js';
import type { AppConfig } from '../src/config/schema.js';
import type { Entity } from '../src/domain/types.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

const routing: AppConfig['routing'] = {
  memory: { backend: 'markdown', path: 'Memory/{slug}.md' },
  note: { backend: 'markdown', path: 'Notes/{slug}.md' },
  person: { backend: 'markdown', path: 'People/{slug}.md' },
  project: { backend: 'markdown', path: 'Projects/{slug}/index.md' },
  inbox: { backend: 'markdown', path: 'Inbox/{slug}.md' },
};

function entity(id: string, title: string, content: string): Entity {
  return {
    metadata: {
      id, type: 'note', title, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
      aliases: [], tags: [], status: 'active', schema_version: 1,
    },
    content, path: `Notes/${id}.md`, revision: `rev-${id}`, wikilinks: [],
  };
}

function fakeNeural(impl: Partial<NeuralAssociativeMemory> & { enabled?: boolean } = {}): NeuralAssociativeMemory & { docs: NeuralDocument[]; removed: string[] } {
  const docs: NeuralDocument[] = [];
  const removed: string[] = [];
  return {
    docs, removed,
    enabled: impl.enabled ?? true,
    async upsert(document) { if (impl.upsert) return impl.upsert(document); docs.push(document); },
    async remove(id) { if (impl.remove) return impl.remove(id); removed.push(id); },
    associate: impl.associate ?? (async () => ({ available: true, results: [] })),
    rebuild: impl.rebuild ?? (async documents => { docs.splice(0, docs.length, ...documents); return { available: true, indexed: documents.length }; }),
    health: impl.health ?? (async () => ({ enabled: true, available: true, entities: docs.length })),
  };
}

describe('BDH adapter', () => {
  it('is disabled by default and associate stays advisory without calling the network', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'memory-neural-off-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, 'vault'));
    const config: AppConfig = {
      name: 'Neural off', vault_root: path.join(root, 'vault'), read_only: false,
      audit_dir: path.join(root, 'audit'), transport: 'stdio',
      http: { bind: '127.0.0.1', port: 3333, allowed_origins: [], bearer_token_env: 'UNSET_TEST_TOKEN' },
      routing,
    };
    const services = await compose(config);
    const created = await services.memory.create({ type: 'note', title: 'Still written', content: 'Markdown first' });
    expect(created.metadata.title).toBe('Still written');
    const associated = await services.neuralMemory.associate('Still', 5, 'hybrid');
    expect(associated.enabled).toBe(false);
    expect(associated.available).toBe(false);
    expect(associated.results).toEqual([]);
    expect(associated.advisory).toBe(true);
    expect(services.neural.enabled).toBe(false);
  });

  it('keeps the write when the sidecar is down and reports associate as unavailable', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'memory-neural-down-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, 'vault'));
    const config: AppConfig = {
      name: 'Neural down', vault_root: path.join(root, 'vault'), read_only: false,
      audit_dir: path.join(root, 'audit'), transport: 'stdio',
      http: { bind: '127.0.0.1', port: 3333, allowed_origins: [], bearer_token_env: 'UNSET_TEST_TOKEN' },
      routing,
      neural: { enabled: true, base_url: 'http://127.0.0.1:1', bearer_token_env: 'UNSET_TEST_TOKEN', timeout_ms: 400 },
    };
    const services = await compose(config);
    const created = await services.memory.create({ type: 'note', title: 'Survives', content: 'the sidecar is not there' });
    expect((await services.memory.get(created.metadata.id)).content).toContain('the sidecar is not there');
    const associated = await services.neuralMemory.associate('sidecar', 5, 'neural');
    expect(associated.enabled).toBe(true);
    expect(associated.available).toBe(false);
    expect(associated.degraded).toBe(true);
    expect(associated.results).toEqual([]);
    expect(associated.warning).toBeTruthy();
    const hybrid = await services.neuralMemory.associate('sidecar', 5, 'hybrid');
    expect(hybrid.degraded).toBe(true);
    expect(hybrid.results.map(hit => hit.source)).toEqual(['lexical']);
    expect(hybrid.results[0]?.title).toBe('Survives');
  });

  it('mirrors create, update and reindex, and a throwing sidecar cannot fail the write', async () => {
    const seen: NeuralDocument[] = [];
    let rebuilds = 0;
    const neural = fakeNeural({
      async upsert(document) { seen.push(document); },
      async rebuild(documents) { rebuilds += 1; seen.splice(0, seen.length, ...documents); return { available: true, indexed: documents.length }; },
    });
    const inner = new InMemoryIndex();
    const mirror = new MirroringIndex(inner, neural);
    const root = await mkdtemp(path.join(os.tmpdir(), 'memory-neural-mirror-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, 'vault'));
    const config: AppConfig = {
      name: 'Neural mirror', vault_root: path.join(root, 'vault'), read_only: false,
      audit_dir: path.join(root, 'audit'), transport: 'stdio',
      http: { bind: '127.0.0.1', port: 3333, allowed_origins: [], bearer_token_env: 'UNSET_TEST_TOKEN' },
      routing,
    };
    // Drive the real storage through a composed server, but swap in the mirror
    // by constructing storage the same way compose does: create via MemoryService
    // would need the mirror injected. Call the mirror the way storage does.
    await mirror.upsert(entity('note-1', 'Ranní rituál', 'Comandante mele a Lelit vaří.'));
    expect(seen.map(doc => doc.title)).toEqual(['Ranní rituál']);
    expect(await inner.findById('note-1')).toMatchObject({ revision: 'rev-note-1' });
    const throwing = new MirroringIndex(inner, fakeNeural({ async upsert() { throw new Error('sidecar exploded'); } }));
    await expect(throwing.upsert(entity('note-2', 'Still indexed', 'body'))).resolves.toBeUndefined();
    expect(await inner.findById('note-2')).toBeDefined();
    const report = await mirror.rebuild((async function* () { yield entity('note-1', 'Ranní rituál', 'Comandante mele a Lelit vaří.'); })());
    expect(report.indexed).toBe(1);
    expect(report.neural_available).toBe(true);
    expect(rebuilds).toBe(1);
    expect(config.name).toBe('Neural mirror');
  });

  it('merges a learned hit that substring search does not return', async () => {
    const index = new InMemoryIndex();
    const bridge = entity('bridge', 'Ranní rituál', 'Comandante mele a Lelit vaří.');
    const gift = entity('gift', 'Dárek od Evy', 'Lelit dostala Eva k narozeninám.');
    const garden = entity('garden', 'Zahrada', 'Tulipány kvetou na záhoně.');
    await index.upsert(bridge); await index.upsert(gift); await index.upsert(garden);
    const neural = fakeNeural({
      async associate() { return { available: true, results: [{ id: 'bridge', score: 0.9 }, { id: 'gift', score: 0.4 }] }; },
    });
    const service = new NeuralMemoryService(neural, index, async id => index.findById(id).then(found => found ? [bridge, gift, garden].find(item => item.metadata.id === id) : undefined));
    const neuralOnly = await service.associate('Comandante', 10, 'neural');
    expect(neuralOnly.results.map(hit => hit.id)).toEqual(['bridge', 'gift']);
    expect(neuralOnly.results.every(hit => hit.source === 'neural')).toBe(true);
    expect(neuralOnly.note).toMatch(/Advisory only/);
    const lexical = await index.search({ query: 'Comandante', limit: 10 });
    expect(lexical.map(item => item.metadata.id)).toEqual(['bridge']);
    const hybrid = await service.associate('Comandante', 10, 'hybrid');
    expect(hybrid.results.map(hit => hit.id)).toEqual(['bridge', 'gift']);
    expect(hybrid.results[0]?.source).toBe('both');
    expect(hybrid.results[1]?.source).toBe('neural');
    expect(hybrid.results[1]?.title).toBe('Dárek od Evy');
  });

  it('ingests created and reindexed entities and still commits Markdown when the sidecar fails', async () => {
    const hits: string[] = [];
    const server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        if (req.url) hits.push(req.url);
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: { message: 'down' } }));
      });
    });
    await listen(server);
    cleanup.push(() => close(server));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    const root = await mkdtemp(path.join(os.tmpdir(), 'memory-neural-hook-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, 'vault'));
    const config: AppConfig = {
      name: 'Neural hook', vault_root: path.join(root, 'vault'), read_only: false,
      audit_dir: path.join(root, 'audit'), transport: 'stdio',
      http: { bind: '127.0.0.1', port: 3333, allowed_origins: [], bearer_token_env: 'UNSET_TEST_TOKEN' },
      routing,
      neural: { enabled: true, base_url: `http://127.0.0.1:${address.port}`, bearer_token_env: 'UNSET_TEST_TOKEN', timeout_ms: 1000 },
    };
    const services = await compose(config);
    const created = await services.memory.create({ type: 'note', title: 'Ranní rituál', content: 'Comandante mele a Lelit vaří.' });
    const updated = await services.memory.update(created.metadata.id, { content: 'Comandante mele a Lelit vaří dál.' }, created.revision);
    expect(updated.content).toContain('dál');
    await services.maintenance.reindex();
    expect(hits).toContain('/v1/upsert');
    expect(hits).toContain('/v1/rebuild');
    expect(await services.memory.search({ query: 'Lelit' })).toHaveLength(1);
  });

  it('talks to a mock sidecar and degrades on HTTP 500', async () => {
    const requests: Array<{ url?: string; authorization?: string; body?: unknown }> = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(chunk as Buffer));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        requests.push({ url: req.url, authorization: req.headers.authorization, body: raw ? JSON.parse(raw) : undefined });
        if (req.url === '/v1/upsert' && requests.filter(item => item.url === '/v1/upsert').length === 1) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: { message: 'busy' } }));
          return;
        }
        if (req.url === '/v1/associate') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, advisory: true, results: [{ id: 'gift', score: 0.44 }] }));
          return;
        }
        if (req.url === '/health') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, entities: 2, device: 'cpu' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, indexed: 2, removed: true }));
      });
    });
    await listen(server);
    cleanup.push(() => close(server));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    const client = new BdhSidecarClient({ baseUrl: `http://127.0.0.1:${address.port}`, token: 'secret', timeoutMs: 1000 });
    await client.upsert({ id: 'bridge', title: 'Ranní rituál', aliases: [], content: 'Comandante a Lelit' });
    const health = await client.health();
    expect(health.available).toBe(true);
    expect(health.entities).toBe(2);
    const associated = await client.associate('Comandante', 5);
    expect(associated).toEqual({ available: true, results: [{ id: 'gift', score: 0.44 }], vectorAvailable: false, vectorResults: [] });
    const scored = new BdhSidecarClient({ baseUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 1000, vectorMinScore: 0.25 });
    await scored.associate('floor', 4);
    const sent = requests.find(item => item.url === '/v1/associate' && (item.body as { query?: string } | undefined)?.query === 'floor')?.body as { min_score?: number; limit?: number };
    expect(sent).toMatchObject({ query: 'floor', limit: 4, min_score: 0.25 });
    expect(requests.some(item => item.authorization === 'Bearer secret')).toBe(true);
    const rebuilt = await client.rebuild([
      { id: 'a', title: 'A', aliases: [], content: 'one' },
      { id: 'b', title: 'B', aliases: [], content: 'two' },
    ]);
    expect(rebuilt.available).toBe(true);
    const rebuildBody = requests.find(item => item.url === '/v1/rebuild')?.body as { reset?: boolean; entities?: unknown[] };
    expect(rebuildBody.reset).toBe(true);
    expect(rebuildBody.entities).toHaveLength(2);
  });

  it('exposes associate over REST and MCP, including validation and the disabled payload', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'memory-neural-http-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, 'vault'));
    const config: AppConfig = {
      name: 'Neural HTTP', vault_root: path.join(root, 'vault'), read_only: false,
      audit_dir: path.join(root, 'audit'), transport: 'http',
      http: { bind: '127.0.0.1', port: 3333, allowed_origins: [], bearer_token_env: 'UNSET_TEST_TOKEN' },
      routing,
    };
    const services = await compose(config);
    const app = createHttpApp(services);
    const http = await listenApp(app);
    cleanup.push(() => close(http));
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    const base = `http://127.0.0.1:${address.port}`;
    const missing = await fetch(`${base}/api/v1/associate`);
    expect(missing.status).toBe(400);
    const badMode = await fetch(`${base}/api/v1/associate?q=test&mode=vector`);
    expect(badMode.status).toBe(400);
    const ok = await fetch(`${base}/api/v1/associate?q=Comandante&mode=hybrid`);
    expect(ok.status).toBe(200);
    const body = await ok.json() as { advisory: boolean; enabled: boolean; available: boolean; results: unknown[] };
    expect(body.advisory).toBe(true);
    expect(body.enabled).toBe(false);
    expect(body.available).toBe(false);
    expect(body.results).toEqual([]);
    const client = new Client({ name: 'neural-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
    cleanup.push(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    const listed = await client.listTools();
    expect(listed.tools.map(tool => tool.name)).toContain('associate');
    expect(listed.tools.find(tool => tool.name === 'associate')?.description).toMatch(/Advisory/);
    const call = await client.callTool({ name: 'associate', arguments: { query: 'Comandante' } }) as { isError?: boolean; structuredContent?: { ok: boolean; data: { enabled: boolean; advisory: boolean } } };
    expect(call.isError).not.toBe(true);
    expect(call.structuredContent?.ok).toBe(true);
    expect(call.structuredContent?.data.advisory).toBe(true);
    expect(call.structuredContent?.data.enabled).toBe(false);
  });

  it('wires neural.vector_min_score through compose into the sidecar request and the result filter', async () => {
    const requests: Array<{ url?: string; body?: { id?: string; query?: string; min_score?: number } }> = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(chunk as Buffer));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const body = raw ? JSON.parse(raw) as { id?: string; query?: string; min_score?: number } : undefined;
        requests.push({ url: req.url, body });
        if (req.url === '/v1/associate') {
          const strong = requests.find(item => item.url === '/v1/upsert' && item.body?.id)?.body?.id;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            ok: true,
            results: [],
            vector_available: true,
            vector_results: [
              { id: strong, score: 0.9 },
              { id: strong, score: 0.1 },
              { id: 'missing-from-index', score: 0.99 },
            ],
          }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, unchanged: false, indexed: 1 }));
      });
    });
    await listen(server);
    cleanup.push(() => close(server));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    const root = await mkdtemp(path.join(os.tmpdir(), 'memory-neural-floor-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, 'vault'));
    const services = await compose({
      name: 'Neural floor', vault_root: path.join(root, 'vault'), read_only: false,
      audit_dir: path.join(root, 'audit'), transport: 'stdio',
      http: { bind: '127.0.0.1', port: 3333, allowed_origins: [], bearer_token_env: 'UNSET_TEST_TOKEN' },
      routing,
      neural: { enabled: true, base_url: `http://127.0.0.1:${address.port}`, bearer_token_env: 'UNSET_TEST_TOKEN', timeout_ms: 1000, vector_min_score: 0.25 },
    });
    const created = await services.memory.create({ type: 'note', title: 'Kept', content: 'above the floor' });
    const out = await services.neuralMemory.associate('floor', 5, 'neural');
    const sent = requests.find(item => item.url === '/v1/associate')?.body;
    expect(sent?.min_score).toBe(0.25);
    expect(out.vector_results.map(hit => ({ id: hit.id, score: hit.score }))).toEqual([{ id: created.metadata.id, score: 0.9 }]);
  });

  it('parses config with the neural block omitted and with it enabled', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'memory-neural-config-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const file = path.join(root, 'config.yml');
    await writeFile(file, 'name: Cfg\nvault_root: ./vault\nread_only: true\naudit_dir: ./.state/audit\nrouting:\n  note:\n    backend: markdown\n    path: "Notes/{slug}.md"\n');
    const plain = await loadConfig(file);
    expect(plain.neural).toBeUndefined();
    await writeFile(file, 'name: Cfg\nvault_root: ./vault\nread_only: true\naudit_dir: ./.state/audit\nneural:\n  enabled: true\nrouting:\n  note:\n    backend: markdown\n    path: "Notes/{slug}.md"\n');
    const enabled = await loadConfig(file);
    expect(enabled.neural).toMatchObject({ enabled: true, base_url: 'http://127.0.0.1:8091', bearer_token_env: 'MEMORY_API_TOKEN', timeout_ms: 1500 });
  });
});

function listenApp(app: ReturnType<typeof createHttpApp>): Promise<Server> {
  return new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
}
function listen(server: Server): Promise<Server> {
  return new Promise(resolve => { server.listen(0, '127.0.0.1', () => resolve(server)); });
}
function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
