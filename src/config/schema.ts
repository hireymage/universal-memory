import path from 'node:path';
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { z } from 'zod';

const routeSchema = z.object({ backend: z.string().default('markdown'), path: z.string().min(1) });
const configSchema = z.object({
  name: z.string().default('Universal Memory MCP'),
  vault_root: z.string(),
  read_only: z.boolean().default(true),
  audit_dir: z.string().default('./.state/audit'),
  transport: z.enum(['stdio', 'http']).default('stdio'),
  http: z.object({
    bind: z.string().default('127.0.0.1'),
    port: z.number().int().min(1).max(65535).default(3333),
    allowed_origins: z.array(z.string()).default([]),
    bearer_token_env: z.string().default('MEMORY_API_TOKEN'),
  }).default({ bind: '127.0.0.1', port: 3333, allowed_origins: [], bearer_token_env: 'MEMORY_API_TOKEN' }),
  routing: z.record(z.string(), routeSchema),
});

export type AppConfig = z.infer<typeof configSchema>;

export async function loadConfig(file: string): Promise<AppConfig> {
  const absolute = path.resolve(file);
  const raw = YAML.parse(await readFile(absolute, 'utf8')) as unknown;
  const parsed = configSchema.parse(raw);
  const base = path.dirname(absolute);
  return {
    ...parsed,
    vault_root: path.resolve(base, parsed.vault_root),
    audit_dir: path.resolve(base, parsed.audit_dir),
  };
}