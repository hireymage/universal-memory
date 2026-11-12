import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { loadConfig, resolveOutputSchemaFlag } from '../src/config/schema.js';
import { createMemoryMcpServer } from '../src/transports/mcp/server.js';
import { MINIMAL_TOOLS, STANDARD_TOOLS } from '../src/transports/mcp/toolsets.js';
import type { AppConfig } from '../src/config/schema.js';
import type { Services } from '../src/composition.js';

const FULL_TOOLS = [
  'remember', 'retrieve_context', 'retrieve_relevant_memory', 'recall', 'find', 'search_memory', 'associate',
  'update_memory', 'archive_memory', 'get_context', 'find_related', 'create_entity', 'get_entity',
  'update_entity', 'search_entities', 'link_entities', 'people', 'search_people', 'list_people',
  'get_person', 'get_person_context', 'find_birthdays', 'find_name_days', 'projects', 'record_project_decision',
  'inbox', 'notes', 'inspect_memory', 'validate_memory', 'find_conflicts', 'scan_external_files',
  'prepare_file_adoption', 'find_broken_links', 'find_duplicates', 'suggest_links', 'prepare_normalization',
  'apply_changeset', 'repair_relation_links', 'migrate_schema', 'reindex', 'audit_history', 'agent_profiles',
  'agent_bootstrap', 'resolve_entity', 'merge_entities', 'create_relation', 'get_entity_relations',
  'query_relations', 'delete_relation', 'build_relations', 'create_claim', 'get_claims', 'get_entity_timeline',
  'update_claim', 'invalidate_claim', 'correct_claim', 'find_suspect_claims', 'create_source', 'get_source',
  'distill_next_chunk', 'find_source', 'health_report', 'run_health_check', 'triage_inbox',
] as const;

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

function services(config: Partial<AppConfig> = {}): Services {
  return {
    config: { toolset: 'full', advertise_output_schema: false, ...config },
    people: { nameDays: async () => [{ metadata: { id: 'p1', title: 'Martin' } }] },
  } as unknown as Services;
}

async function connect(config: Partial<AppConfig> = {}): Promise<Client> {
  const server = createMemoryMcpServer(services(config));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'catalog-test', version: '0' }, { versionNegotiation: { mode: 'auto' } });
  cleanup.push(() => client.close());
  await client.connect(clientTransport);
  return client;
}

function walk(node: unknown, visit: (obj: Record<string, unknown>) => void): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach(item => walk(item, visit)); return; }
  const obj = node as Record<string, unknown>;
  visit(obj);
  for (const value of Object.values(obj)) walk(value, visit);
}

describe('MCP toolset profiles', () => {
  it('defaults to the full catalog, including aliases, maintenance, and agent profiles', async () => {
    const client = await connect();
    const names = (await client.listTools()).tools.map(tool => tool.name).sort();
    expect(names).toEqual([...FULL_TOOLS].sort());
    expect(names).toHaveLength(64);
  });

  it('minimal and standard expose only their catalogs', async () => {
    const minimal = (await (await connect({ toolset: 'minimal' })).listTools()).tools.map(tool => tool.name).sort();
    expect(minimal).toEqual([...MINIMAL_TOOLS].sort());
    const standard = (await (await connect({ toolset: 'standard' })).listTools()).tools.map(tool => tool.name).sort();
    expect(standard).toEqual([...STANDARD_TOOLS].sort());
    expect(standard).not.toContain('apply_changeset');
    expect(standard).not.toContain('agent_profiles');
    expect(standard).not.toContain('people');
    expect(standard).toEqual(expect.arrayContaining(['create_claim', 'create_relation', 'create_source', 'distill_next_chunk', 'resolve_entity']));
  });

  it('rejects an unknown toolset when the server is constructed and when config is loaded', async () => {
    expect(() => createMemoryMcpServer(services({ toolset: 'huge' as AppConfig['toolset'] }))).toThrow(/toolset must be minimal, standard, or full/);
    const root = await mkdtemp(path.join(os.tmpdir(), 'memory-toolset-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const file = path.join(root, 'config.yml');
    const yaml = 'name: Cfg\nvault_root: ./vault\nread_only: true\naudit_dir: ./.state/audit\nrouting:\n  note:\n    backend: markdown\n    path: "Notes/{slug}.md"\n';
    await writeFile(file, yaml);
    const loaded = await loadConfig(file);
    expect(loaded.toolset).toBe('full');
    expect(loaded.advertise_output_schema).toBe(false);
    await writeFile(file, `toolset: minimal\n${yaml}`);
    expect((await loadConfig(file)).toolset).toBe('minimal');
    await writeFile(file, `toolset: nope\n${yaml}`);
    await expect(loadConfig(file)).rejects.toThrow();
    await writeFile(file, `toolset: full\n${yaml}`);
    await withEnv('MEMORY_TOOLSET', 'standard', async () => {
      expect((await loadConfig(file)).toolset).toBe('standard');
    });
    await withEnv('MEMORY_TOOLSET', 'nope', async () => {
      await expect(loadConfig(file)).rejects.toThrow(/MEMORY_TOOLSET must be minimal, standard, or full/);
    });
    await withEnv('MEMORY_OUTPUT_SCHEMA', 'true', async () => {
      expect((await loadConfig(file)).advertise_output_schema).toBe(true);
    });
    await withEnv('MEMORY_OUTPUT_SCHEMA', 'maybe', async () => {
      await expect(loadConfig(file)).rejects.toThrow(/MEMORY_OUTPUT_SCHEMA/);
    });
    expect(resolveOutputSchemaFlag(false, 'off')).toBe(false);
  });
});

describe('advertised tool schemas', () => {
  it('omits outputSchema, $schema, and ISO date patterns by default', async () => {
    const tools = (await (await connect()).listTools()).tools;
    expect(tools.every(tool => tool.outputSchema === undefined)).toBe(true);
    let dateFields = 0;
    for (const tool of tools) {
      expect(tool.inputSchema).not.toHaveProperty('$schema');
      walk(tool.inputSchema, node => {
        if ('$schema' in node) throw new Error(`${tool.name} still advertises $schema`);
        if (node.format === 'date' || node.format === 'date-time') {
          dateFields += 1;
          expect(node.pattern, tool.name).toBeUndefined();
          expect(node.type).toBe('string');
        }
      });
    }
    expect(dateFields).toBe(24);
    const nameDays = tools.find(tool => tool.name === 'find_name_days');
    expect(nameDays?.inputSchema).toMatchObject({
      properties: { date: { type: 'string', format: 'date' }, from: { type: 'string', format: 'date' }, to: { type: 'string', format: 'date' } },
    });
  });

  it('can still advertise the shared output envelope, without $schema', async () => {
    const tools = (await (await connect({ advertise_output_schema: true })).listTools()).tools;
    expect(tools.every(tool => tool.outputSchema !== undefined)).toBe(true);
    const output = tools[0]?.outputSchema as { additionalProperties?: boolean; properties?: Record<string, unknown> };
    expect(output.additionalProperties).toBe(false);
    expect(output).not.toHaveProperty('$schema');
    expect(output.properties).toHaveProperty('data');
  });

  it('still rejects invalid dates and datetimes with the SDK validation error', async () => {
    const client = await connect();
    const badDate = await client.callTool({ name: 'find_name_days', arguments: { date: '2026-13-40' } });
    expect(badDate.isError).toBe(true);
    expect(textOf(badDate)).toBe('Input validation error: Invalid arguments for tool find_name_days: date: Invalid ISO date');
    const notLeap = await client.callTool({ name: 'find_name_days', arguments: { date: '2026-02-29' } });
    expect(notLeap.isError).toBe(true);
    expect(textOf(notLeap)).toMatch(/Invalid ISO date/);
    const badTime = await client.callTool({ name: 'record_project_decision', arguments: { project_id: 'p', title: 't', decision: 'd', reason: 'r', decided_at: 'yesterday' } });
    expect(badTime.isError).toBe(true);
    expect(textOf(badTime)).toMatch(/Invalid ISO datetime/);
  });

  it('returns find_name_days fields inside data, including when output schema validation is on', async () => {
    for (const advertise_output_schema of [false, true]) {
      const client = await connect({ advertise_output_schema });
      const called = await client.callTool({ name: 'find_name_days', arguments: { date: '2026-11-11' } });
      expect(called.isError).not.toBe(true);
      const body = called.structuredContent as { ok: boolean; data: { people: Array<{ metadata: { title: string } }>; from: string; to: string; calendar: Array<{ date: string; names: string[] }> }; meta: { api_version: string }; from?: string };
      expect(Object.keys(body).sort()).toEqual(['data', 'meta', 'ok']);
      expect(body.ok).toBe(true);
      expect(body.meta.api_version).toBe('1');
      expect(body.data).toEqual({
        people: [{ metadata: { id: 'p1', title: 'Martin' } }],
        from: '2026-11-11',
        to: '2026-11-11',
        calendar: [{ date: '2026-11-11', names: ['Martin'] }],
      });
      expect(body.from).toBeUndefined();
      if (advertise_output_schema) {
        const schema = (await client.listTools()).tools.find(tool => tool.name === 'find_name_days')?.outputSchema as { additionalProperties?: boolean; properties?: Record<string, unknown> };
        expect(schema.additionalProperties).toBe(false);
        for (const key of Object.keys(body)) expect(schema.properties).toHaveProperty(key);
      }
    }
  });
});

function textOf(result: { content?: Array<{ type?: string; text?: string }> }): string {
  const block = result.content?.find(item => item.type === 'text');
  return block?.text ?? '';
}

async function withEnv(name: string, value: string, run: () => Promise<void>): Promise<void> {
  const previous = process.env[name];
  process.env[name] = value;
  try { await run(); }
  finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}
