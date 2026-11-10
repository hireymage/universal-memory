import { afterEach, describe, expect, it } from 'vitest';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { compose } from '../src/composition.js';
import type { AppConfig } from '../src/config/schema.js';
import type { Services } from '../src/composition.js';
import type { Entity } from '../src/domain/types.js';

/**
 * Regression coverage for commit b58a55c: archived entities (merge stubs) stay
 * indexed, ID-addressable, auditable and restorable, but are invisible to
 * resolve_entity / alias-collision / date-window lookups unless the caller
 * explicitly opts in with include_archived / includeArchived.
 *
 * The fixture vault mirrors the real production state after merge_entities:
 * one canonical active person plus an archived stub with the identical title
 * (and, for Jan/Eva, the identical alias). Tests copy it into a temp
 * directory, so the fixture is never mutated.
 */
const FIXTURE_VAULT = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'vault');

const CANONICAL = {
  'Jan Novák': '01KZRAWNR9RYCRBNQ5WCJT6WY7',
  Honza: '01KZRAWNR9RYCRBNQ5WCJT6WY7',
  'Eva Nováková': '01KZRAWNQNAAC3DEAAKHEF5NNZ',
  'Eva Svobodová': '01KZRAWNQNAAC3DEAAKHEF5NNZ',
  'Anna Nováková': '01KZRAWNPPGZQDNHB307E44QZR',
  'Petr Novák': '01KZRAWNPGTCABNPENP5DNEQWQ',
  'Tomáš Novák': '01KZRAWNQFFDH6594AKZSJF0Y9',
} as const;

const ARCHIVED_STUB = {
  'Jan Novák': '01KZRTF9QT6G955FNJKMSJHG6A',
  Honza: '01KZRTF9QT6G955FNJKMSJHG6A',
  'Eva Nováková': '01KZRTF9RPCHGCFQAFS2XVRRS3',
  'Eva Svobodová': '01KZRTF9RPCHGCFQAFS2XVRRS3',
  'Anna Nováková': '01KZRVS3A315BVWQYC2Q9PYEW5',
  'Petr Novák': '01KZRVS399FS1CJQWDF5AWA80D',
  'Tomáš Novák': '01KZRVS38CW7DD8P7E7Z24JYYS',
} as const;

/** The seven queries that were ambiguous in production before the fix. */
const QUERIES = [
  'Jan Novák', 'Honza', 'Eva Nováková', 'Eva Svobodová',
  'Anna Nováková', 'Petr Novák', 'Tomáš Novák',
];

interface ResolveResult {
  query: string;
  include_archived: boolean;
  ambiguous: boolean;
  resolved?: { id: string; title: string; match: string };
  candidates: Array<{ id: string; title: string; match: string }>;
}

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function setup(readOnly = true): Promise<{ root: string; vault: string; services: Services }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'universal-memory-resolve-archived-'));
  roots.push(root);
  const vault = path.join(root, 'vault');
  await cp(FIXTURE_VAULT, vault, { recursive: true });
  const config: AppConfig = {
    name: 'Resolve Archived Test', vault_root: vault, read_only: readOnly,
    audit_dir: path.join(root, 'state', 'audit'), transport: 'stdio',
    http: { bind: '127.0.0.1', port: 3333, allowed_origins: [], bearer_token_env: 'TEST_TOKEN' },
    routing: {
      memory: { backend: 'markdown', path: '03 Knowledge/{slug}.md' },
      note: { backend: 'markdown', path: '03 Knowledge/{slug}.md' },
      person: { backend: 'markdown', path: 'People/{slug}.md' },
      project: { backend: 'markdown', path: '02 Projects/{slug}/index.md' },
      inbox: { backend: 'markdown', path: '01 Inbox/{date}-{slug}.md' },
      source: { backend: 'markdown', path: 'Sources/{provider}/{date}-{slug}.md' },
    },
  };
  const services = await compose(config);
  // Cold start: the disposable index is rebuilt from the Markdown vault.
  await services.maintenance.reindex();
  return { root, vault, services };
}

const ids = (entities: Entity[]): string[] => entities.map(entity => entity.metadata.id).sort();
const candidateIds = (result: ResolveResult): string[] => result.candidates.map(candidate => candidate.id).sort();
async function resolveIds(services: Services, query: string, includeArchived = false): Promise<string[]> {
  const result = await services.graph.resolve({ query, ...(includeArchived ? { include_archived: true } : {}) }) as ResolveResult;
  return candidateIds(result);
}

describe('resolve_entity: archived entities are hidden by default', () => {
  it('resolves the seven production queries to exactly one active canonical person', async () => {
    const { services } = await setup();
    for (const query of QUERIES) {
      const result = await services.graph.resolve({ query }) as ResolveResult;
      expect(result.include_archived, query).toBe(false);
      expect(result.ambiguous, query).toBe(false);
      expect(result.candidates, query).toHaveLength(1);
      expect(result.resolved?.id, query).toBe(CANONICAL[query as keyof typeof CANONICAL]);
      const entity = await services.memory.get(result.resolved!.id);
      expect(entity.metadata.status, query).toBe('active');
    }
  });

  it('never leaks an archived stub into the default candidate list', async () => {
    const { services } = await setup();
    for (const query of QUERIES) {
      const result = await services.graph.resolve({ query }) as ResolveResult;
      for (const stubId of Object.values(ARCHIVED_STUB)) {
        expect(candidateIds(result).includes(stubId), `${query} -> ${stubId}`).toBe(false);
      }
    }
  });

  it('include_archived: true surfaces the archived stub and makes the query ambiguous', async () => {
    const { services } = await setup();
    for (const query of QUERIES) {
      const result = await services.graph.resolve({ query, include_archived: true }) as ResolveResult;
      expect(result.include_archived, query).toBe(true);
      expect(result.ambiguous, query).toBe(true);
      expect(result.resolved, query).toBeUndefined();
      expect(candidateIds(result), query).toEqual(
        [CANONICAL[query as keyof typeof CANONICAL], ARCHIVED_STUB[query as keyof typeof ARCHIVED_STUB]].sort(),
      );
      const statuses = await Promise.all(result.candidates.map(candidate => services.memory.get(candidate.id).then(e => e.metadata.status)));
      expect(statuses.sort(), query).toEqual(['active', 'archived']);
    }
  });

  it('an archived entity is not resolvable by its stable ID by default, but is with the opt-in', async () => {
    const { services } = await setup();
    const stubId = ARCHIVED_STUB['Jan Novák'];
    const hidden = await services.graph.resolve({ query: stubId }) as ResolveResult;
    expect(hidden.ambiguous).toBe(false);
    expect(hidden.candidates).toEqual([]);
    expect(hidden.resolved).toBeUndefined();

    const shown = await services.graph.resolve({ query: stubId, include_archived: true }) as ResolveResult;
    expect(shown.candidates).toHaveLength(1);
    expect(shown.candidates[0]).toMatchObject({ id: stubId, match: 'id' });

    // Active entities keep their ID-addressability in resolve as well.
    const active = await services.graph.resolve({ query: CANONICAL['Tomáš Novák'] }) as ResolveResult;
    expect(active.resolved).toMatchObject({ id: CANONICAL['Tomáš Novák'], match: 'id' });
  });

  it('keeps archived entities addressable through storage and memory get', async () => {
    const { services } = await setup();
    for (const stubId of Object.values(ARCHIVED_STUB)) {
      const fromMemory = await services.memory.get(stubId);
      const fromStorage = await services.storage.get(stubId);
      expect(fromMemory.metadata.status).toBe('archived');
      expect(fromStorage?.metadata.id).toBe(stubId);
      expect(fromMemory.metadata.title).toBe(fromStorage?.metadata.title);
    }
  });

  it('preserves search behaviour for archived entities (no unintended hiding)', async () => {
    const { services } = await setup();
    const both = await services.memory.search({ query: 'Petr', limit: 20 });
    expect(ids(both)).toEqual([ARCHIVED_STUB['Petr Novák'], CANONICAL['Petr Novák']].sort());
    const titleSearch = await services.memory.search({ query: 'Petr Novák', limit: 20 });
    expect(titleSearch.map(entity => entity.metadata.id)).toContain(ARCHIVED_STUB['Petr Novák']);
    const archivedIds = [...new Set(Object.values(ARCHIVED_STUB))].sort();
    const activeIds = [...new Set(Object.values(CANONICAL))].sort();
    const archivedOnly = await services.memory.search({ types: ['person'], status: 'archived', limit: 50 });
    expect(ids(archivedOnly)).toEqual(archivedIds);
    const activeOnly = await services.memory.search({ types: ['person'], status: 'active', limit: 50 });
    expect(ids(activeOnly)).toEqual(activeIds);
    const context = await services.memory.retrieveContext({ query: 'Eva Nováková', limit: 10 });
    expect(context.matches.map(entity => entity.metadata.id)).toContain(ARCHIVED_STUB['Eva Nováková']);
  });

  it('aliasCollisions() excludes archived claimants by default and includes them on opt-in', async () => {
    const { services } = await setup();
    const defaultCollisions = await services.index.aliasCollisions();
    const withArchived = await services.index.aliasCollisions({ includeArchived: true });
    const janPair = [CANONICAL['Jan Novák'], ARCHIVED_STUB['Jan Novák']].sort();
    const hidden = defaultCollisions.find(collision => collision.entity_ids.length > 1);
    expect(hidden).toBeUndefined();
    const janCollision = withArchived.find(collision => collision.form === 'normalized' && collision.key === 'jan novak');
    expect(janCollision).toBeDefined();
    expect(janCollision!.entity_ids.sort()).toEqual(janPair);
    expect(defaultCollisions.length).toBe(0);
    expect(withArchived.length).toBeGreaterThan(0);
  });

  it('dateWindow/find_birthdays excludes archived people by default and includes them on opt-in', async () => {
    const { services } = await setup();
    const window = { from: '2026-01-06', to: '2026-01-10' };
    const birthdays = await services.people.birthdays(window.from, window.to);
    expect(ids(birthdays)).toEqual([CANONICAL['Petr Novák'], CANONICAL['Anna Nováková']].sort());
    const withArchived = await services.index.dateWindow('birth_date', window.from, window.to, { includeArchived: true });
    expect(ids(withArchived)).toEqual(
      [CANONICAL['Petr Novák'], CANONICAL['Anna Nováková'], ARCHIVED_STUB['Petr Novák'], ARCHIVED_STUB['Anna Nováková']].sort(),
    );
    const nameDays = await services.people.nameDays('2026-05-20', '2026-05-22');
    expect(ids(nameDays)).toEqual([CANONICAL['Anna Nováková']]);
    const nameDaysWithArchived = await services.index.dateWindow('name_day', '2026-05-20', '2026-05-22', { includeArchived: true });
    expect(ids(nameDaysWithArchived)).toEqual([CANONICAL['Anna Nováková'], ARCHIVED_STUB['Anna Nováková']].sort());
  });
});

describe('write path, rebuild path and restore agree', () => {
  it('archive() hides the entity from resolution exactly like a vault archived at rest', async () => {
    const { services } = await setup(false);
    const created = await services.memory.create({ type: 'person', title: 'Karel Novák', content: 'Brother', metadata: { aliases: ['Karel Novák'] } });
    const before = await services.graph.resolve({ query: 'Karel Novák' }) as ResolveResult;
    expect(before.ambiguous).toBe(false);
    expect(before.resolved?.id).toBe(created.metadata.id);

    const archived = await services.memory.archive(created.metadata.id, created.revision, 'test:archive');
    expect(archived.metadata.status).toBe('archived');

    const afterArchive = await services.graph.resolve({ query: 'Karel Novák' }) as ResolveResult;
    expect(afterArchive.ambiguous).toBe(false);
    expect(afterArchive.candidates).toEqual([]);
    expect(afterArchive.resolved).toBeUndefined();
    const optIn = await services.graph.resolve({ query: 'Karel Novák', include_archived: true }) as ResolveResult;
    expect(candidateIds(optIn)).toEqual([created.metadata.id]);

    // Rebuild path (cold start / restart) must produce the identical result.
    await services.maintenance.reindex();
    const rebuilt = await services.graph.resolve({ query: 'Karel Novák' }) as ResolveResult;
    const rebuiltOptIn = await services.graph.resolve({ query: 'Karel Novák', include_archived: true }) as ResolveResult;
    expect(candidateIds(rebuilt)).toEqual(candidateIds(afterArchive));
    expect(candidateIds(rebuiltOptIn)).toEqual(candidateIds(optIn));
    expect(rebuilt.candidates).toEqual(afterArchive.candidates);
    expect(rebuiltOptIn.candidates.map(c => c.match)).toEqual(optIn.candidates.map(c => c.match));
  });

  it('a fresh index built from storage.scan() reproduces the fixture behaviour (restart simulation)', async () => {
    const { vault, services } = await setup();
    const cold = await Promise.all(QUERIES.map(query => resolveIds(services, query)));
    const coldOptIn = await Promise.all(QUERIES.map(query => resolveIds(services, query, true)));

    await services.maintenance.reindex();
    const restartedServices = await compose({
      name: 'Restarted', vault_root: vault, read_only: true,
      audit_dir: path.join(os.tmpdir(), 'unused-audit'), transport: 'stdio',
      http: { bind: '127.0.0.1', port: 3334, allowed_origins: [], bearer_token_env: 'TEST_TOKEN' },
      routing: {
        memory: { backend: 'markdown', path: '03 Knowledge/{slug}.md' },
        note: { backend: 'markdown', path: '03 Knowledge/{slug}.md' },
        person: { backend: 'markdown', path: 'People/{slug}.md' },
        project: { backend: 'markdown', path: '02 Projects/{slug}/index.md' },
        inbox: { backend: 'markdown', path: '01 Inbox/{date}-{slug}.md' },
        source: { backend: 'markdown', path: 'Sources/{provider}/{date}-{slug}.md' },
      },
    });
    await restartedServices.maintenance.reindex();
    const warm = await Promise.all(QUERIES.map(query => resolveIds(restartedServices, query)));
    const warmOptIn = await Promise.all(QUERIES.map(query => resolveIds(restartedServices, query, true)));
    expect(warm).toEqual(cold);
    expect(warmOptIn).toEqual(coldOptIn);
    expect(warm.every(list => list.length === 1)).toBe(true);
    expect(warmOptIn.every(list => list.length === 2)).toBe(true);
  });

  it('restore() makes an archived entity a resolution candidate again', async () => {
    const { services } = await setup(false);
    const person = await services.memory.create({ type: 'person', title: 'Renata Nováková', content: 'Sister' });
    const archived = await services.memory.archive(person.metadata.id, person.revision, 'test:archive');
    expect((await services.graph.resolve({ query: 'Renata Nováková' }) as ResolveResult).candidates).toEqual([]);

    const events = await services.maintenance.history(archived.metadata.id);
    const archiveEvent = events.find(event => event.operation === 'archive');
    expect(archiveEvent).toBeDefined();
    const rollback = await services.maintenance.prepareRollback(archiveEvent!.id);
    await services.maintenance.apply(rollback.id, 'test:restore');

    const restored = await services.memory.get(archived.metadata.id);
    expect(restored.metadata.status).toBe('active');
    const result = await services.graph.resolve({ query: 'Renata Nováková' }) as ResolveResult;
    expect(result.ambiguous).toBe(false);
    expect(result.resolved?.id).toBe(archived.metadata.id);
    expect((await services.index.aliasCollisions()).length).toBe(0);
  });

  it('audit history for an archive event lists the event and its before/after snapshots', async () => {
    const { services } = await setup(false);
    const stubId = ARCHIVED_STUB['Tomáš Novák'];
    const stub = await services.memory.get(stubId);
    const reArchived = await services.memory.archive(stubId, stub.revision, 'test:rearchive');
    const events = await services.maintenance.history(stubId);
    const archiveEvent = events.find(event => event.operation === 'archive');
    expect(archiveEvent).toBeDefined();
    expect(archiveEvent!.entity_id).toBe(stubId);
    expect(archiveEvent!.before_snapshot).toBeTruthy();
    expect(archiveEvent!.after_snapshot).toBeTruthy();
    const before = await services.audit.readSnapshot(archiveEvent!.id, 'before');
    const after = await services.audit.readSnapshot(archiveEvent!.id, 'after');
    expect(before?.metadata.id).toBe(stubId);
    expect(after?.metadata.status).toBe(reArchived.metadata.status);
    expect(after?.metadata.archived_at).toBeTruthy();
    // The archived stub is still invisible to resolution but visible to search.
    expect((await services.graph.resolve({ query: 'Tomáš Novák' }) as ResolveResult).resolved?.id).toBe(CANONICAL['Tomáš Novák']);
    expect((await services.graph.resolve({ query: 'Tomáš Novák', include_archived: true }) as ResolveResult).ambiguous).toBe(true);
  });
});
