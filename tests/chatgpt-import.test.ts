import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { compose } from '../src/composition.js';
import { importChatGptExport } from '../src/application/chatgpt-import.js';
import type { AppConfig } from '../src/config/schema.js';

const CREATED = 1700000000; // 2023-11-14T22:13:20.000Z
const UPDATED = 1700003600;

const fixture = [
  {
    id: 'conv-1',
    title: 'Python quickstart',
    create_time: CREATED,
    update_time: UPDATED,
    current_node: 'node-3',
    mapping: {
      'node-1': { id: 'node-1', parent: null, message: { role: 'user', create_time: CREATED, content: { content_type: 'text', parts: ['How do I print in Python?'] } } },
      'node-2': { id: 'node-2', parent: 'node-1', message: { role: 'system', create_time: CREATED, content: { content_type: 'text', parts: ['ignored'] } } },
      'node-3': { id: 'node-3', parent: 'node-2', message: { role: 'assistant', create_time: CREATED + 5, content: { content_type: 'code', parts: ['python', 'print(1)'] } } },
    },
  },
  {
    id: 'conv-2',
    title: 'Weekend hiking plans',
    create_time: CREATED + 100,
    update_time: UPDATED + 100,
    current_node: 'node-1',
    mapping: {
      'node-1': { id: 'node-1', parent: null, message: { role: 'user', create_time: CREATED + 100, content: { content_type: 'text', parts: ['Ideas for a hike?'] } } },
    },
  },
];

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chatgpt-import-test-')); roots.push(root);
  const vault = path.join(root, 'vault'); await mkdir(vault, { recursive: true });
  const exportFile = path.join(root, 'conversations.json');
  await writeFile(exportFile, JSON.stringify(fixture));
  // Temp vault only — never the real vault_root from config.yml.
  const config: AppConfig = { name: 'ChatGPT Import Test', vault_root: vault, read_only: false, audit_dir: path.join(root, 'state', 'audit'), transport: 'stdio', http: { bind: '127.0.0.1', port: 3333, allowed_origins: [], bearer_token_env: 'TEST_TOKEN' }, routing: { source: { backend: 'markdown', path: '13 Resources/Sources/{provider}/{date}-{slug}.md' } } };
  return { vault, exportFile, services: await compose(config) };
}

describe('dedup-aware ChatGPT source import', () => {
  it('creates one source entity per conversation routed under 13 Resources/Sources/chatgpt', async () => {
    const { vault, exportFile, services } = await setup();
    const results = await importChatGptExport(services.memory, exportFile);
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.dedup_decision).toBe('no_match');
      expect(result.path.startsWith('13 Resources/Sources/chatgpt/')).toBe(true);
    }
    const [first] = results;
    expect(first!.title).toBe('Python quickstart');
    expect(first!.created).toBe(new Date(CREATED * 1000).toISOString());
    const entity = await services.memory.get(first!.id);
    expect(entity.metadata.type).toBe('source');
    expect(entity.metadata.provider).toBe('chatgpt');
    expect(entity.metadata.origin).toBe('chatgpt-export');
    expect(entity.metadata.conversation_id).toBe('conv-1');
    expect(entity.metadata.identity_type).toBe('conversation');
    expect(entity.metadata.identity_value).toBe('conv-1');
    expect(entity.metadata.created_at).toBe(new Date(CREATED * 1000).toISOString());
    expect(entity.metadata.updated_at).toBe(new Date(UPDATED * 1000).toISOString());
    expect(entity.metadata.original_file).toBe(exportFile);
    expect(entity.metadata.message_count).toBe(2);
    // Markdown body: title heading, User/Assistant sections, fenced code kept.
    expect(entity.content).toContain('# Python quickstart');
    expect(entity.content).toContain('## User');
    expect(entity.content).toContain('## Assistant');
    expect(entity.content).toContain('```python\nprint(1)\n```');
    // The routed file physically exists inside the temp vault.
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(path.join(vault, first!.path), 'utf8');
    expect(raw).toContain('provider: chatgpt');
  });

  it('re-import of the same conversation surfaces likely_duplicate without blocking the create', async () => {
    const { services, exportFile } = await setup();
    const first = await importChatGptExport(services.memory, exportFile);
    const second = await importChatGptExport(services.memory, exportFile);
    expect(second).toHaveLength(2);
    for (const result of second) {
      expect(['likely_duplicate', 'possible_duplicate']).toContain(result.dedup_decision);
    }
    // Identical titles score 1.0, so the expected decision is likely_duplicate.
    expect(second[0]!.dedup_decision).toBe('likely_duplicate');
    expect(second[0]!.id).not.toBe(first[0]!.id); // create is never blocked
  });
});
