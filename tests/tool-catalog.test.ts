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

const eagerFull = { toolset: 'full' as const, tool_discovery: 'eager' as const };

function services(config: Partial<AppConfig> = {}): Services {
  return {
    config: { advertise_output_schema: false, ...config },
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
  it('defaults to the full eager catalog, so existing tool names stay listed', async () => {
    const client = await connect();
    const names = (await client.listTools()).tools.map(tool => tool.name).sort();
    expect(names).toEqual([...FULL_TOOLS].sort());
    expect(names).toEqual(expect.arrayContaining(['apply_changeset', 'reindex', 'people', 'projects', 'notes', 'inbox']));
    expect(names).not.toContain('tool_groups');
  });

  it('lazy full enables a hidden group on demand', async () => {
    const client = await connect({ toolset: 'full', tool_discovery: 'lazy' });
    const lazy = (await client.listTools()).tools.map(tool => tool.name);
    expect(lazy).toContain('tool_groups');
    expect(lazy).not.toContain('apply_changeset');
    expect(lazy).toEqual(expect.arrayContaining([...STANDARD_TOOLS]));
    const enabled = await client.callTool({ name: 'tool_groups', arguments: { group: 'maintenance', enable: true } });
    expect(enabled.isError).not.toBe(true);
    const after = (await client.listTools()).tools.map(tool => tool.name);
    expect(after).toEqual(expect.arrayContaining(['apply_changeset', 'reindex', 'run_health_check']));
    const called = await client.callTool({ name: 'reindex', arguments: {} });
    expect(textOf(called)).not.toMatch(/Tool reindex disabled/);
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
    expect(loaded.tool_discovery).toBe('eager');
    expect(loaded.verbose_schema).toBe(false);
    expect(loaded.response).toBe('compact');
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
    await withEnv('MEMORY_TOOL_DISCOVERY', 'eager', async () => {
      expect((await loadConfig(file)).tool_discovery).toBe('eager');
    });
    await withEnv('MEMORY_TOOL_DISCOVERY', 'sideways', async () => {
      await expect(loadConfig(file)).rejects.toThrow(/MEMORY_TOOL_DISCOVERY/);
    });
    await withEnv('MEMORY_RESPONSE', 'full', async () => {
      expect((await loadConfig(file)).response).toBe('full');
    });
    await withEnv('MEMORY_RESPONSE', 'huge', async () => {
      await expect(loadConfig(file)).rejects.toThrow(/MEMORY_RESPONSE/);
    });
    await withEnv('MEMORY_VERBOSE_SCHEMA', '1', async () => {
      expect((await loadConfig(file)).verbose_schema).toBe(true);
    });
  });
});

describe('advertised tool schemas', () => {
  it('omits outputSchema and $schema, keeps date types and defaults, and flattens unions', async () => {
    const tools = (await (await connect(eagerFull)).listTools()).tools;
    expect(tools.every(tool => tool.outputSchema === undefined)).toBe(true);
    let dateFields = 0;
    for (const tool of tools) {
      expect(tool.inputSchema).not.toHaveProperty('$schema');
      walk(tool.inputSchema, node => {
        if ('$schema' in node) throw new Error(`${tool.name} still advertises $schema`);
        expect(node.additionalProperties, tool.name).not.toBe(false);
        if (node.format === 'date' || node.format === 'date-time') {
          dateFields += 1;
          expect(node.pattern, tool.name).toBeUndefined();
          expect(node.type, tool.name).toBe('string');
        }
      });
    }
    expect(dateFields).toBe(24);
    const nameDays = tools.find(tool => tool.name === 'find_name_days');
    expect(nameDays?.inputSchema).toMatchObject({
      properties: { date: { type: 'string', format: 'date' }, from: { type: 'string', format: 'date' }, to: { type: 'string', format: 'date' } },
    });
    const searchMemory = tools.find(tool => tool.name === 'search_memory')?.inputSchema as { properties?: { limit?: { default?: number } } };
    const claims = tools.find(tool => tool.name === 'get_claims')?.inputSchema as { properties?: { limit?: { default?: number } } };
    const people = tools.find(tool => tool.name === 'list_people')?.inputSchema as { properties?: { limit?: { default?: number } } };
    const relations = tools.find(tool => tool.name === 'get_entity_relations')?.inputSchema as { properties?: { limit?: { default?: number } } };
    expect(searchMemory.properties?.limit?.default).toBe(20);
    expect(claims.properties?.limit?.default).toBe(100);
    expect(people.properties?.limit?.default).toBe(50);
    expect(relations.properties?.limit?.default).toBe(200);
    const profiles = tools.find(tool => tool.name === 'agent_profiles')?.inputSchema as { oneOf?: unknown; properties?: { action?: { enum?: string[] } } };
    expect(profiles.oneOf).toBeUndefined();
    expect(profiles.properties?.action?.enum).toContain('create');
    const inspect = tools.find(tool => tool.name === 'inspect_memory')?.inputSchema as { properties?: { scope?: { oneOf?: unknown; properties?: { kind?: { enum?: string[] } } } } };
    expect(inspect.properties?.scope?.oneOf).toBeUndefined();
    expect(inspect.properties?.scope?.properties?.kind?.enum).toContain('vault');
  });

  it('verbose schema keeps oneOf, defaults, and the ISO date type', async () => {
    const tools = (await (await connect({ ...eagerFull, verbose_schema: true })).listTools()).tools;
    let dateFields = 0;
    for (const tool of tools) {
      walk(tool.inputSchema, node => {
        if (node.format === 'date' || node.format === 'date-time') {
          dateFields += 1;
          expect(node.pattern, tool.name).toBeUndefined();
          expect(node.type).toBe('string');
        }
      });
    }
    expect(dateFields).toBe(24);
    const profiles = tools.find(tool => tool.name === 'agent_profiles')?.inputSchema as { oneOf?: unknown[] };
    expect(profiles.oneOf?.length).toBeGreaterThan(5);
    const remember = tools.find(tool => tool.name === 'remember')?.inputSchema as { properties?: { content?: { default?: string } }; additionalProperties?: boolean };
    expect(remember.additionalProperties).toBe(false);
    expect(remember.properties?.content?.default).toBe('');
  });

  it('can still advertise the shared output envelope, without $schema', async () => {
    const tools = (await (await connect({ ...eagerFull, advertise_output_schema: true, verbose_schema: true })).listTools()).tools;
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
    const full = await connect(eagerFull);
    const badTime = await full.callTool({ name: 'record_project_decision', arguments: { project_id: 'p', title: 't', decision: 'd', reason: 'r', decided_at: 'yesterday' } });
    expect(badTime.isError).toBe(true);
    expect(textOf(badTime)).toMatch(/Invalid ISO datetime/);
  });

  it('returns find_name_days fields inside data, once, unless the output schema is advertised', async () => {
    const expected = {
      people: [{ metadata: { id: 'p1', title: 'Martin' } }],
      from: '2026-11-11',
      to: '2026-11-11',
      calendar: [{ date: '2026-11-11', names: ['Martin'] }],
    };
    const compact = await connect();
    const quiet = await compact.callTool({ name: 'find_name_days', arguments: { date: '2026-11-11' } });
    expect(quiet.isError).not.toBe(true);
    expect(quiet.structuredContent).toBeUndefined();
    const quietBody = JSON.parse(textOf(quiet)) as { ok: boolean; data: typeof expected; meta?: unknown; from?: string };
    expect(quietBody.ok).toBe(true);
    expect(quietBody.meta).toBeUndefined();
    expect(quietBody.data).toEqual(expected);
    expect(quietBody.from).toBeUndefined();

    const client = await connect({ advertise_output_schema: true });
    const called = await client.callTool({ name: 'find_name_days', arguments: { date: '2026-11-11' } });
    expect(called.isError).not.toBe(true);
    const body = called.structuredContent as { ok: boolean; data: typeof expected; meta: { api_version: string }; from?: string };
    expect(Object.keys(body).sort()).toEqual(['data', 'meta', 'ok']);
    expect(body.meta.api_version).toBe('1');
    expect(body.data).toEqual(expected);
    expect(body.from).toBeUndefined();
    const schema = (await client.listTools()).tools.find(tool => tool.name === 'find_name_days')?.outputSchema as { properties?: Record<string, unknown> };
    for (const key of Object.keys(body)) expect(schema.properties).toHaveProperty(key);
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
