import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { compose } from '../src/composition.js';
import { createHttpApp } from '../src/transports/http/server.js';
import type { AppConfig } from '../src/config/schema.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dedup-create-test-')); roots.push(root);
  const vault = path.join(root, 'vault'); await mkdir(vault, { recursive: true });
  const config: AppConfig = { name: 'Dedup Test', vault_root: vault, read_only: false, audit_dir: path.join(root, 'state', 'audit'), transport: 'stdio', toolset: 'full', tool_discovery: 'eager', response: 'full', http: { bind: '127.0.0.1', port: 3333, allowed_origins: [], bearer_token_env: 'TEST_TOKEN' }, routing: { project: { backend: 'markdown', path: '02 Projects/{slug}/index.md' }, person: { backend: 'markdown', path: 'People/{slug}.md' }, note: { backend: 'markdown', path: '03 Knowledge/{slug}.md' }, knowledge: { backend: 'markdown', path: '03 Knowledge/{slug}.md' }, folder_collection: { backend: 'markdown', path: '{collection_path}/index.md' }, inbox: { backend: 'markdown', path: '01 Inbox/{date}-{slug}.md' }, memory: { backend: 'markdown', path: '03 Knowledge/{slug}.md' } } };
  return { root, vault, services: await compose(config) };
}

describe('dedup-aware create responses', () => {
  it('surfaces ranked candidates for a near-duplicate create without blocking it', async () => {
    const { services } = await setup();
    const first = await services.memory.createWithDedup({ type: 'note', title: 'Kafka clustering notes', content: 'First capture' });
    expect(first.dedup.decision).toBe('no_match');
    expect(first.dedup.candidates).toHaveLength(0);
    const second = await services.memory.createWithDedup({ type: 'note', title: 'Kafka clustering note', content: 'Second capture' });
    // The check never blocks: the entity is created unconditionally.
    expect(second.entity.metadata.title).toBe('Kafka clustering note');
    expect(second.dedup.candidates.length).toBeGreaterThan(0);
    expect(second.dedup.candidates[0]!.entity.metadata.id).toBe(first.entity.metadata.id);
    expect(['likely_duplicate', 'possible_duplicate']).toContain(second.dedup.decision);
  });

  it('reports no_match with empty candidates for a clearly distinct title', async () => {
    const { services } = await setup();
    await services.memory.createWithDedup({ type: 'note', title: 'Kafka clustering notes' });
    const distinct = await services.memory.createWithDedup({ type: 'note', title: 'Sourdough starter maintenance' });
    expect(distinct.entity.metadata.title).toBe('Sourdough starter maintenance');
    expect(distinct.dedup.decision).toBe('no_match');
    expect(distinct.dedup.candidates).toHaveLength(0);
  });

  it('never lets a failing similarity/index path block the create', async () => {
    const { services } = await setup();
    const index = (services.memory as unknown as { index: { search: (query: unknown) => Promise<unknown[]> } }).index;
    index.search = async () => { throw new Error('index unavailable'); };
    const created = await services.memory.createWithDedup({ type: 'note', title: 'Resilient create' });
    expect(created.entity.metadata.title).toBe('Resilient create');
    expect(created.dedup.error).toBe('dedup_check_failed');
    expect(created.dedup.decision).toBe('no_match');
    expect(created.dedup.candidates).toHaveLength(0);
  });

  it('carries the additive dedup key in every MCP title-create tool response', async () => {
    const { services } = await setup();
    const app = createHttpApp(services);
    const http = await listen(app);
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('No TCP address');
    const base = `http://127.0.0.1:${address.port}`;
    const client = new Client({ name: 'dedup-test-client', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    const data = (call: { structuredContent?: unknown }): Record<string, unknown> => (call.structuredContent as { data: Record<string, unknown> }).data;

    const remember = await client.callTool({ name: 'remember', arguments: { title: 'Kafka clustering notes', content: 'first' } });
    expect(remember.isError).not.toBe(true);
    expect(data(remember).dedup).toMatchObject({ decision: 'no_match', candidates: [] });

    const entity = await client.callTool({ name: 'create_entity', arguments: { entity_type: 'memory', title: 'Kafka clustering note', content: 'second' } });
    expect(data(entity).dedup).toMatchObject({ decision: 'likely_duplicate' });
    expect((data(entity).dedup as { candidates: unknown[] }).candidates.length).toBeGreaterThan(0);

    const person = await client.callTool({ name: 'people', arguments: { action: 'create', title: 'Ada Lovelace' } });
    expect(data(person).dedup).toBeDefined();

    const project = await client.callTool({ name: 'projects', arguments: { action: 'create', title: 'Long Horizon' } });
    expect(data(project).dedup).toBeDefined();

    const inbox = await client.callTool({ name: 'inbox', arguments: { action: 'add', title: 'Pay invoice' } });
    expect(data(inbox).dedup).toBeDefined();

    const note = await client.callTool({ name: 'notes', arguments: { action: 'create', title: 'Finance workflow' } });
    expect(data(note).dedup).toBeDefined();

    const decision = await client.callTool({ name: 'record_project_decision', arguments: { project_id: (data(project).metadata as { id: string }).id, title: 'Use Kafka', decision: 'Cluster with Kafka', reason: 'Scale ingestion' } });
    expect(data(decision).dedup).toBeDefined();

    await client.close();
    await close(http);
  });
});

function listen(app: ReturnType<typeof createHttpApp>): Promise<Server> { return new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); }); }
function close(server: Server): Promise<void> { return new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve()))); }
