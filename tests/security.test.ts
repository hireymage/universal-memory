import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { deflateRawSync } from 'node:zlib';
import { compose } from '../src/composition.js';
import { createHttpApp } from '../src/transports/http/server.js';
import { extractZipEntry } from '../src/domain/chatgpt-export.js';
import { readBoundedFile } from '../src/domain/bounded-read.js';
import { relationBulletLine, removeRelationLines } from '../src/domain/model.js';
import { publicHttpError } from '../src/transports/http/guards.js';
import { MemoryError } from '../src/domain/errors.js';
import type { AppConfig } from '../src/config/schema.js';

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const routing: AppConfig['routing'] = {
  note: { backend: 'markdown', path: 'Notes/{slug}.md' },
  memory: { backend: 'markdown', path: 'Memory/{slug}.md' },
  folder_collection: { backend: 'markdown', path: '{collection_path}/index.md' },
};

async function setup(extra: Partial<AppConfig> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'memory-security-'));
  roots.push(root);
  const vault = path.join(root, 'vault');
  await mkdir(vault, { recursive: true });
  const config: AppConfig = {
    name: 'Security Test', vault_root: vault, read_only: false, audit_dir: path.join(root, 'audit'),
    transport: 'http', http: { bind: '127.0.0.1', port: 3333, allowed_origins: [], bearer_token_env: 'UNSET_SECURITY_TOKEN' },
    routing, ...extra,
  };
  return { root, vault, services: await compose(config), config };
}

function request(port: number, headers: Record<string, string>, method = 'GET', requestPath = '/healthz'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: requestPath, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('vault path confinement', () => {
  it('rejects parent segments, absolute paths, null bytes, and NFKC lookalikes', async () => {
    const { vault, services } = await setup();
    await expect(services.storage.getByPath('../secret.md')).rejects.toMatchObject({ code: 'PATH_ESCAPE' });
    await expect(services.storage.getByPath('/etc/passwd')).rejects.toMatchObject({ code: 'PATH_ESCAPE' });
    await expect(services.storage.getByPath('foo\0.md')).rejects.toMatchObject({ code: 'PATH_ESCAPE' });
    await writeFile(path.join(vault, 'plain.md'), 'not a directory');
    await expect(services.storage.getByPath('plain.md/nested')).rejects.toMatchObject({ code: 'PATH_ESCAPE' });
    await expect(services.memory.create({
      type: 'folder_collection', title: 'Escape', metadata: { collection_path: `ok/${'\uFF0E'.repeat(2)}/etc` },
    })).rejects.toMatchObject({ code: 'PATH_ESCAPE' });
  });

  it('does not read or write through a symlink inside the vault', async () => {
    const { root, vault, services } = await setup();
    const outside = path.join(root, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'secret.txt'), 'topsecret');
    await symlink(path.join(outside, 'secret.txt'), path.join(vault, 'secret.md'));
    await expect(services.storage.getByPath('secret.md')).rejects.toMatchObject({ code: 'PATH_ESCAPE' });
    await symlink(outside, path.join(vault, 'escape'));
    const note = await services.memory.create({ type: 'note', title: 'Stay inside' });
    await expect(services.memory.move(note.metadata.id, 'escape/out.md', note.revision)).rejects.toMatchObject({ code: 'PATH_ESCAPE' });
    await expect(readFile(path.join(outside, 'out.md'), 'utf8')).rejects.toThrow();
  });

  it('follows a vault symlink only when the operator opts in', async () => {
    const { root, vault, services } = await setup({ follow_symlinks: true });
    const outside = path.join(root, 'outside');
    await mkdir(outside);
    await symlink(outside, path.join(vault, 'escape'));
    const note = await services.memory.create({ type: 'note', title: 'Opt in' });
    const moved = await services.memory.move(note.metadata.id, 'escape/out.md', note.revision);
    expect(moved.path.replaceAll('\\', '/')).toBe('escape/out.md');
    expect(await readFile(path.join(outside, 'out.md'), 'utf8')).toContain('Opt in');
  });

  it('lets only one of two concurrent updates with the same revision win', async () => {
    const { services } = await setup();
    const note = await services.memory.create({ type: 'note', title: 'Race' });
    const results = await Promise.allSettled([
      services.memory.update(note.metadata.id, { content: 'one' }, note.revision),
      services.memory.update(note.metadata.id, { content: 'two' }, note.revision),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'CONFLICT' });
  });

  it('refuses changeset and audit ids that leave the state directory', async () => {
    const { services } = await setup();
    await expect(services.maintenance.apply('../../evil')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(services.audit.readSnapshot('../passwd', 'before')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('reports an alias bomb as a bad note instead of expanding it', async () => {
    const { vault, services } = await setup();
    const bomb = [
      '---',
      'id: &a ["x","x","x","x","x","x","x","x","x","x","x"]',
      'b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]',
      'c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b,*b,*b]',
      'd: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c,*c,*c]',
      'type: note',
      'title: bomb',
      'created_at: "2020-01-01T00:00:00.000Z"',
      'updated_at: "2020-01-01T00:00:00.000Z"',
      'schema_version: 1',
      '---',
      'body',
      '',
    ].join('\n');
    await writeFile(path.join(vault, 'bomb.md'), bomb);
    const started = Date.now();
    const files = await services.storage.inspectFiles();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(files[0]?.error).toBeTruthy();
    expect(files[0]?.entity).toBeUndefined();
  });
});

describe('link text and regular expressions', () => {
  it('does not let a title break out of a wikilink', () => {
    const line = relationBulletLine({ title: 'Hi]]\n\n- [[evil|x', path: 'Notes/n.md' }, 'rel-1');
    expect(line).not.toMatch(/\n/);
    expect(line).toContain('[[n|Hi');
    expect(line).toContain('<!-- rel:rel-1 -->');
  });

  it('keeps # in link targets so C# and Issue #12 still resolve', () => {
    const line = relationBulletLine({ title: 'Issue #12 plan', path: 'Notes/C#.md' }, 'rel-2');
    expect(line).toContain('[[C#|Issue #12 plan]]');
  });

  it('treats a hostile relation id as a literal marker', () => {
    const id = '(a+)+';
    const content = `${'a'.repeat(40)}\n- [[x]] <!-- rel:${id} -->\nkeep\n`;
    const started = Date.now();
    const result = removeRelationLines(content, id);
    expect(Date.now() - started).toBeLessThan(500);
    expect(result.removed).toBe(1);
    expect(result.content).toContain('keep');
    expect(result.content).not.toContain('rel:(a+)+');
  });
});

describe('export limits', () => {
  it('rejects a zip entry that inflates past the cap and a file past the read cap', async () => {
    const payload = Buffer.alloc(80_000, 0);
    const compressed = deflateRawSync(payload);
    const name = Buffer.from('conversations.json');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(payload.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(payload.length, 24);
    central.writeUInt16LE(name.length, 28);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(central.length + name.length, 12);
    eocd.writeUInt32LE(30 + name.length + compressed.length, 16);
    const zip = Buffer.concat([local, name, compressed, central, name, eocd]);
    expect(() => extractZipEntry(zip, 'conversations.json', 1024)).toThrow(MemoryError);
    expect(() => extractZipEntry(zip, '../conversations.json', 1024)).toThrow(MemoryError);
    const root = await mkdtemp(path.join(os.tmpdir(), 'memory-export-'));
    roots.push(root);
    const file = path.join(root, 'big.json');
    await writeFile(file, Buffer.alloc(64, 1));
    await expect(readBoundedFile(file, 16)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('HTTP guards', () => {
  it('hides internal errors and does not scan the vault for readiness', async () => {
    expect(publicHttpError(new Error('ENOENT: open /vault/secret.md'))).toEqual({ status: 500, code: 'INTERNAL_ERROR', message: 'Internal error' });
    expect(publicHttpError(Object.assign(new Error('request entity too large'), { status: 413 }))).toEqual({ status: 413, code: 'VALIDATION_ERROR', message: 'Request body is too large' });
    expect(publicHttpError(Object.assign(new SyntaxError('Unexpected token'), { statusCode: 400 }))).toEqual({ status: 400, code: 'VALIDATION_ERROR', message: 'Request body must be JSON' });
    const { root, config } = await setup();
    config.vault_root = path.join(root, 'missing-vault');
    const services = await compose(config);
    const server = await new Promise<Server>((resolve) => {
      const listening = createHttpApp(services).listen(0, '127.0.0.1', () => resolve(listening));
    });
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    const ready = await request(address.port, { host: `127.0.0.1:${address.port}` }, 'GET', '/readyz');
    expect(ready.status).toBe(503);
    expect(ready.body).not.toContain('missing-vault');
    expect(ready.body).toContain('Vault is not accessible');
  });

  it('rejects a foreign Host on loopback and a foreign Origin on a published bind', async () => {
    const { services } = await setup();
    const server = await new Promise<Server>((resolve) => {
      const listening = createHttpApp(services).listen(0, '127.0.0.1', () => resolve(listening));
    });
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    const evil = await request(address.port, { host: 'evil.example' });
    expect(evil.status).toBe(403);
    const local = await request(address.port, { host: `127.0.0.1:${address.port}` });
    expect(local.status).toBe(200);

    process.env.SECURITY_HTTP_TOKEN = 'secret';
    try {
      const { services: wide } = await setup({ http: { bind: '0.0.0.0', port: 3333, allowed_origins: [], bearer_token_env: 'SECURITY_HTTP_TOKEN' } });
      const wideServer = await new Promise<Server>((resolve) => {
        const listening = createHttpApp(wide).listen(0, '127.0.0.1', () => resolve(listening));
      });
      servers.push(wideServer);
      const wideAddress = wideServer.address();
      if (!wideAddress || typeof wideAddress === 'string') throw new Error('no port');
      const lanHost = `192.168.1.10:${wideAddress.port}`;
      expect((await request(wideAddress.port, { host: lanHost })).status).toBe(200);
      expect((await request(wideAddress.port, { host: lanHost, origin: 'http://evil.example' })).status).toBe(403);
      const named = await setup({ http: { bind: '0.0.0.0', port: 3333, allowed_origins: [], allowed_hosts: ['memory.local'], bearer_token_env: 'SECURITY_HTTP_TOKEN' } });
      const namedServer = await new Promise<Server>((resolve) => {
        const listening = createHttpApp(named.services).listen(0, '127.0.0.1', () => resolve(listening));
      });
      servers.push(namedServer);
      const namedAddress = namedServer.address();
      if (!namedAddress || typeof namedAddress === 'string') throw new Error('no port');
      expect((await request(namedAddress.port, { host: 'memory.local' })).status).toBe(200);
      expect((await request(namedAddress.port, { host: 'evil.example' })).status).toBe(403);
    } finally {
      delete process.env.SECURITY_HTTP_TOKEN;
    }
  });

  it('rate-limits expensive POST routes', async () => {
    const previous = process.env.MEMORY_HTTP_RATE_LIMIT;
    process.env.MEMORY_HTTP_RATE_LIMIT = '1';
    try {
      const { services } = await setup();
      const server = await new Promise<Server>((resolve) => {
        const listening = createHttpApp(services).listen(0, '127.0.0.1', () => resolve(listening));
      });
      servers.push(server);
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('no port');
      const headers = { host: `127.0.0.1:${address.port}`, 'content-length': '0' };
      expect((await request(address.port, headers, 'POST', '/api/v1/health/run')).status).toBe(200);
      const limited = await request(address.port, headers, 'POST', '/api/v1/reindex');
      expect(limited.status).toBe(429);
      expect(limited.body).toContain('RATE_LIMITED');
    } finally {
      if (previous === undefined) delete process.env.MEMORY_HTTP_RATE_LIMIT;
      else process.env.MEMORY_HTTP_RATE_LIMIT = previous;
    }
  });
});
