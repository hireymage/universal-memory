import path from 'node:path';
import { parseChatGptExport, type ParsedConversation } from '../domain/chatgpt-export.js';
import { parseClaudeExport } from '../domain/claude-export.js';
import { MemoryService } from './memory-service.js';

/**
 * Dedup-aware chat-export import: one `source` entity per conversation,
 * created through MemoryService.createWithDedup so re-imports surface a
 * dedup decision (identical title → score 1.0 → 'likely_duplicate') without
 * ever blocking the create. Routing lands in 13 Resources/Sources/<provider>/
 * via the configured `source` route ({provider} comes from metadata.provider).
 */

export interface ChatGptImportResult {
  id: string;
  title: string;
  created: string;
  dedup_decision: string;
  path: string;
}

export interface ConversationImportOptions {
  provider: 'chatgpt' | 'claude';
  origin: string;
}

export function buildTranscriptMarkdown(conversation: ParsedConversation): string {
  const lines = [`# ${conversation.title}`];
  for (const message of conversation.messages) {
    lines.push('', `## ${message.role === 'user' ? 'User' : 'Assistant'}`, message.text);
  }
  return `${lines.join('\n')}\n`;
}

export async function importConversations(
  memory: MemoryService,
  inputPath: string,
  conversations: ParsedConversation[],
  options: ConversationImportOptions,
  client?: string,
): Promise<ChatGptImportResult[]> {
  const results: ChatGptImportResult[] = [];
  for (const conversation of conversations) {
    const { entity, dedup } = await memory.createWithDedup({
      type: 'source',
      title: conversation.title,
      content: buildTranscriptMarkdown(conversation),
      metadata: {
        provider: options.provider,
        origin: options.origin,
        conversation_id: conversation.id,
        identity_type: 'conversation',
        identity_value: conversation.id,
        created_at: conversation.createdUtc,
        updated_at: conversation.updatedUtc,
        original_file: path.resolve(inputPath),
        message_count: conversation.messages.length,
      },
    }, client);
    results.push({
      id: entity.metadata.id,
      title: entity.metadata.title,
      created: conversation.createdUtc,
      dedup_decision: dedup.decision,
      path: entity.path,
    });
  }
  return results;
}

export async function importChatGptExport(memory: MemoryService, inputPath: string, client?: string): Promise<ChatGptImportResult[]> {
  const conversations = await parseChatGptExport(inputPath);
  return importConversations(memory, inputPath, conversations, { provider: 'chatgpt', origin: 'chatgpt-export' }, client);
}

export async function importClaudeExport(memory: MemoryService, inputPath: string, client?: string): Promise<ChatGptImportResult[]> {
  const conversations = await parseClaudeExport(inputPath);
  return importConversations(memory, inputPath, conversations, { provider: 'claude', origin: 'claude-export' }, client);
}
