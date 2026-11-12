import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { compose } from '../src/composition.js';
import { createHttpApp } from '../src/transports/http/server.js';
import { classifyCreate } from '../src/domain/classification.js';
import type { AppConfig } from '../src/config/schema.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'classification-test-')); roots.push(root);
  const vault = path.join(root, 'vault'); await mkdir(vault, { recursive: true });
  const config: AppConfig = { name: 'Classification Test', vault_root: vault, read_only: false, audit_dir: path.join(root, 'state', 'audit'), transport: 'stdio', http: { bind: '127.0.0.1', port: 3333, allowed_origins: [], bearer_token_env: 'TEST_TOKEN' }, routing: { project: { backend: 'markdown', path: '02 Projects/{slug}/index.md' }, person: { backend: 'markdown', path: 'People/{slug}.md' }, note: { backend: 'markdown', path: '03 Knowledge/{slug}.md' }, knowledge: { backend: 'markdown', path: '03 Knowledge/{slug}.md' }, decision: { backend: 'markdown', path: '10 Decisions/{slug}.md' }, folder_collection: { backend: 'markdown', path: '{collection_path}/index.md' }, inbox: { backend: 'markdown', path: '01 Inbox/{date}-{slug}.md' }, memory: { backend: 'markdown', path: '03 Knowledge/{slug}.md' } } };
  return { root, vault, services: await compose(config) };
}

const routes = {
  person: { backend: 'markdown', path: 'People/{slug}.md' },
  note: { backend: 'markdown', path: '04 Knowledge/{slug}.md' },
  decision: { backend: 'markdown', path: '10 Decisions/{slug}.md' },
  inbox: { backend: 'markdown', path: '00 Inbox/{date}-{slug}.md' },
  memory: { backend: 'markdown', path: 'Memory/{slug}.md' },
};

describe('advisory classification rules (pure)', () => {
  it('suggests a type for a generic memory title with a note pattern', () => {
    const block = classifyCreate({ type: 'memory', title: 'Notes on Kafka clustering' }, routes);
    expect(block).toMatchObject({ suggested_type: 'note', confidence: 'medium' });
    expect(block?.suggested_collections).toBeUndefined();
  });

  it('suggests person plus family collection for a kinship title on a generic type', () => {
    const block = classifyCreate({ type: 'memory', title: 'Notes on my mother' }, routes);
    expect(block?.suggested_type).toBe('person');
    expect(block?.suggested_collections).toEqual(['People/family']);
    expect(block?.routing_notes?.length).toBeGreaterThan(0);
  });

  it('flags a person with family hints routed flat without collection pinning', () => {
    const block = classifyCreate({ type: 'person', title: 'Grandmother contact details' }, routes);
    expect(block?.suggested_type).toBeUndefined();
    expect(block?.suggested_collections).toEqual(['People/family']);
    expect(block?.routing_notes?.some(note => note.includes('People/{slug}.md'))).toBe(true);
    expect(block?.confidence).toBe('medium');
  });

  it('raises confidence when metadata and title corroborate the family hint', () => {
    const block = classifyCreate({ type: 'person', title: 'My father', metadata: { family: true } }, routes);
    expect(block?.confidence).toBe('high');
    expect(block?.suggested_collections).toEqual(['People/family']);
  });

  it('stays silent when the type is explicit, matching, and pinned', () => {
    expect(classifyCreate({ type: 'note', title: 'Kafka clustering notes' }, routes)).toBeNull();
    expect(classifyCreate({ type: 'decision', title: 'Decision on the Kafka migration' }, routes)).toBeNull();
    expect(classifyCreate({ type: 'person', title: 'My father', metadata: { family: true, member_of_collections: ['People/family'] } }, routes)).toBeNull();
    expect(classifyCreate({ type: 'inbox', title: 'Pay the electricity invoice' }, routes)).toBeNull();
  });

  it('reports an unknown type that silently falls back to the memory route', () => {
    const block = classifyCreate({ type: 'widget', title: 'Widget inventory' }, routes);
    expect(block?.confidence).toBe('low');
    expect(block?.suggested_type).toBeUndefined();
    expect(block?.routing_notes?.some(note => note.includes('falls back to the "memory" route'))).toBe(true);
  });

  it('matches Czech words that end in a diacritic and suggests the new types', () => {
    expect(classifyCreate({ type: 'memory', title: 'Rozhodnutí o migraci' }, routes)).toMatchObject({ suggested_type: 'decision', confidence: 'medium' });
    expect(classifyCreate({ type: 'memory', title: 'Maminka' }, routes)).toMatchObject({
      suggested_type: 'person', suggested_collections: ['People/family'], confidence: 'medium',
    });
    expect(classifyCreate({ type: 'person', title: 'Maminka', metadata: { family: true } }, routes)?.confidence).toBe('high');
    expect(classifyCreate({ type: 'memory', title: 'Koupit mléko do pátku' }, routes)?.suggested_type).toBe('task');
    expect(classifyCreate({ type: 'memory', title: 'Udělat review kódu' }, routes)?.suggested_type).toBe('task');
    expect(classifyCreate({ type: 'memory', title: 'TODO: zavolat' }, routes)?.suggested_type).toBe('task');
    expect(classifyCreate({ type: 'memory', title: '- [ ] koupit chleba' }, routes)?.suggested_type).toBe('task');
    expect(classifyCreate({ type: 'memory', title: 'Schůzka 12. 11. 2026 v 14:30' }, routes)?.suggested_type).toBe('event');
    expect(classifyCreate({ type: 'memory', title: 'Call 2026-11-12 09:00' }, routes)?.suggested_type).toBe('event');
    expect(classifyCreate({ type: 'memory', title: 'Mám rád kávu' }, routes)?.suggested_type).toBe('preference');
    expect(classifyCreate({ type: 'memory', title: 'Nemám rád zimu' }, routes)?.suggested_type).toBe('preference');
    expect(classifyCreate({ type: 'memory', title: 'Preferuji tmavý režim' }, routes)?.suggested_type).toBe('preference');
    expect(classifyCreate({ type: 'memory', title: 'Nápad na redesign' }, routes)?.suggested_type).toBe('idea');
    expect(classifyCreate({ type: 'memory', title: 'Narozeniny Evy' }, routes)?.suggested_type).toBe('person');
    expect(classifyCreate({ type: 'memory', title: 'Narozeniny Evy' }, routes)?.suggested_collections).toBeUndefined();
    expect(classifyCreate({ type: 'memory', title: 'Poznámka ke Kafce' }, routes)?.suggested_type).toBe('note');
    expect(classifyCreate({ type: 'memory', title: 'Rozhodnutím' }, routes)).toBeNull();
    expect(classifyCreate({ type: 'note', title: 'Udělat review' }, routes)?.suggested_type).toBe('task');
  });

  it('suggests the nearest known type for an unrouted alias or near-miss', () => {
    const alias = classifyCreate({ type: 'todo', title: 'něco později' }, routes);
    expect(alias?.confidence).toBe('low');
    expect(alias?.suggested_type).toBe('task');
    expect(alias?.routing_notes?.some(note => note.includes('nearest known type is "task"') && note.includes('alias'))).toBe(true);
    expect(alias?.routing_notes?.some(note => note.includes('falls back to the "memory" route'))).toBe(true);
    const similar = classifyCreate({ type: 'preferences', title: 'oblíbené' }, routes);
    expect(similar?.suggested_type).toBe('preference');
    expect(similar?.routing_notes?.some(note => note.includes('similarity'))).toBe(true);
  });

  it('never mutates the draft', () => {
    const draft = { type: 'memory', title: 'Notes on my sister', metadata: { tags: ['family'] } };
    const snapshot = JSON.stringify(draft);
    classifyCreate(draft, routes);
    expect(JSON.stringify(draft)).toBe(snapshot);
  });
});

describe('createWithDedup classification integration', () => {
  it('adds an advisory classification block for ambiguous generic-type creates', async () => {
    const { services } = await setup();
    const draft = { type: 'memory', title: 'Notes on Kafka clustering', metadata: { tags: ['kafka'] } };
    const snapshot = JSON.stringify(draft);
    const created = await services.memory.createWithDedup(draft);
    expect(created.entity.metadata.title).toBe('Notes on Kafka clustering');
    expect(created.classification).toMatchObject({ suggested_type: 'note', confidence: 'medium' });
    expect(JSON.stringify(draft)).toBe(snapshot); // the draft is never mutated
  });

  it('omits the classification key for confident creates', async () => {
    const { services } = await setup();
    const note = await services.memory.createWithDedup({ type: 'note', title: 'Kafka clustering notes' });
    expect(note.classification).toBeUndefined();
    const person = await services.memory.createWithDedup({ type: 'person', title: 'Ada Lovelace', metadata: { member_of_collections: ['People/family'] } });
    expect(person.classification).toBeUndefined();
  });

  it('never lets a classification failure block the create or change the response', async () => {
    const { services } = await setup();
    const memory = services.memory as unknown as { routes: Record<string, unknown> };
    memory.routes = new Proxy({}, { get: () => { throw new Error('classification config unavailable'); } });
    const created = await services.memory.createWithDedup({ type: 'note', title: 'Resilient classification' });
    expect(created.entity.metadata.title).toBe('Resilient classification');
    expect('classification' in created).toBe(false);
    expect(created.dedup.decision).toBe('no_match');
  });

  it('keeps existing dedup behavior unchanged', async () => {
    const { services } = await setup();
    const first = await services.memory.createWithDedup({ type: 'note', title: 'Kafka clustering notes' });
    expect(first.dedup.decision).toBe('no_match');
    expect(first.dedup.candidates).toHaveLength(0);
    const second = await services.memory.createWithDedup({ type: 'note', title: 'Kafka clustering note' });
    expect(second.dedup.candidates.length).toBeGreaterThan(0);
    expect(['likely_duplicate', 'possible_duplicate']).toContain(second.dedup.decision);
  });
});

describe('MCP create tools carry the additive classification key', () => {
  it('surfaces classification alongside dedup without changing existing keys', async () => {
    const { services } = await setup();
    const app = createHttpApp(services);
    const http = await listen(app);
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('No TCP address');
    const base = `http://127.0.0.1:${address.port}`;
    const client = new Client({ name: 'classification-test-client', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    const data = (call: { structuredContent?: unknown }): Record<string, unknown> => (call.structuredContent as { data: Record<string, unknown> }).data;

    const remember = await client.callTool({ name: 'remember', arguments: { title: 'Notes on Kafka clustering', content: 'first' } });
    expect(remember.isError).not.toBe(true);
    expect(data(remember).dedup).toMatchObject({ decision: 'no_match', candidates: [] });
    expect(data(remember).classification).toMatchObject({ suggested_type: 'note', confidence: 'medium' });

    const note = await client.callTool({ name: 'notes', arguments: { action: 'create', title: 'Kafka clustering notes' } });
    expect(data(note).dedup).toBeDefined();
    expect(data(note).classification).toBeUndefined();

    const person = await client.callTool({ name: 'people', arguments: { action: 'create', title: 'Grandmother contact details' } });
    expect(data(person).dedup).toBeDefined();
    expect((data(person).classification as { suggested_collections: string[] }).suggested_collections).toEqual(['People/family']);

    const entity = await client.callTool({ name: 'create_entity', arguments: { entity_type: 'widget', title: 'Widget inventory' } });
    expect(data(entity).dedup).toBeDefined();
    expect((data(entity).classification as { confidence: string }).confidence).toBe('low');

    await client.close();
    await close(http);
  });
});

function listen(app: ReturnType<typeof createHttpApp>): Promise<Server> { return new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); }); }
function close(server: Server): Promise<void> { return new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve()))); }
