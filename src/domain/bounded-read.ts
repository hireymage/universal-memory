import { readFile, stat } from 'node:fs/promises';
import { MemoryError } from './errors.js';

/** Whole export on disk. A zip bomb is rejected again after inflation. */
export const MAX_EXPORT_BYTES = 64 * 1024 * 1024;
/** One inflated conversations.json. */
export const MAX_ENTRY_BYTES = 32 * 1024 * 1024;

export async function readBoundedFile(filePath: string, maxBytes = MAX_EXPORT_BYTES): Promise<Buffer> {
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
