import { inflateRawSync } from 'node:zlib';
import { MemoryError } from './errors.js';
import { MAX_ENTRY_BYTES, MAX_EXPORT_BYTES, readBoundedFile } from './bounded-read.js';

/**
 * Pure ChatGPT export parser. Accepts either the official export archive
 * (.zip, containing conversations.json) or a plain conversations.json file.
 * Zero external dependencies: the ZIP path uses a minimal EOCD -> central
 * directory -> local header scan with node:zlib (method 8 deflate, method 0
 * stored).
 *
 * The node tree is flattened by walking from current_node up the parent
 * chain to the root and reversing the chain; a visited set guards against
 * cycles. Malformed conversations/entries are skipped silently — only an
 * unreadable file, a missing conversations.json inside the zip, or a
 * non-array root raise MemoryError('VALIDATION_ERROR').
 */

export interface ParsedMessage {
  role: 'user' | 'assistant';
  text: string;
  createdUtc?: string;
}

export interface ParsedConversation {
  id: string;
  title: string;
  createdUtc: string;
  updatedUtc: string;
  messages: ParsedMessage[];
}

// ZIP signatures are the ASCII bytes 'P','K',<type>,<version>; read little-endian
// that is 0x04034B50 (local), 0x02014B50 (central), 0x06054B50 (end of central dir).
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const ZIP_ENTRY_NAME = 'conversations.json';

/** ChatGPT timestamps are Unix seconds; emit ISO UTC, '' when absent/invalid. */
const toIso = (value: unknown): string =>
  typeof value === 'number' && Number.isFinite(value) ? new Date(value * 1000).toISOString() : '';

export function extractZipEntry(buffer: Buffer, wantedName: string, maxEntryBytes = MAX_ENTRY_BYTES): Buffer {
  if (buffer.length > MAX_EXPORT_BYTES) throw new MemoryError('VALIDATION_ERROR', `ZIP archive is too large (limit ${MAX_EXPORT_BYTES} bytes)`);
  if (unsafeZipName(wantedName)) throw new MemoryError('VALIDATION_ERROR', 'ZIP entry name is not allowed');
  let eocd = -1;
  for (let i = buffer.length - 4; i >= 0; i--) {
    if (i + 4 <= buffer.length && buffer.readUInt32LE(i) === EOCD_SIGNATURE) { eocd = i; break; }
  }
  if (eocd < 0 || eocd + 22 > buffer.length) throw new MemoryError('VALIDATION_ERROR', `Not a valid ZIP archive: ${wantedName} end-of-central-directory not found`);
  const centralCount = buffer.readUInt16LE(eocd + 10);
  if (centralCount > 10_000) throw new MemoryError('VALIDATION_ERROR', 'ZIP archive has too many entries');
  let cursor = buffer.readUInt32LE(eocd + 16);
  for (let i = 0; i < centralCount; i++) {
    need(buffer, cursor, 46);
    if (buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) throw new MemoryError('VALIDATION_ERROR', 'Corrupt ZIP central directory');
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    need(buffer, cursor + 46, nameLength);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    if (name === wantedName) {
      if (unsafeZipName(name)) throw new MemoryError('VALIDATION_ERROR', 'ZIP entry name is not allowed');
      if (compressedSize > maxEntryBytes || uncompressedSize > maxEntryBytes) {
        throw new MemoryError('VALIDATION_ERROR', `ZIP entry is too large (limit ${maxEntryBytes} bytes)`);
      }
      need(buffer, localOffset, 30);
      if (buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) throw new MemoryError('VALIDATION_ERROR', `Corrupt ZIP local header for ${wantedName}`);
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      need(buffer, localOffset + 30, localNameLength);
      const localName = buffer.toString('utf8', localOffset + 30, localOffset + 30 + localNameLength);
      if (localName !== name) throw new MemoryError('VALIDATION_ERROR', 'ZIP local header name does not match the central directory');
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      need(buffer, dataStart, compressedSize);
      const raw = buffer.subarray(dataStart, dataStart + compressedSize);
      if (method === 8) return inflateCapped(raw, maxEntryBytes);
      if (method === 0) {
        if (raw.length > maxEntryBytes) throw new MemoryError('VALIDATION_ERROR', `ZIP entry is too large (limit ${maxEntryBytes} bytes)`);
        return Buffer.from(raw);
      }
      throw new MemoryError('VALIDATION_ERROR', `Unsupported ZIP compression method ${method} for ${wantedName}`);
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  throw new MemoryError('VALIDATION_ERROR', `ZIP archive does not contain ${wantedName}`);
}

function unsafeZipName(name: string): boolean {
  if (!name || name.includes('\0') || name.includes('\\') || name.startsWith('/')) return true;
  return name.split('/').some((part) => !part || part === '.' || part === '..');
}

function need(buffer: Buffer, offset: number, length: number): void {
  if (offset < 0 || length < 0 || offset + length > buffer.length) throw new MemoryError('VALIDATION_ERROR', 'Corrupt ZIP archive');
}

function inflateCapped(raw: Buffer, max: number): Buffer {
  try {
    return inflateRawSync(raw, { maxOutputLength: max });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
      throw new MemoryError('VALIDATION_ERROR', `ZIP entry expands past ${max} bytes`);
    }
    throw new MemoryError('VALIDATION_ERROR', 'ZIP entry could not be inflated');
  }
}

function extractText(content: Record<string, unknown>): string {
  const parts = content.parts;
  if (!Array.isArray(parts)) return '';
  if (content.content_type === 'code') {
    const language = String(parts[0] ?? '');
    const code = parts.slice(1).join('\n');
    return `\`\`\`${language}\n${code}\n\`\`\``;
  }
  if (content.content_type === 'text') {
    return parts.filter(part => typeof part === 'string').join('\n');
  }
  return ''; // tool/system/other content types are never transcript text
}

function parseConversation(raw: unknown): ParsedConversation | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const conversation = raw as Record<string, unknown>;
  const id = typeof conversation.id === 'string' && conversation.id ? conversation.id : undefined;
  const mapping = conversation.mapping;
  if (!id || !mapping || typeof mapping !== 'object') return undefined;
  const nodes = mapping as Record<string, unknown>;
  const current = typeof conversation.current_node === 'string' ? conversation.current_node : undefined;
  if (!current || !nodes[current]) return undefined;

  // Walk current_node -> root via parent links, then reverse into linear order.
  const chain: Array<Record<string, unknown>> = [];
  const visited = new Set<string>();
  let nodeId: string | undefined = current;
  while (nodeId) {
    if (visited.has(nodeId)) break; // cycle guard
    visited.add(nodeId);
    const node: unknown = nodes[nodeId];
    if (!node || typeof node !== 'object') break;
    chain.push(node as Record<string, unknown>);
    const parent: unknown = (node as Record<string, unknown>).parent;
    nodeId = typeof parent === 'string' ? parent : undefined;
  }
  chain.reverse();

  const messages: ParsedMessage[] = [];
  for (const node of chain) {
    const message = node.message;
    if (!message || typeof message !== 'object') continue;
    // Real ChatGPT exports put the role under message.author.role; keep the flat form for older fixtures.
    const record = message as Record<string, unknown>;
    const author = record.author as Record<string, unknown> | undefined;
    const role = author && typeof author === 'object' ? author.role : record.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const content = (message as Record<string, unknown>).content;
    if (!content || typeof content !== 'object') continue;
    const text = extractText(content as Record<string, unknown>);
    if (!text.trim()) continue;
    const createdUtc = toIso((message as Record<string, unknown>).create_time);
    messages.push(createdUtc ? { role, text, createdUtc } : { role, text });
  }

  return {
    id,
    title: typeof conversation.title === 'string' && conversation.title.trim() ? conversation.title : 'Untitled conversation',
    createdUtc: toIso(conversation.create_time),
    updatedUtc: toIso(conversation.update_time),
    messages,
  };
}

export async function parseChatGptExport(filePath: string): Promise<ParsedConversation[]> {
  const buffer = await readBoundedFile(filePath);
  let root: unknown;
  try {
    root = JSON.parse((filePath.toLowerCase().endsWith('.zip') ? extractZipEntry(buffer, ZIP_ENTRY_NAME) : buffer).toString('utf8'));
  } catch (error) {
    if (error instanceof MemoryError) throw error;
    throw new MemoryError('VALIDATION_ERROR', `Invalid conversations.json in ChatGPT export: ${filePath}`, error instanceof Error ? error.message : String(error));
  }
  if (!Array.isArray(root)) throw new MemoryError('VALIDATION_ERROR', `ChatGPT export root must be an array of conversations: ${filePath}`);
  const conversations: ParsedConversation[] = [];
  for (const entry of root) {
    const parsed = parseConversation(entry);
    if (parsed) conversations.push(parsed);
  }
  return conversations;
}
