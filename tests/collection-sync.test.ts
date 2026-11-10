import { describe, expect, it } from 'vitest';
import { upsertContents, syncCollectionIndexes, type SyncStorage } from '../src/domain/collection-sync.js';
import { MemoryError } from '../src/domain/errors.js';
import type { Entity } from '../src/domain/types.js';

const indexEntity = (content: string, revision = 'rev-1'): Entity => ({
  content,
  path: 'People/family/index.md',
  revision,
  wikilinks: [],
  metadata: {
    id: 'idx-1', type: 'folder_collection', title: 'Family', status: 'active',
    created_at: '', updated_at: '', aliases: [], tags: [], schema_version: 1,
  } as Entity['metadata'],
});

const personEntity = (path: string, title: string, memberOf?: string[]): Entity => ({
  content: '',
  path,
  revision: 'r',
  wikilinks: [],
  metadata: {
    id: 'ent-1', type: 'person', title, status: 'active', created_at: '', updated_at: '',
    aliases: [], tags: [], schema_version: 1,
    ...(memberOf ? { member_of_collections: memberOf } : {}),
  } as Entity['metadata'],
});

function storageFor(indexes: Record<string, Entity>, options?: { conflicts?: number }): SyncStorage & { calls: number; contentOf: (path: string) => string } {
  let conflictsLeft = options?.conflicts ?? 0;
  const state = { ...indexes };
  const wrapped: SyncStorage & { calls: number; contentOf: (path: string) => string } = {
    calls: 0,
    async getByPath(path: string) { return state[path]; },
    async update(id: string, patch: { content?: string }, _expectedRevision: string) {
      wrapped.calls++;
      if (conflictsLeft > 0) { conflictsLeft--; throw new MemoryError('CONFLICT', 'changed'); }
      const entity = Object.values(state).find((candidate) => candidate.metadata.id === id);
      if (!entity) throw new MemoryError('NOT_FOUND', 'index entity missing');
      const updated: Entity = { ...entity, content: patch.content ?? entity.content };
      state[entity.path] = updated;
      return updated;
    },
    contentOf: (path: string) => state[path]?.content ?? '',
  };
  return wrapped;
}

function storage(index: Entity, options?: { conflicts?: number }): SyncStorage & { calls: number; index: Entity } {
  let conflictsLeft = options?.conflicts ?? 0;
  const wrapped: SyncStorage & { calls: number; index: Entity } = {
    calls: 0,
    index,
    async getByPath(path: string) { return path === 'People/family/index.md' ? wrapped.index : undefined; },
    async update(_id: string, patch: { content?: string }, _expectedRevision: string) {
      wrapped.calls++;
      if (conflictsLeft > 0) { conflictsLeft--; throw new MemoryError('CONFLICT', 'changed'); }
      wrapped.index = { ...wrapped.index, content: patch.content ?? wrapped.index.content };
      return wrapped.index;
    },
  };
  return wrapped;
}

describe('collection-sync (step 8: folder index sync)', () => {
  it('appends exactly one link to the index Contents section', async () => {
    const index = indexEntity('# Family\n\n## Contents\n\n- [[People/jan-novak|Jan]]\n');
    const s = storage(index);
    await syncCollectionIndexes(s, personEntity('People/marie-novakova.md', 'Marie Nováková', ['People/family']));
    expect(s.calls).toBe(1);
    expect(s.index.content).toContain('- [[People/marie-novakova|Marie Nováková]]');
    expect((s.index.content.match(/marie-novakova/g) ?? []).length).toBe(1);
  });

  it('is idempotent — a present link adds nothing and writes nothing', async () => {
    const index = indexEntity('# Family\n\n## Contents\n\n- [[People/marie-novakova|Marie Nováková]]\n');
    const s = storage(index);
    await syncCollectionIndexes(s, personEntity('People/marie-novakova.md', 'Marie Nováková', ['People/family']));
    expect(s.calls).toBe(0);
  });

  it('creates a Contents section when the index lacks one', async () => {
    const index = indexEntity('# Family\n\nSome intro text.\n');
    const s = storage(index);
    await syncCollectionIndexes(s, personEntity('People/marie-novakova.md', 'Marie Nováková', ['People/family']));
    expect(s.index.content).toContain('## Contents');
    expect(s.index.content).toContain('- [[People/marie-novakova|Marie Nováková]]');
  });

  it('retries bounded on CONFLICT then succeeds', async () => {
    const index = indexEntity('# Family\n\n## Contents\n');
    const s = storage(index, { conflicts: 1 });
    await syncCollectionIndexes(s, personEntity('People/marie-novakova.md', 'Marie Nováková', ['People/family']));
    expect(s.calls).toBe(2); // 1 conflict + 1 success
    expect(s.index.content).toContain('marie-novakova');
  });

  it('is non-fatal — persistent conflict never throws', async () => {
    const index = indexEntity('# Family\n\n## Contents\n');
    const s = storage(index, { conflicts: 99 });
    await expect(syncCollectionIndexes(s, personEntity('People/marie-novakova.md', 'Marie Nováková', ['People/family']))).resolves.toBeUndefined();
  });

  it('path nesting rule fires for entities inside the collection directory', async () => {
    const devIndex: Entity = {
      content: '# Devices\n\n## Contents\n',
      path: '05 Systems/Devices/index.md',
      revision: 'rev-1',
      wikilinks: [],
      metadata: { id: 'idx-dev', type: 'folder_collection', title: 'Devices', status: 'active', created_at: '', updated_at: '', aliases: [], tags: [], schema_version: 1 } as Entity['metadata'],
    };
    const s = storage(devIndex);
    const dev = personEntity('05 Systems/Devices/x99.md', 'x99'); // nesting by path, no member_of
    // storage.getByPath must resolve both collection paths
    s.getByPath = async (p: string) => (p === '05 Systems/Devices/index.md' ? devIndex : undefined);
    await syncCollectionIndexes(s, dev);
    expect(s.index.content).toContain('- [[05 Systems/Devices/x99|x99]]');
  });

  it('never indexes itself and ignores missing collections', async () => {
    const index = indexEntity('# Family\n\n## Contents\n');
    const s = storage(index);
    await syncCollectionIndexes(s, personEntity('People/family/index.md', 'Family', ['People/family', 'Nobody/here']));
    expect(s.calls).toBe(0);
  });

  it('upsertContents replaces the empty-contents placeholder with the link and stays idempotent', () => {
    const original = '# Assets\n\n## Contents\n\n_No imported Markdown children._\n\n## Notes\n\nKeep this.\n';
    const first = upsertContents(original, 'Assets/descent-board-game', 'Descent board game');
    expect(first.changed).toBe(true);
    expect(first.content).toContain('- [[Assets/descent-board-game|Descent board game]]');
    expect(first.content).not.toContain('_No imported Markdown children._');
    expect(first.content).toContain('## Notes\n\nKeep this.');
    expect((first.content.match(/descent-board-game/g) ?? []).length).toBe(1);
    const second = upsertContents(first.content, 'Assets/descent-board-game', 'Descent board game');
    expect(second.changed).toBe(false);
    expect(second.content).toBe(first.content);
  });

  it('upsertContents appends to a Contents section that already has links', () => {
    const original = '# Family\n\n## Contents\n\n- [[People/jan-novak|Jan]]\n\n## Notes\n';
    const result = upsertContents(original, 'People/marie-novakova', 'Marie Nováková');
    expect(result.changed).toBe(true);
    expect(result.content).toContain('- [[People/jan-novak|Jan]]\n- [[People/marie-novakova|Marie Nováková]]\n\n## Notes\n');
    expect(upsertContents(result.content, 'People/marie-novakova', 'Marie Nováková').changed).toBe(false);
  });

  it('syncs entities directly inside a top-level collection directory (path-nesting regression)', async () => {
    const assetsIndex: Entity = {
      content: '# Assets\n\n## Contents\n\n_No imported Markdown children._\n',
      path: 'Assets/index.md',
      revision: 'rev-1',
      wikilinks: [],
      metadata: { id: 'idx-assets', type: 'folder_collection', title: 'Assets', status: 'active', created_at: '', updated_at: '', aliases: [], tags: [], schema_version: 1 } as Entity['metadata'],
    };
    const s = storageFor({ 'Assets/index.md': assetsIndex });
    await syncCollectionIndexes(s, personEntity('Assets/descent-board-game.md', 'Descent board game'));
    expect(s.calls).toBe(1);
    const content = s.contentOf('Assets/index.md');
    expect((content.match(/descent-board-game/g) ?? []).length).toBe(1);
    expect(content).not.toContain('_No imported Markdown children._');
  });

  it('syncs every ancestor collection directory, top-level included', async () => {
    const indexes: Record<string, Entity> = {
      '05 Systems/index.md': {
        content: '# Systems\n\n## Contents\n',
        path: '05 Systems/index.md',
        revision: 'rev-1',
        wikilinks: [],
        metadata: { id: 'idx-systems', type: 'folder_collection', title: 'Systems', status: 'active', created_at: '', updated_at: '', aliases: [], tags: [], schema_version: 1 } as Entity['metadata'],
      },
      '05 Systems/Devices/index.md': {
        content: '# Devices\n\n## Contents\n',
        path: '05 Systems/Devices/index.md',
        revision: 'rev-1',
        wikilinks: [],
        metadata: { id: 'idx-dev', type: 'folder_collection', title: 'Devices', status: 'active', created_at: '', updated_at: '', aliases: [], tags: [], schema_version: 1 } as Entity['metadata'],
      },
    };
    const s = storageFor(indexes);
    await syncCollectionIndexes(s, personEntity('05 Systems/Devices/Sub/x99.md', 'x99'));
    expect(s.calls).toBe(2);
    expect(s.contentOf('05 Systems/Devices/Sub/index.md')).toBe('');
    expect(s.contentOf('05 Systems/Devices/index.md')).toContain('- [[05 Systems/Devices/Sub/x99|x99]]');
    expect(s.contentOf('05 Systems/index.md')).toContain('- [[05 Systems/Devices/Sub/x99|x99]]');
  });

  it('does nothing for a root-level entity with no collection directory', async () => {
    const s = storageFor({ 'index.md': indexEntity('# Root\n\n## Contents\n') });
    await syncCollectionIndexes(s, personEntity('loose-note.md', 'Loose note'));
    expect(s.calls).toBe(0);
  });
});