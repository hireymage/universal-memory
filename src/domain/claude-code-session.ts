import type { ParsedConversation, ParsedMessage } from './chatgpt-export.js';
import { readBoundedFile } from './bounded-read.js';
import { MemoryError } from './errors.js';

/**
 * Parser for Claude Code session transcripts (~/.claude/projects/<dir>/<session>.jsonl).
 * Each line is one event. Only user and assistant *text* is kept: thinking,
 * tool calls, tool results, system events, API request blobs (these contain
 * the system prompt and account context) and sidechain (sub-agent) messages
 * are dropped, as are system-reminder injections. One JSONL file = one conversation.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(isRecord)
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text as string)
    .join('\n');
}

const isInjected = (text: string): boolean => text.trimStart().startsWith('<system-reminder>');

export async function parseClaudeCodeSession(filePath: string): Promise<ParsedConversation> {
  const raw = (await readBoundedFile(filePath)).toString('utf8');

  let sessionId: string | undefined;
  let title: string | undefined;
  let fallbackTitle: string | undefined;
  const messages: ParsedMessage[] = [];

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue; // a torn last line from an unfinished session is skipped
    }
    if (!isRecord(event)) continue;
    if (typeof event.sessionId === 'string') sessionId ??= event.sessionId;
    if (event.type === 'custom-title' && typeof event.customTitle === 'string') title = event.customTitle;
    if (event.type === 'agent-name' && typeof event.agentName === 'string') title ??= event.agentName;
    if (event.isSidechain === true) continue;

    const role = event.type === 'user' ? 'user' : event.type === 'assistant' ? 'assistant' : undefined;
    if (!role || !isRecord(event.message)) continue;
    const content = event.message.content;
    // A user event that carries tool results is not a human message.
    if (role === 'user' && Array.isArray(content) && content.some(b => isRecord(b) && b.type === 'tool_result')) continue;
    const text = textOf(content);
    if (!text.trim() || isInjected(text)) continue;
    const createdUtc = typeof event.timestamp === 'string' && !Number.isNaN(Date.parse(event.timestamp))
      ? new Date(event.timestamp).toISOString()
      : undefined;
    if (role === 'user' && !fallbackTitle) fallbackTitle = text.trim().split('\n')[0]?.slice(0, 80);
    messages.push(createdUtc ? { role, text, createdUtc } : { role, text });
  }

  if (!sessionId) throw new MemoryError('VALIDATION_ERROR', `No sessionId found in Claude Code session: ${filePath}`);
  const first = messages[0]?.createdUtc ?? '';
  const last = messages[messages.length - 1]?.createdUtc ?? first;
  return {
    id: sessionId,
    title: title ?? fallbackTitle ?? 'Untitled Claude Code session',
    createdUtc: first,
    updatedUtc: last,
    messages,
  };
}
