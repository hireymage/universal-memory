/**
 * Token size of common MCP tool results on a fixture vault.
 *
 * `full` is the previous envelope (raw payload, meta, text and structuredContent).
 * `compact` is the default. Tokens are js-tiktoken o200k_base.
 * `text` is the model-visible JSON. `wire` adds structuredContent when it is sent.
 *
 *   npm run measure:responses
 */
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { getEncoding } from 'js-tiktoken';
import { compose } from '../src/composition.js';
import { createMemoryMcpServer } from '../src/transports/mcp/server.js';
import type { AppConfig, ResponseMode } from '../src/config/schema.js';
import type { Services } from '../src/composition.js';

const encoding = getEncoding('o200k_base');
const tokens = (value: string) => encoding.encode(value).length;
const advertiseOutput = process.env.MEMORY_OUTPUT_SCHEMA !== 'false' && process.env.MEMORY_OUTPUT_SCHEMA !== '0';

const routing = {
  note: { backend: 'markdown', path: 'Notes/{slug}.md' },
  person: { backend: 'markdown', path: 'People/{slug}.md' },
  memory: { backend: 'markdown', path: 'Memory/{slug}.md' },
  task: { backend: 'markdown', path: 'Tasks/{slug}.md' },
};

async function vault(): Promise<{ services: (mode: ResponseMode) => Promise<Services>; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'measure-responses-'));
  const dir = path.join(root, 'vault');
  await mkdir(dir, { recursive: true });
  const base: AppConfig = {
    name: 'Measure', vault_root: dir, read_only: false, audit_dir: path.join(root, 'audit'),
    transport: 'stdio', http: { bind: '127.0.0.1', port: 3333, allowed_origins: [], bearer_token_env: 'TEST_TOKEN' },
    routing, toolset: 'full', tool_discovery: 'eager', response: 'full', advertise_output_schema: advertiseOutput,
  };
  return {
    services: async (mode) => {
      const services = await compose({ ...base, response: mode });
      await services.maintenance.reindex();
      return services;
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

async function connect(services: Services): Promise<Client> {
  const server = createMemoryMcpServer(services);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'measure-responses', version: '0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(clientTransport);
  return client;
}

function measure(result: { content?: Array<{ type?: string; text?: string }>; structuredContent?: unknown }) {
  const text = result.content?.find(item => item.type === 'text')?.text ?? '';
  const structured = result.structuredContent === undefined ? '' : JSON.stringify(result.structuredContent);
  let data = '';
  try { data = JSON.stringify(JSON.parse(text).data); } catch { data = ''; }
  return { text: tokens(text), data: tokens(data), wire: tokens(text) + (structured ? tokens(structured) : 0) };
}

async function main() {
  const made = await vault();
  try {
    const seeded = await made.services('full');
    const sentence = 'Společná věta o paměti a dlouhodobém záznamu. '.repeat(40);
    const ids: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      const note = await seeded.memory.create({
        type: 'note',
        title: `Paměť ${index}`,
        content: `${sentence}Položka ${index} obsahuje slovo paměť uprostřed dlouhého textu.`,
        metadata: { tags: ['prace'], mood: 'calm' },
      });
      ids.push(note.metadata.id);
    }
    const person = await seeded.memory.create({ type: 'person', title: 'Jan Novák', content: 'Soused, má rád kávu a dlouhé rozhovory o paměti.' });
    await seeded.graph.createRelation({ entity_id: ids[0]!, relation_type: 'about', target_id: person.metadata.id, expected_revision: (await seeded.memory.get(ids[0]!)).revision });
    const updated = await seeded.memory.get(ids[1]!);
    await seeded.memory.update(updated.metadata.id, { content: `${updated.content}\nDoplněno.` }, updated.revision);
    await seeded.health.run();

    const calls: Array<{ name: string; args: Record<string, unknown> }> = [
      { name: 'find', args: { query: 'paměť', limit: 10 } },
      { name: 'search_memory', args: { query: 'paměť', limit: 10 } },
      { name: 'search_memory', args: { query: 'paměť', limit: 10, verbose: true } },
      { name: 'recall', args: { id: ids[0] } },
      { name: 'get_entity', args: { id: ids[0] } },
      { name: 'search_entities', args: { query: 'paměť', limit: 10 } },
      { name: 'remember', args: { title: 'Nová paměť', content: 'Krátký záznam o měření tokenů a nic víc.' } },
      { name: 'update_memory', args: { id: ids[2] } },
      { name: 'health_report', args: {} },
      { name: 'associate', args: { query: 'paměť', limit: 10 } },
      { name: 'get_entity_relations', args: { entity_id: ids[0] } },
    ];

    console.log('tokenizer: js-tiktoken o200k_base');
    console.log(`outputSchema: ${advertiseOutput ? 'on (server default)' : 'off'}`);
    console.log('fixture: 10 long notes, 1 person, 1 relation, 1 health report');
    console.log('columns: data tokens inside the JSON, text tokens (what a text client pays), wire tokens (text plus structuredContent)');
    console.log('');
    console.log('call                                      full data  full text  full wire   compact data  compact text  compact wire');
    for (const call of calls) {
      const sizes: Record<ResponseMode, ReturnType<typeof measure>> = { full: { text: 0, data: 0, wire: 0 }, compact: { text: 0, data: 0, wire: 0 } };
      for (const mode of ['full', 'compact'] as const) {
        const services = await made.services(mode);
        const client = await connect(services);
        let args = call.args;
        if (call.name === 'update_memory') {
          const current = await services.memory.get(String(call.args.id));
          args = { id: current.metadata.id, expected_revision: current.revision, patch: { content: `Aktualizovaný text ${mode}.` } };
        }
        if (call.name === 'remember') args = { ...call.args, title: `Nová paměť ${mode}` };
        const result = await client.callTool({ name: call.name, arguments: args });
        if (result.isError) throw new Error(`${mode} ${call.name} failed: ${JSON.stringify(result.content)}`);
        sizes[mode] = measure(result);
        await client.close();
      }
      const label = `${call.name}${call.args.verbose ? ' verbose' : ''}`.padEnd(42);
      const cell = (value: number) => value.toString().padStart(8);
      console.log(`${label}${cell(sizes.full.data)}  ${cell(sizes.full.text)}  ${cell(sizes.full.wire)}   ${cell(sizes.compact.data)}  ${cell(sizes.compact.text)}  ${cell(sizes.compact.wire)}`);
    }
  } finally {
    await made.cleanup();
  }
}

main();
