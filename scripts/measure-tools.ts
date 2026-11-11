/**
 * Print tools/list size for each MEMORY_TOOLSET profile.
 *
 * Tokens use js-tiktoken o200k_base (the same encoding as the catalog baseline).
 * The payload is the tools array a client receives from tools/list:
 * `{ tools: [{ name, description, inputSchema, outputSchema? }] }`.
 *
 *   npx tsx scripts/measure-tools.ts
 *   MEMORY_OUTPUT_SCHEMA=true npx tsx scripts/measure-tools.ts
 */
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { getEncoding } from 'js-tiktoken';
import { createMemoryMcpServer } from '../src/transports/mcp/server.js';
import type { Services } from '../src/composition.js';
import { TOOLSETS, type Toolset } from '../src/transports/mcp/toolsets.js';

const encoding = getEncoding('o200k_base');
const tokens = (value: string) => encoding.encode(value).length;

async function listed(toolset: Toolset, advertiseOutput: boolean) {
  const services = { config: { toolset, advertise_output_schema: advertiseOutput } } as Services;
  const server = createMemoryMcpServer(services);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'measure-tools', version: '0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(clientTransport);
  const tools = (await client.listTools()).tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
  }));
  await client.close();
  return tools;
}

const advertiseOutput = process.env.MEMORY_OUTPUT_SCHEMA === 'true' || process.env.MEMORY_OUTPUT_SCHEMA === '1';
console.log(`tokenizer: js-tiktoken o200k_base`);
console.log(`outputSchema: ${advertiseOutput ? 'on' : 'off (default)'}`);
console.log('');

for (const toolset of TOOLSETS) {
  const tools = await listed(toolset, advertiseOutput);
  const payload = { tools };
  const compact = JSON.stringify(payload);
  const pretty = JSON.stringify(payload, null, 2);
  console.log(`## ${toolset}  tools=${tools.length}  compact=${tokens(compact)} tokens (${compact.length} chars)  pretty=${tokens(pretty)} tokens (${pretty.length} chars)`);
  const rows = tools.map(tool => {
    const compactTool = JSON.stringify(tool);
    return { name: tool.name, tokens: tokens(compactTool), chars: compactTool.length };
  }).sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name));
  for (const row of rows) console.log(`  ${row.tokens.toString().padStart(5)} tok  ${row.chars.toString().padStart(6)} ch  ${row.name}`);
  console.log('');
}
