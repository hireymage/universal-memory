import type { Entity } from './types.js';
import { MemoryError } from './errors.js';
import { escapeRegExp, wikilinkAlias, wikilinkTarget } from './path-safety.js';

/**
 * Folder-collection index sync (Step 8).
 *
 * Membership rules (curator decision 2026-10-10):
 * (A) path nesting — the entity's vault-relative path lives under the index
 *     entity's own directory (`People/family/index.md` owns `People/family/…`).
 * (B) explicit metadata `member_of_collections: ["People/family", …]` — the
 *     creator pins membership at create time (needed where routes are flat,
 *     e.g. person → People/{slug}.md with the family index in a subdir).
 *
 * Behavior: idempotent (a link already present is never rewritten), bounded
 * retry on revision conflict, and strictly non-fatal — index-sync failure
 * must never fail the main create/update. Residual risks (accepted):
 * links are not removed on move/archive, and index writes bypass the audit
 * sink (they are view maintenance, not content mutations).
 */

const MAX_ATTEMPTS = 3;
const LINK_TARGET = (path: string): string => path.replace(/\.md$/, '');
// Emitted by scripts/create-folder-collections.mjs for collections with no children yet.
const EMPTY_CONTENTS_PLACEHOLDER = '_No imported Markdown children._';

export interface SyncStorage {
  getByPath(path: string): Promise<Entity | undefined>;
  update(id: string, patch: { content?: string }, expectedRevision: string): Promise<Entity>;
}

const contentsLinkRe = (target: string): RegExp =>
  new RegExp(`^-\\s*\\[\\[[^\\]|]*${escapeRegExp(target)}[^\\]|]*(\\|[^\\]]*)?\\]\\]\\s*$`, 'm');

export function upsertContents(current: string, target: string, display: string): { content: string; changed: boolean } {
  const safeTarget = wikilinkTarget(target);
  const safeDisplay = wikilinkAlias(display) || safeTarget;
  if (!safeTarget) return { content: current, changed: false };
  const link = `- [[${safeTarget}|${safeDisplay}]]`;
  if (contentsLinkRe(safeTarget).test(current)) return { content: current, changed: false };
  const heading = '## Contents';
  const at = current.indexOf(heading);
  if (at < 0) return { content: `${current.replace(/\s*$/, '\n')}\n\n${heading}\n\n${link}\n`, changed: true };
  const afterHeading = at + heading.length;
  const next = current.indexOf('\n#', afterHeading); // next top-level section, if any
  const sectionEnd = next < 0 ? current.length : next;
  const section = current.slice(afterHeading, sectionEnd);
  // A placeholder-only section is replaced by the first real member link, not kept beside it.
  const updated = section.trim() === EMPTY_CONTENTS_PLACEHOLDER
    ? `\n\n${link}\n`
    : `${section.replace(/\s*$/, '\n')}${link}\n`;
  return { content: `${current.slice(0, afterHeading)}${updated}${current.slice(sectionEnd)}`, changed: true };
}

async function appendToIndex(storage: SyncStorage, entity: Entity, collectionPath: string): Promise<void> {
  const indexPath = `${collectionPath}/index.md`;
  if (LINK_TARGET(entity.path) === LINK_TARGET(indexPath)) return; // never index itself
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const index = await storage.getByPath(indexPath);
    if (!index || index.metadata.type !== 'folder_collection' || index.metadata.status === 'archived') return;
    const { content, changed } = upsertContents(index.content, LINK_TARGET(entity.path), String(entity.metadata.title ?? entity.path));
    if (!changed) return;
    try {
      await storage.update(index.metadata.id, { content }, index.revision);
      return;
    } catch (error) {
      if (error instanceof MemoryError && error.code === 'CONFLICT' && attempt < MAX_ATTEMPTS - 1) continue;
      throw error; // non-fatal: caller wraps in try/catch
    }
  }
}

/** Best-effort sync; never throws. */
export async function syncCollectionIndexes(storage: SyncStorage, entity: Entity): Promise<void> {
  try {
    const metadata = entity.metadata as Record<string, unknown>;
    // (B) explicit membership
    const pinned = Array.isArray(metadata.member_of_collections) ? metadata.member_of_collections : [];
    for (const collection of pinned) {
      if (typeof collection === 'string' && collection.trim()) await appendToIndex(storage, entity, collection.trim().replace(/\/+$/, ''));
    }
    // (A) path nesting — every ancestor collection directory, top-level included
    const parts = entity.path.split('/').slice(0, -1); // drop filename
    while (parts.length > 0) { // root-level files have no collection directory
      await appendToIndex(storage, entity, parts.join('/'));
      parts.pop();
    }
  } catch {
    // Strictly non-fatal: view maintenance only.
  }
}