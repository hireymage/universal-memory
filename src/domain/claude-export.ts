import type { ParsedConversation, ParsedMessage } from './chatgpt-export.js';
import { readExportRoot } from './export-file.js';

/**
 * Parser for the Claude.ai data export (conversations.json, or the .zip that
 * contains it). Each conversation has `uuid`, `name`, `created_at`,
 * `updated_at` and `chat_messages[]`; a message has `sender`
 * ('human' | 'assistant'), `text` and `created_at`. Messages without text
 * are skipped; malformed conversations are skipped silently, like the
 * ChatGPT parser.
 */

const ZIP_ENTRY_NAME = 'conversations.json';

const toIso = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
};

function messageText(message: Record<string, unknown>): string {
  if (typeof message.text === 'string' && message.text.trim()) return message.text;
  // Newer exports can carry the text only in content blocks.
  if (Array.isArray(message.content)) {
    return message.content
      .filter((block): block is Record<string, unknown> => !!block && typeof block === 'object')
      .filter(block => block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text as string)
      .join('\n');
  }
  return '';
}

function parseConversation(raw: unknown): ParsedConversation | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const conversation = raw as Record<string, unknown>;
  const id = typeof conversation.uuid === 'string' && conversation.uuid ? conversation.uuid : undefined;
  if (!id || !Array.isArray(conversation.chat_messages)) return undefined;

  const messages: ParsedMessage[] = [];
  for (const entry of conversation.chat_messages) {
    if (!entry || typeof entry !== 'object') continue;
    const message = entry as Record<string, unknown>;
    const role = message.sender === 'human' ? 'user' : message.sender === 'assistant' ? 'assistant' : undefined;
    if (!role) continue;
    const text = messageText(message);
    if (!text.trim()) continue;
    const createdUtc = toIso(message.created_at);
    messages.push(createdUtc ? { role, text, createdUtc } : { role, text });
  }

  return {
    id,
    title: typeof conversation.name === 'string' && conversation.name.trim() ? conversation.name : 'Untitled conversation',
    createdUtc: toIso(conversation.created_at),
    updatedUtc: toIso(conversation.updated_at),
    messages,
  };
}

export async function parseClaudeExport(filePath: string): Promise<ParsedConversation[]> {
  const root = await readExportRoot(filePath, ZIP_ENTRY_NAME);
  const conversations: ParsedConversation[] = [];
  for (const entry of root) {
    const parsed = parseConversation(entry);
    if (parsed) conversations.push(parsed);
  }
  return conversations;
}
