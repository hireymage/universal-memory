import { extractZipEntry } from './chatgpt-export.js';
import { readBoundedFile } from './bounded-read.js';
import { MemoryError } from './errors.js';

/**
 * Reads a conversation export that is either a .zip archive (containing
 * `zipEntry`, e.g. conversations.json) or a plain JSON file, and returns the
 * top-level array of conversations. Shared by the ChatGPT and Claude importers.
 */
export async function readExportRoot(filePath: string, zipEntry: string): Promise<unknown[]> {
  const buffer = await readBoundedFile(filePath);
  let root: unknown;
  try {
    root = JSON.parse((filePath.toLowerCase().endsWith('.zip') ? extractZipEntry(buffer, zipEntry) : buffer).toString('utf8'));
  } catch (error) {
    if (error instanceof MemoryError) throw error;
    throw new MemoryError('VALIDATION_ERROR', `Invalid ${zipEntry} in export: ${filePath}`, error instanceof Error ? error.message : String(error));
  }
  if (!Array.isArray(root)) throw new MemoryError('VALIDATION_ERROR', `Export root must be an array of conversations: ${filePath}`);
  return root;
}
