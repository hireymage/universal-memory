import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { MemoryError } from '../src/domain/errors.js';
import { parseChatGptExport } from '../src/domain/chatgpt-export.js';

const CREATED = 1700000000; // 2023-11-14T22:13:20.000Z
const UPDATED = 1700003600; // 2023-11-14T23:13:20.000Z

// Parent-chain tree: node-5 (current) -> node-4 -> node-3 -> node-2 -> node-1 (root).
// Includes a code message, an empty message, and system/tool roles to skip.
const fixture = [
  {
    id: 'conv-1',
    title: 'Python quickstart',
    create_time: CREATED,
    update_time: UPDATED,
    current_node: 'node-5',
    mapping: {
      'node-1': { id: 'node-1', parent: null, message: { role: 'user', create_time: CREATED, content: { content_type: 'text', parts: ['Hello, first question'] } } },
      'node-2': { id: 'node-2', parent: 'node-1', message: { role: 'system', create_time: CREATED, content: { content_type: 'text', parts: ['system instructions'] } } },
      'node-3': { id: 'node-3', parent: 'node-2', message: { role: 'assistant', create_time: CREATED + 10, content: { content_type: 'code', parts: ['python', 'print(1)'] } } },
      'node-4': { id: 'node-4', parent: 'node-3', message: { role: 'assistant', create_time: CREATED + 20, content: { content_type: 'text', parts: [''] } } },
      'node-5': { id: 'node-5', parent: 'node-4', message: { role: 'tool', create_time: CREATED + 30, content: { content_type: 'tool', parts: ['tool result'] } } },
    },
  },
  {
    id: 'conv-cycle',
    title: 'Cyclic tree',
    create_time: CREATED,
    update_time: UPDATED,
    current_node: 'cycle-a',
    mapping: {
      'cycle-a': { id: 'cycle-a', parent: 'cycle-b', message: { role: 'user', create_time: CREATED, content: { content_type: 'text', parts: ['A'] } } },
      'cycle-b': { id: 'cycle-b', parent: 'cycle-a', message: { role: 'assistant', create_time: CREATED + 1, content: { content_type: 'text', parts: ['B'] } } },
    },
  },
  { id: 'conv-malformed', title: 'No mapping' },
];

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function tempFile(name: string, content: string | Buffer): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chatgpt-export-test-')); roots.push(root);
  const file = path.join(root, name);
  await writeFile(file, content);
  return file;
}

// Hand-built minimal ZIP: local header + central directory + EOCD.
function buildZip(name: string, data: Buffer, method: 0 | 8): Buffer {
  const payload = method === 8 ? deflateRawSync(data) : data;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(payload.length, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt16LE(name.length, 22);
  local.writeUInt16LE(0, 24);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(payload.length, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt16LE(name.length, 24);
  central.writeUInt16LE(0, 26);
  central.writeUInt16LE(0, 28);
  central.writeUInt32LE(0, 30);
  central.writeUInt32LE(0, 34);
  const eocd = Buffer.alloc(20);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + name.length, 12);
  eocd.writeUInt32LE(30 + name.length + payload.length, 16);
  eocd.writeUInt16LE(0, 18);
  return Buffer.concat([local, Buffer.from(name, 'utf8'), payload, central, Buffer.from(name, 'utf8'), eocd]);
}

describe('ChatGPT export parser', () => {
  it('flattens the parent chain into linear order and skips system/tool/empty messages', async () => {
    const file = await tempFile('conversations.json', JSON.stringify(fixture));
    const conversations = await parseChatGptExport(file);
    expect(conversations).toHaveLength(2); // malformed entry skipped
    const [conversation] = conversations;
    expect(conversation!.id).toBe('conv-1');
    expect(conversation!.title).toBe('Python quickstart');
    expect(conversation!.createdUtc).toBe(new Date(CREATED * 1000).toISOString());
    expect(conversation!.updatedUtc).toBe(new Date(UPDATED * 1000).toISOString());
    expect(conversation!.createdUtc).not.toBe(conversation!.updatedUtc);
    // node-1 then node-3 only: system, empty, and tool nodes are skipped.
    expect(conversation!.messages.map(message => message.role)).toEqual(['user', 'assistant']);
    expect(conversation!.messages[0]!.text).toBe('Hello, first question');
    expect(conversation!.messages[0]!.createdUtc).toBe(new Date(CREATED * 1000).toISOString());
  });

  it('preserves code messages as fenced blocks with the language', async () => {
    const file = await tempFile('conversations.json', JSON.stringify(fixture));
    const [conversation] = await parseChatGptExport(file);
    const code = conversation!.messages[1]!;
    expect(code.text).toBe('```python\nprint(1)\n```');
  });

  it('terminates on a cyclic parent chain via the visited set', async () => {
    const file = await tempFile('conversations.json', JSON.stringify(fixture));
    const conversations = await parseChatGptExport(file);
    const cyclic = conversations[1]!;
    expect(cyclic.id).toBe('conv-cycle');
    expect(cyclic.messages.map(message => message.text)).toEqual(['B', 'A']);
  });

  it('parses a deflated (method 8) zip built in-test', async () => {
    const file = await tempFile('export.zip', buildZip('conversations.json', Buffer.from(JSON.stringify(fixture), 'utf8'), 8));
    const conversations = await parseChatGptExport(file);
    expect(conversations.map(conversation => conversation.id)).toEqual(['conv-1', 'conv-cycle']);
  });

  it('parses a stored (method 0) zip built in-test', async () => {
    const file = await tempFile('export-stored.zip', buildZip('conversations.json', Buffer.from(JSON.stringify(fixture), 'utf8'), 0));
    const conversations = await parseChatGptExport(file);
    expect(conversations).toHaveLength(2);
  });

  it('raises VALIDATION_ERROR for unreadable files, non-array roots, and zips without conversations.json', async () => {
    const missing = await parseChatGptExport(path.join(os.tmpdir(), 'definitely-missing-chatgpt-export.json')).catch(error => error);
    expect(missing).toBeInstanceOf(MemoryError);
    expect((missing as MemoryError).code).toBe('VALIDATION_ERROR');

    const objectRoot = await tempFile('conversations.json', JSON.stringify({ conversations: [] }));
    const badRoot = await parseChatGptExport(objectRoot).catch(error => error);
    expect(badRoot).toBeInstanceOf(MemoryError);
    expect((badRoot as MemoryError).code).toBe('VALIDATION_ERROR');

    const wrongZip = await tempFile('wrong.zip', buildZip('other.json', Buffer.from('[]', 'utf8'), 8));
    const missingEntry = await parseChatGptExport(wrongZip).catch(error => error);
    expect(missingEntry).toBeInstanceOf(MemoryError);
    expect((missingEntry as MemoryError).code).toBe('VALIDATION_ERROR');
  });
});
