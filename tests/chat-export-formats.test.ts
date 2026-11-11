import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseChatGptExport } from '../src/domain/chatgpt-export.js';
import { parseClaudeExport } from '../src/domain/claude-export.js';

let dir: string | undefined;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

async function writeJson(name: string, value: unknown): Promise<string> {
  dir = await mkdtemp(path.join(os.tmpdir(), 'umm-export-'));
  const file = path.join(dir, name);
  await writeFile(file, JSON.stringify(value));
  return file;
}

describe('ChatGPT export role lookup', () => {
  it('reads roles from message.author.role as the real export does', async () => {
    const file = await writeJson('conversations.json', [{
      id: 'chat-1',
      title: 'Author shape',
      create_time: 1700000000,
      update_time: 1700000100,
      current_node: 'n2',
      mapping: {
        root: { id: 'root', parent: null, message: null },
        n1: { id: 'n1', parent: 'root', message: { id: 'n1', author: { role: 'user' }, create_time: 1700000000, content: { content_type: 'text', parts: ['Question?'] } } },
        n2: { id: 'n2', parent: 'n1', message: { id: 'n2', author: { role: 'assistant' }, create_time: 1700000010, content: { content_type: 'text', parts: ['Answer.'] } } },
      },
    }]);
    const [conversation] = await parseChatGptExport(file);
    if (!conversation) throw new Error('no conversation parsed');
    expect(conversation.messages.map(m => [m.role, m.text])).toEqual([['user', 'Question?'], ['assistant', 'Answer.']]);
  });
});

describe('Claude export parser', () => {
  it('maps human/assistant senders and skips empty messages', async () => {
    const file = await writeJson('conversations.json', [{
      uuid: 'claude-conv-1',
      name: 'Test chat',
      created_at: '2026-01-02T10:00:00Z',
      updated_at: '2026-01-02T10:05:00Z',
      chat_messages: [
        { uuid: 'm1', sender: 'human', text: 'Hello', created_at: '2026-01-02T10:00:00Z' },
        { uuid: 'm2', sender: 'assistant', text: '', content: [{ type: 'text', text: 'Hi there' }], created_at: '2026-01-02T10:00:05Z' },
        { uuid: 'm3', sender: 'assistant', text: '   ', created_at: '2026-01-02T10:00:06Z' },
      ],
    }]);
    const [conversation] = await parseClaudeExport(file);
    if (!conversation) throw new Error('no conversation parsed');
    expect(conversation.id).toBe('claude-conv-1');
    expect(conversation.title).toBe('Test chat');
    expect(conversation.createdUtc).toBe('2026-01-02T10:00:00.000Z');
    expect(conversation.messages.map(m => [m.role, m.text])).toEqual([['user', 'Hello'], ['assistant', 'Hi there']]);
  });

  it('skips conversations without a uuid and rejects non-array roots', async () => {
    const file = await writeJson('conversations.json', [{ name: 'no id', chat_messages: [] }]);
    expect(await parseClaudeExport(file)).toEqual([]);
    const bad = await writeJson('bad.json', { not: 'an array' });
    await expect(parseClaudeExport(bad)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});
