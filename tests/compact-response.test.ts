import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { compose } from '../src/composition.js';
import { createMemoryMcpServer } from '../src/transports/mcp/server.js';
import { compactValue, fitBudget } from '../src/transports/mcp/present.js';
import type { AppConfig } from '../src/config/schema.js';
import type { Services } from '../src/composition.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

const routing = {
  note: { backend: 'markdown', path: 'Notes/{slug}.md' },
  person: { backend: 'markdown', path: 'People/{slug}.md' },
  memory: { backend: 'markdown', path: 'Memory/{slug}.md' },
};

async function setup(extra: Partial<AppConfig> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'compact-response-'));
  roots.push(root);
  const vault = path.join(root, 'vault');
  await mkdir(vault, { recursive: true });
  const config: AppConfig = {
    name: 'Compact', vault_root: vault, read_only: false, audit_dir: path.join(root, 'audit'),
    transport: 'stdio', http: { bind: '127.0.0.1', port: 3333, allowed_origins: [], bearer_token_env: 'TEST_TOKEN' },
    routing, response: 'compact', toolset: 'full', tool_discovery: 'eager', advertise_output_schema: false, ...extra,
  };
  return { vault, services: await compose(config) };
}

async function connect(services: Services): Promise<Client> {
  const server = createMemoryMcpServer(services);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'compact-test', version: '0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(clientTransport);
  return client;
}

function envelope(result: { content?: Array<{ type?: string; text?: string }>; structuredContent?: unknown; isError?: boolean }) {
  expect(result.isError).not.toBe(true);
  const text = result.content?.find(item => item.type === 'text')?.text ?? '';
  return { text, body: JSON.parse(text) as { ok: boolean; data: Record<string, unknown>; meta?: unknown }, structured: result.structuredContent };
}

describe('compact MCP responses', () => {
  it('drops frontmatter, echoed inputs, nulls, and the duplicate structured copy', async () => {
    const { services } = await setup();
    const body = `${'A long remembered sentence about the vault. '.repeat(80)}UniqueMarker`;
    const created = await services.memory.create({
      type: 'note', title: 'Long note', content: body,
      metadata: { mood: 'calm', source_note: 'kept as a scalar field' },
    });
    await services.graph.createClaim(created.metadata.id, { predicate: 'mood', value: 'calm' }, created.revision);
    const client = await connect(services);
    const current = await services.memory.get(created.metadata.id);
    const recalled = envelope(await client.callTool({ name: 'recall', arguments: { id: current.metadata.id } }));
    expect(recalled.structured).toBeUndefined();
    expect(recalled.body.meta).toBeUndefined();
    expect(recalled.body.ok).toBe(true);
    const note = recalled.body.data;
    expect(note.id).toBe(created.metadata.id);
    expect(note.revision).toBe(current.revision);
    expect(note.path).toBe(created.path);
    expect(note).not.toHaveProperty('metadata');
    expect(note.fields).toEqual({ mood: 'calm', source_note: 'kept as a scalar field' });
    expect(note.omitted).toContain('claims');
    expect(JSON.stringify(note.fields)).not.toContain('predicate');
    expect(note.content_truncated).toBe(true);
    expect(String(note.content)).not.toContain('UniqueMarker');
    expect(String(note.content).endsWith('…')).toBe(true);

    const detailed = envelope(await client.callTool({ name: 'recall', arguments: { id: created.metadata.id, detail: true } }));
    expect(detailed.body.data.metadata).toMatchObject({ mood: 'calm', claims: [expect.objectContaining({ predicate: 'mood' })] });
    expect(detailed.body.data.content).toContain('UniqueMarker');
    expect(detailed.body.data).not.toHaveProperty('content_truncated');

    const searched = envelope(await client.callTool({ name: 'search_memory', arguments: { query: 'UniqueMarker', limit: 5 } }));
    expect(searched.body.data).not.toHaveProperty('query');
    const lexical = searched.body.data.lexical as Array<Record<string, unknown>>;
    expect(lexical[0]?.revision).toEqual(expect.any(String));
    expect(String(lexical[0]?.revision).length).toBeGreaterThan(8);
    expect(lexical[0]?.snippet).toEqual(expect.any(String));
    const neural = searched.body.data.neural as Record<string, unknown>;
    expect(neural).not.toHaveProperty('note');
    expect(neural).not.toHaveProperty('query');
    expect(neural).not.toHaveProperty('method');

    const listed = envelope(await client.callTool({ name: 'search_entities', arguments: { query: 'UniqueMarker' } }));
    const hits = listed.body.data as unknown as Array<Record<string, unknown>>;
    expect(Array.isArray(hits)).toBe(true);
    expect(hits[0]).not.toHaveProperty('metadata');
    expect(hits[0]).not.toHaveProperty('content');
    expect(hits[0]?.snippet).toEqual(expect.any(String));
    expect(hits[0]?.revision).toEqual(expect.any(String));

    const context = envelope(await client.callTool({ name: 'retrieve_context', arguments: { query: 'UniqueMarker', limit: 5 } }));
    const matches = context.body.data.matches as Array<{ content: string }>;
    expect(matches.some(match => match.content.includes('UniqueMarker'))).toBe(true);

    const found = envelope(await client.callTool({ name: 'find', arguments: { query: 'UniqueMarker', limit: 5 } }));
    expect(found.body.data).not.toHaveProperty('query');
    expect(found.body.data).not.toHaveProperty('parsed');
    expect((found.body.data.hits as unknown[]).length).toBeGreaterThan(0);

    const associated = envelope(await client.callTool({ name: 'associate', arguments: { query: 'UniqueMarker' } }));
    expect(associated.body.data.advisory).toBe(true);
    expect(associated.body.data).not.toHaveProperty('note');
    expect(associated.body.data).not.toHaveProperty('method');
    expect(associated.body.data).not.toHaveProperty('query');

    const remembered = envelope(await client.callTool({ name: 'remember', arguments: { title: 'Long note', entity_type: 'note', content: 'Another capture of the same title.' } }));
    const dedup = remembered.body.data.dedup as { decision: string; candidates: Array<{ entity: { content?: string; id: string } }> };
    expect(dedup.decision).not.toBe('no_match');
    expect(dedup.candidates[0]?.entity).not.toHaveProperty('content');
    expect(dedup.candidates[0]?.entity.id).toEqual(expect.any(String));
    await client.close();
  });

  it('advertised output schema keeps the compact body and adds structuredContent', async () => {
    const { services } = await setup({ advertise_output_schema: true });
    const created = await services.memory.create({ type: 'note', title: 'Listed', content: 'Short enough to keep.' });
    const client = await connect(services);
    const result = await client.callTool({ name: 'recall', arguments: { id: created.metadata.id } });
    const structured = result.structuredContent as { ok: boolean; data: { id: string; revision: string }; meta: { api_version: string } };
    expect(structured.ok).toBe(true);
    expect(structured.meta.api_version).toBe('1');
    expect(structured.data.id).toBe(created.metadata.id);
    expect(structured.data.revision).toBe(created.revision);
    await client.close();
  });

  it('full response mode restores the entity, the envelope, and structuredContent', async () => {
    const { services } = await setup({ response: 'full' });
    const created = await services.memory.create({ type: 'note', title: 'Plain', content: 'Short body.', metadata: { mood: 'calm' } });
    const client = await connect(services);
    const result = await client.callTool({ name: 'get_entity', arguments: { id: created.metadata.id } });
    const structured = result.structuredContent as { ok: boolean; data: { metadata: { mood: string }; content: string }; meta: { api_version: string } };
    expect(structured.meta.api_version).toBe('1');
    expect(structured.data.metadata.mood).toBe('calm');
    expect(structured.data.content).toContain('Short body.');
    expect(JSON.parse(result.content?.find(item => item.type === 'text')?.text ?? '').data.content).toContain('Short body.');
    await client.close();
  });
});

describe('response budget', () => {
  it('marks a payload that had to be cut down', () => {
    const huge = { notes: Array.from({ length: 30 }, (_, index) => ({ id: `n${index}`, content: 'word '.repeat(200) })) };
    const fitted = fitBudget(huge, 500) as { _truncated: boolean; notes: unknown[]; notes_omitted?: number };
    expect(fitted._truncated).toBe(true);
    expect(JSON.stringify(fitted).length).toBeLessThanOrEqual(800);
    expect(fitted.notes.length).toBeLessThan(30);
  });

  it('keeps empty lists, and does not split emoji or shorten ids', () => {
    expect(compactValue({ people: [], calendar: [] }, { mode: 'compact' })).toEqual({ people: [], calendar: [] });
    const revision = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    const fitted = fitBudget({
      id: revision,
      revision,
      path: 'Notes/poznámka.md',
      content: `${'😀'.repeat(400)}Příliš žluťoučký kůň úpěl ďábelské ódy. TAIL`,
    }, 180) as { id: string; revision: string; path: string; content: string };
    expect(fitted.id).toBe(revision);
    expect(fitted.revision).toBe(revision);
    expect(fitted.path).toBe('Notes/poznámka.md');
    expect(fitted.content).not.toContain('TAIL');
    expect(JSON.stringify(fitted)).not.toMatch(/\uD800(?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])\uDC00/);
    expect(Array.from(fitted.content).at(-1)).toBe('…');
  });
});
