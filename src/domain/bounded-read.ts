import { readFile, stat } from 'node:fs/promises';
import { MemoryError } from './errors.js';

/**
 * Whole export on disk, including zip attachments that are never unpacked.
 * A multi-year ChatGPT export is often hundreds of megabytes. 2 GiB stops a
 * huge file without rejecting a normal archive. `MEMORY_EXPORT_MAX_BYTES`
 * overrides it (integer bytes, at least 1 MiB).
 */
export const DEFAULT_EXPORT_BYTES = 2 * 1024 * 1024 * 1024;
/**
 * One inflated `conversations.json` (or a plain JSON/JSONL file of that size).
 * The cap is what stops a zip bomb. 512 MiB covers a long history.
 * `MEMORY_EXPORT_ENTRY_MAX_BYTES` overrides it.
 */
export const DEFAULT_ENTRY_BYTES = 512 * 1024 * 1024;

function positiveBytes(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1024 * 1024) {
    throw new Error(`${name} must be an integer number of bytes, at least 1 MiB (got ${JSON.stringify(raw)})`);
  }
  return value;
}

export function exportByteLimit(): number {
  return positiveBytes('MEMORY_EXPORT_MAX_BYTES', DEFAULT_EXPORT_BYTES);
}

export function entryByteLimit(): number {
  return positiveBytes('MEMORY_EXPORT_ENTRY_MAX_BYTES', DEFAULT_ENTRY_BYTES);
}

export async function readBoundedFile(filePath: string, maxBytes = exportByteLimit()): Promise<Buffer> {
  let size = 0;
  try {
    const info = await stat(filePath);
    size = info.size;
    if (!info.isFile()) throw new MemoryError('VALIDATION_ERROR', 'Export path is not a file');
  } catch (error) {
    if (error instanceof MemoryError) throw error;
    throw new MemoryError('VALIDATION_ERROR', 'Cannot read export', error instanceof Error ? error.message : String(error));
  }
  if (size > maxBytes) throw new MemoryError('VALIDATION_ERROR', `Export is too large (limit ${maxBytes} bytes)`);
  const buffer = await readFile(filePath);
  if (buffer.length > maxBytes) throw new MemoryError('VALIDATION_ERROR', `Export is too large (limit ${maxBytes} bytes)`);
  return buffer;
}
