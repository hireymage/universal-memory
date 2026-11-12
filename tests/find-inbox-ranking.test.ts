import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { getEncoding } from 'js-tiktoken';
import { compose } from '../src/composition.js';
import { addDays } from '../src/domain/find-query.js';
import { todayInPrague } from '../src/domain/name-days.js';
import { createMemoryMcpServer } from '../src/transports/mcp/server.js';
import type { AppConfig } from '../src/config/schema.js';
import type { Services } from '../src/composition.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

const routing = {
  memory: { backend: 'markdown', path: 'Memory/{slug}.md' },
  note: { backend: 'markdown', path: '04 Knowledge/{slug}.md' },
  inbox: { backend: 'markdown', path: '00 Inbox/{date}-{slug}.md' },
  task: { backend: 'markdown', path: '11 Tasks/{slug}.md' },
  event: { backend: 'markdown', path: '14 Events/{date}-{slug}.md' },
  person: { backend: 'markdown', path: 'People/{slug}.md' },
  project: { backend: 'markdown', path: '02 Projects/{slug}/index.md' },
  project_decision: { backend: 'markdown', path: '02 Projects/{project_slug}/decisions/{date}-{slug}.md' },
};

async function setup(extra: Partial<AppConfig> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'find-inbox-'));
  roots.push(root);
  const vault = path.join(root, 'vault');
  await mkdir(vault, { recursive: true });
  const config: AppConfig = {
    name: 'Find', vault_root: vault, read_only: false, audit_dir: path.join(root, 'state', 'audit'),
    transport: 'stdio', http: { bind: '127.0.0.1', port: 3333, allowed_origins: [], bearer_token_env: 'TEST_TOKEN' },
    routing, ...extra,
  };
  const services = await compose(config);
  return { root, vault, services };
}

async function connect(services: Services): Promise<Client> {
  const server = createMemoryMcpServer(services);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'find-test', version: '0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(clientTransport);
  return client;
}

function data<T>(result: { structuredContent?: unknown; isError?: boolean }): T {
  expect(result.isError).not.toBe(true);
  return (result.structuredContent as { data: T }).data;
}

describe('find', () => {
  it('merges accent-insensitive filters and returns a compact hit', async () => {
    const { services } = await setup();
    const today = todayInPrague();
    const near = addDays(today, 2);
    const far = addDays(today, 40);
    const past = addDays(today, -3);
    await services.memory.createWithDedup({
      type: 'task', title: 'Koupit mléko', content: 'Zavolat Novákové a koupit mléko v obchodě na rohu.',
      metadata: { due: near, tags: ['Práce'] },
    });
    await services.memory.createWithDedup({
      type: 'task', title: 'Daleký úkol', content: 'Tento úkol má termín až za dlouho a není na tento týden.',
      metadata: { due: far, tags: ['domov'] },
    });
    await services.memory.createWithDedup({
      type: 'task', title: 'Po termínu', content: 'Tento úkol už měl být hotový a je po termínu několik dní.',
      metadata: { due: past },
    });
    await services.memory.createWithDedup({ type: 'person', title: 'Jan Novák', content: 'Soused z domu naproti, má rád kávu a dlouhé rozhovory.' });
    await services.memory.createWithDedup({ type: 'person', title: 'Janově', content: 'Obec, která se nesmí splést s osobou Jan jen proto, že název obsahuje stejná písmena.' });
    await services.memory.createWithDedup({ type: 'note', title: 'Hovor', content: 'Domluveno s [[Jan Novák]] na pátek odpoledne v kanceláři.' });
    await services.memory.createWithDedup({ type: 'note', title: 'Kafka', content: 'Poznámka o clusteru, která nemá termín ani značku práce.' });
    await services.memory.create({
      type: 'note', title: 'Stará', content: 'Stará poznámka mimo okno od.',
      metadata: { updated_at: '2020-01-01T00:00:00.000Z', created_at: '2020-01-01T00:00:00.000Z' },
    });

    const client = await connect(services);
    const byAlias = data<{ hits: Array<Record<string, unknown>>; parsed: { types: string[] } }>(
      await client.callTool({ name: 'find', arguments: { query: 'typ:úkol' } }),
    );
    expect(byAlias.parsed.types).toEqual(['task']);
    expect(byAlias.hits.map(hit => hit.title).sort()).toEqual(['Daleký úkol', 'Koupit mléko', 'Po termínu']);
    const byEnglish = data<{ hits: Array<{ id: string }> }>(await client.callTool({ name: 'find', arguments: { query: 'type:task' } }));
    expect(byEnglish.hits.map(hit => hit.id).sort()).toEqual(byAlias.hits.map(hit => hit.id).sort());

    const tagged = data<{ hits: Array<{ title: string }> }>(await client.callTool({ name: 'find', arguments: { query: '#prace' } }));
    expect(tagged.hits.map(hit => hit.title)).toEqual(['Koupit mléko']);

    const person = data<{ hits: Array<{ title: string; type: string }> }>(await client.callTool({ name: 'find', arguments: { query: 'osoba:Novak' } }));
    expect(person.hits.map(hit => hit.title).sort()).toEqual(['Hovor', 'Jan Novák']);
    const firstName = data<{ hits: Array<{ title: string }> }>(await client.callTool({ name: 'find', arguments: { query: 'osoba:Jan' } }));
    expect(firstName.hits.map(hit => hit.title)).not.toContain('Janově');
    expect(firstName.hits.map(hit => hit.title)).toContain('Jan Novák');

    const week = data<{ hits: Array<{ title: string }> }>(await client.callTool({ name: 'find', arguments: { query: 'do:týden' } }));
    expect(week.hits.map(hit => hit.title)).toEqual(['Koupit mléko']);

    const since = data<{ hits: Array<{ title: string }> }>(await client.callTool({ name: 'find', arguments: { query: 'od:week Stará' } }));
    expect(since.hits.map(hit => hit.title)).not.toContain('Stará');

    const ordered = data<{ hits: Array<{ title: string; overdue?: true }> }>(
      await client.callTool({ name: 'find', arguments: { query: 'typ:ukol', order: 'due' } }),
    );
    expect(ordered.hits.map(hit => hit.title)).toEqual(['Koupit mléko', 'Daleký úkol', 'Po termínu']);
    expect(ordered.hits[2]?.overdue).toBe(true);
    expect(ordered.hits[0]?.overdue).toBeUndefined();

    const compact = ordered.hits[0]!;
    expect(Object.keys(compact).sort()).toEqual(['id', 'path', 'reason', 'score', 'snippet', 'title', 'type']);
    expect(JSON.stringify(compact)).not.toContain('revision');

    const detailed = data<{ hits: Array<Record<string, unknown>> }>(
      await client.callTool({ name: 'find', arguments: { query: 'typ:ukol', detail: true, limit: 1 } }),
    );
    expect(detailed.hits[0]).toEqual(expect.objectContaining({ revision: expect.any(String), scores: expect.any(Object) }));

    const archived = await services.memory.createWithDedup({
      type: 'task', title: 'Archivovaný úkol', content: 'Koupit archiv, který se nemá vracet ani s textem ani bez něj.',
      metadata: { due: near },
    });
    await services.memory.archive(archived.entity.metadata.id, archived.entity.revision);
    const withoutText = data<{ hits: Array<{ title: string }> }>(await client.callTool({ name: 'find', arguments: { query: 'typ:úkol' } }));
    const withText = data<{ hits: Array<{ title: string }> }>(await client.callTool({ name: 'find', arguments: { query: 'typ:úkol koupit' } }));
    expect(withoutText.hits.map(hit => hit.title)).not.toContain('Archivovaný úkol');
    expect(withText.hits.map(hit => hit.title)).not.toContain('Archivovaný úkol');

    const unknown = data<{ hits: unknown[]; warnings?: Array<{ code: string }> }>(
      await client.callTool({ name: 'find', arguments: { query: 'typ:úkoly' } }),
    );
    expect(unknown.hits).toEqual([]);
    expect(unknown.warnings?.[0]?.code).toBe('UNKNOWN_TYPE');
    const blank = await client.callTool({ name: 'find', arguments: { query: '   ' } });
    expect(blank.isError).toBe(true);
    await client.close();
  });

  it('keeps ten compact hits under 1500 tokens and shrinks search_memory unless verbose', async () => {
    const { services } = await setup();
    const sentence = 'Společná věta o paměti. '.repeat(40);
    for (let index = 0; index < 10; index += 1) {
      await services.memory.create({
        type: 'note',
        title: `Paměť ${index}`,
        content: `${sentence}Položka ${index} obsahuje slovo paměť uprostřed dlouhého textu.`,
      });
    }
    const client = await connect(services);
    const found = data<{ hits: unknown[] }>(await client.callTool({ name: 'find', arguments: { query: 'paměť', limit: 10 } }));
    expect(found.hits).toHaveLength(10);
    const encoding = getEncoding('o200k_base');
    const tokens = encoding.encode(JSON.stringify(found.hits)).length;
    expect(tokens).toBeLessThan(1500);

    const quiet = data<{ lexical: Array<{ snippet: string; revision?: string }> }>(
      await client.callTool({ name: 'search_memory', arguments: { query: 'paměť', limit: 10 } }),
    );
    const loud = data<{ lexical: Array<{ snippet: string }>; neural: { note?: string } | null }>(
      await client.callTool({ name: 'search_memory', arguments: { query: 'paměť', limit: 10, verbose: true } }),
    );
    expect(quiet.lexical[0]!.snippet.length).toBeLessThanOrEqual(140);
    expect(loud.lexical[0]!.snippet.length).toBeGreaterThan(quiet.lexical[0]!.snippet.length);
    expect(quiet.lexical[0]).toHaveProperty('revision');
    const quietTokens = encoding.encode(JSON.stringify(quiet)).length;
    const loudTokens = encoding.encode(JSON.stringify(loud)).length;
    expect(quietTokens).toBeLessThan(loudTokens);
    await client.close();
  });
});

describe('find edge cases', () => {
  it('keeps a weakly matching upcoming task when ordering by due', async () => {
    const { services } = await setup();
    const tomorrow = addDays(todayInPrague(), 1);
    for (let index = 0; index < 200; index += 1) {
      await services.memory.create({ type: 'note', title: `koupit ${index}`, content: 'Silná shoda v titulku, která by dřív obsadila celý limit 200.' });
    }
    await services.memory.create({
      type: 'task', title: 'Zítra', content: 'Slabší shoda: koupit je jen v textu, termín je zítra.',
      metadata: { due: tomorrow },
    });
    const client = await connect(services);
    const ordered = data<{ hits: Array<{ title: string; type: string }> }>(
      await client.callTool({ name: 'find', arguments: { query: 'koupit', order: 'due', limit: 5 } }),
    );
    expect(ordered.hits[0]).toMatchObject({ title: 'Zítra', type: 'task' });
    await client.close();
  });
});

describe('pre-write validation', () => {
  it('normalizes synonyms, reports warnings, and still writes', async () => {
    const { services, vault } = await setup();
    const person = await services.memory.createWithDedup({
      type: 'person',
      title: 'Eva Nováková',
      content: 'Krátké.',
      metadata: { narozeniny: '1980-05-02', svatek: '05-02', tags: ['Rodina', 'rodina'] },
    });
    expect(person.normalized).toEqual(expect.arrayContaining([
      { kind: 'key', from: 'narozeniny', to: 'birth_date' },
      { kind: 'key', from: 'svatek', to: 'name_day' },
      { kind: 'tag', from: 'Rodina', to: 'rodina' },
    ]));
    expect(person.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'SHORT_CONTENT', severity: 'warning' }),
    ]));
    const file = await readFile(path.join(vault, person.entity.path), 'utf8');
    expect(file).toContain('birth_date: 1980-05-02');
    expect(file).toContain('name_day: 05-02');
    expect(file).toContain('rodina');
    expect(file).not.toContain('narozeniny:');
    expect(file).not.toContain('svatek:');
    const audit = await services.audit.list(person.entity.metadata.id);
    expect(audit[0]?.details).toMatchObject({ normalized: expect.any(Array) });

    const task = await services.memory.createWithDedup({
      type: 'task', title: 'Odevzdat', content: 'Dostat text přes práh krátkého obsahu, ať varování není jen o délce.',
      metadata: { deadline: '2026-12-01' },
    });
    expect(task.entity.metadata.due).toBe('2026-12-01');
    expect(task.entity.metadata).not.toHaveProperty('deadline');

    const clash = await services.memory.createWithDedup({
      type: 'task', title: 'Dva termíny', content: 'Oba termíny musí ve souboru zůstat, protože se neshodují hodnotou.',
      metadata: { due: '2026-12-01', deadline: '2026-12-24' },
    });
    expect(clash.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'SYNONYM_CONFLICT', severity: 'warning' })]));
    const clashFile = await readFile(path.join(vault, clash.entity.path), 'utf8');
    expect(clashFile).toContain('due: 2026-12-01');
    expect(clashFile).toContain('deadline: 2026-12-24');

    const decision = await services.memory.createWithDedup({
      type: 'project_decision', title: 'Zvolit Postgres',
      content: 'Zdůvodnění je dost dlouhé na to, aby nepadalo do krátkého obsahu a testovalo povinné pole.',
      metadata: { project_slug: 'pamat', decided_at: 'zítra' },
    });
    expect(decision.entity.metadata.id).toBeTruthy();
    expect(decision.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'MISSING_FRONTMATTER', severity: 'error', field: 'project_id' }),
      expect.objectContaining({ code: 'INVALID_DATE', severity: 'error', field: 'decided_at' }),
    ]));

    const again = await services.memory.createWithDedup({
      type: 'person', title: 'Eva Nováková', content: 'Druhý zápis stejného jména, který má být označen jako pravděpodobný duplikát.',
    });
    expect(again.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'DUPLICATE_TITLE', severity: 'warning', candidate_id: person.entity.metadata.id }),
    ]));

    const updated = await services.memory.update(task.entity.metadata.id, {
      metadata: { deadline: '2026-12-02' },
    }, task.entity.revision);
    expect(updated.metadata.due).toBe('2026-12-02');
    expect(updated.normalized).toEqual(expect.arrayContaining([{ kind: 'key', from: 'deadline', to: 'due' }]));
    expect(updated.warnings).toEqual(expect.any(Array));
  });

  it('adds a vector duplicate warning when the sidecar reports a near neighbour', async () => {
    const { services } = await setup();
    const first = await services.memory.createWithDedup({
      type: 'note', title: 'Jedinečný název pro vektor', content: 'Dostatek textu, aby varování o krátkém obsahu nebylo jediné.',
    });
    const memory = services.memory as unknown as { vectors: (text: string) => Promise<Array<{ id: string; score: number }>> };
    memory.vectors = async () => [{ id: first.entity.metadata.id, score: 0.91 }];
    const second = await services.memory.createWithDedup({
      type: 'note', title: 'Zcela jiné téma o zahradě', content: 'Dostatek textu o zahradě, který se titulkem nepodobá první poznámce vůbec.',
    });
    expect(second.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'VECTOR_SIMILARITY', severity: 'warning', candidate_id: first.entity.metadata.id }),
    ]));
  });
});

describe('low-confidence inbox', () => {
  it('parks an unclear type and triages it through a dry-run changeset', async () => {
    const { services, vault } = await setup();
    const clear = await services.memory.createWithDedup({ type: 'note', title: 'Kafka clustering notes', content: 'Stabilní poznámka, která má jasný typ a nemá spadnout do schránky.' });
    expect(clear.entity.metadata.type).toBe('note');
    expect(clear.parked_in_inbox).toBeUndefined();

    const hinted = await services.memory.createWithDedup({ type: 'memory', title: 'Koupit mléko do pátku', content: 'Jasnější náznak úkolu, ale střední jistota má zůstat na typu, který volající poslal.' });
    expect(hinted.entity.metadata.type).toBe('memory');
    expect(hinted.classification?.confidence).toBe('medium');

    const parked = await services.memory.createWithDedup({ type: 'todo', title: 'Něco později', content: 'Neznámá routa, nízká jistota, má skončit ve schránce a ne v paměti.' });
    expect(parked.parked_in_inbox).toBe(true);
    expect(parked.entity.metadata.type).toBe('inbox');
    expect(parked.entity.metadata.suggested_type).toBe('task');
    expect(parked.entity.metadata.classification_confidence).toBe(0.3);
    expect(parked.entity.metadata.requested_type).toBe('todo');
    expect(parked.entity.path.startsWith('00 Inbox/')).toBe(true);

    const client = await connect(services);
    const listed = data<{ items: Array<{ id: string; suggested_type: string }>; changeset?: unknown }>(
      await client.callTool({ name: 'triage_inbox', arguments: {} }),
    );
    expect(listed.changeset).toBeUndefined();
    expect(listed.items.map(item => item.id)).toContain(parked.entity.metadata.id);
    expect(listed.items.find(item => item.id === parked.entity.metadata.id)?.suggested_type).toBe('task');

    const prepared = data<{ changeset: { id: string; status: string; operations: unknown[] } }>(await client.callTool({
      name: 'triage_inbox',
      arguments: { decisions: [{ id: parked.entity.metadata.id, expected_revision: parked.entity.revision, type: 'task' }] },
    }));
    expect(prepared.changeset.status).toBe('prepared');
    expect(await readFile(path.join(vault, parked.entity.path), 'utf8')).toContain('type: inbox');

    const applied = data<{ entities: string[] }>(await client.callTool({
      name: 'apply_changeset',
      arguments: { changeset_id: prepared.changeset.id },
    }));
    expect(applied.entities).toContain(parked.entity.metadata.id);
    const moved = await services.memory.get(parked.entity.metadata.id);
    expect(moved.metadata.type).toBe('task');
    expect(moved.metadata.status).toBe('processed');
    expect(moved.path.startsWith('11 Tasks/')).toBe(true);
    const events = await services.audit.list(parked.entity.metadata.id);
    expect(events.some(event => event.operation === 'update')).toBe(true);
    await client.close();
  });

  it('refuses to prepare a changeset for a stale revision and does not write', async () => {
    const { services, vault } = await setup();
    const parked = await services.memory.createWithDedup({ type: 'widget', title: 'Widget inventory', content: 'Nízká jistota bez nejbližšího typu pořád patří do schránky.' });
    expect(parked.entity.metadata.type).toBe('inbox');
    const before = await readFile(path.join(vault, parked.entity.path), 'utf8');
    await expect(services.memory.search({ types: ['inbox'] })).resolves.toHaveLength(1);
    const client = await connect(services);
    const result = await client.callTool({
      name: 'triage_inbox',
      arguments: { decisions: [{ id: parked.entity.metadata.id, expected_revision: 'stale', type: 'note' }] },
    });
    expect(result.isError).toBe(true);
    expect(await readFile(path.join(vault, parked.entity.path), 'utf8')).toBe(before);
    await client.close();
  });
});

describe('triage warnings', () => {
  it('rejects an unknown type and reports missing required fields on the dry-run changeset', async () => {
    const { services, vault } = await setup();
    const parked = await services.memory.createWithDedup({
      type: 'todo', title: 'Do schránky', content: 'Text je dost dlouhý na to, aby varování nebylo jen o krátkém obsahu položky.',
    });
    expect(parked.entity.metadata.type).toBe('inbox');
    const before = await readFile(path.join(vault, parked.entity.path), 'utf8');
    const client = await connect(services);
    const unknown = await client.callTool({
      name: 'triage_inbox',
      arguments: { decisions: [{ id: parked.entity.metadata.id, expected_revision: parked.entity.revision, type: 'neexistuje' }] },
    });
    expect(unknown.isError).toBe(true);
    expect(await readFile(path.join(vault, parked.entity.path), 'utf8')).toBe(before);

    const prepared = data<{
      warnings: Array<{ code: string; severity: string; field?: string }>;
      changeset: { diagnostics: Array<{ code: string; severity: string }>; operations: Array<{ patch?: { metadata?: { type?: string } } }> };
    }>(await client.callTool({
      name: 'triage_inbox',
      arguments: { decisions: [{ id: parked.entity.metadata.id, expected_revision: parked.entity.revision, type: 'úkol' }] },
    }));
    expect(prepared.changeset.operations[0]?.patch?.metadata?.type).toBe('task');
    expect(prepared.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'TYPE_ALIAS', severity: 'info' }),
      expect.objectContaining({ code: 'MISSING_FRONTMATTER', severity: 'warning', field: 'due' }),
    ]));
    expect(prepared.changeset.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'MISSING_FRONTMATTER', severity: 'warning' }),
    ]));
    expect(await readFile(path.join(vault, parked.entity.path), 'utf8')).toBe(before);

    const decision = await services.memory.createWithDedup({
      type: 'todo', title: 'Rozhodnutí bez projektu', content: 'Další položka schránky, která nemá project_id a nemá se tiše přepsat.',
    });
    const strict = data<{ warnings: Array<{ code: string; severity: string; field?: string }> }>(await client.callTool({
      name: 'triage_inbox',
      arguments: { decisions: [{ id: decision.entity.metadata.id, expected_revision: decision.entity.revision, type: 'project_decision' }] },
    }));
    expect(strict.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'MISSING_FRONTMATTER', severity: 'error', field: 'project_id' }),
    ]));
    await client.close();
  });

  it('returns a live inbox item when newer archived rows would fill the page', async () => {
    const { services } = await setup();
    const live = await services.memory.createWithDedup({
      type: 'todo', title: 'Živá položka', content: 'Tahle má zůstat ve výpisu, i když novější archiv zaplní stránku.',
    });
    for (let index = 0; index < 3; index += 1) {
      const archived = await services.memory.createWithDedup({
        type: 'todo', title: `Archiv ${index}`, content: 'Archivovaná schránka, která nesmí vytlačit živou položku z první stránky.',
      });
      await services.memory.archive(archived.entity.metadata.id, archived.entity.revision);
    }
    const client = await connect(services);
    const listed = data<{ items: Array<{ id: string }> }>(await client.callTool({ name: 'triage_inbox', arguments: { limit: 1 } }));
    expect(listed.items.map(item => item.id)).toContain(live.entity.metadata.id);
    await client.close();
  });
});

describe('usage tracking', () => {
  it('stores read counts beside the audit log, not in the vault', async () => {
    const { services, vault, root } = await setup({ ranking: { track_usage: true } });
    const created = await services.memory.create({ type: 'note', title: 'Čtená', content: 'Text, který se počítá jen při recall, ne v Markdownu.' });
    const client = await connect(services);
    await client.callTool({ name: 'recall', arguments: { id: created.metadata.id } });
    await client.callTool({ name: 'recall', arguments: { id: created.metadata.id } });
    const usage = JSON.parse(await readFile(path.join(root, 'state', 'audit', 'usage.json'), 'utf8')) as { counts: Record<string, number> };
    expect(usage.counts[created.metadata.id]).toBe(2);
    const vaultFiles = await readFile(path.join(vault, created.path), 'utf8');
    expect(vaultFiles).not.toContain('usage');
    await client.close();
  });
});
