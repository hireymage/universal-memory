import path from 'node:path';
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { z } from 'zod';
import { resolveToolset } from '../transports/mcp/toolsets.js';

const routeSchema = z.object({ backend: z.string().default('markdown'), path: z.string().min(1) });
const configSchema = z.object({
  name: z.string().default('Universal Memory MCP'),
  vault_root: z.string(),
  read_only: z.boolean().default(true),
  audit_dir: z.string().default('./.state/audit'),
  /** MCP catalog. Default `full` keeps every current tool name. `MEMORY_TOOLSET` overrides this. */
  toolset: z.enum(['minimal', 'standard', 'full']).optional(),
  /**
   * Repeat the generic result envelope as each tool's `outputSchema`.
   * On by default so clients that validate tool output keep working.
   * Set false (or `MEMORY_OUTPUT_SCHEMA=false`) to drop it from tools/list.
   */
  advertise_output_schema: z.boolean().optional(),
  transport: z.enum(['stdio', 'http']).default('stdio'),
  http: z.object({
    bind: z.string().default('127.0.0.1'),
    port: z.number().int().min(1).max(65535).default(3333),
    allowed_origins: z.array(z.string()).default([]),
    bearer_token_env: z.string().default('MEMORY_API_TOKEN'),
  }).default({ bind: '127.0.0.1', port: 3333, allowed_origins: [], bearer_token_env: 'MEMORY_API_TOKEN' }),
  routing: z.record(z.string(), routeSchema),
  /**
   * Experimental BDH associative memory. Off unless `enabled` is true.
   * The sidecar is a disposable index outside the vault; Markdown stays the
   * source of truth whether or not this block is present.
   */
  neural: z.object({
    enabled: z.boolean().default(false),
    base_url: z.string().min(1).default('http://127.0.0.1:8091'),
    bearer_token_env: z.string().min(1).default('MEMORY_API_TOKEN'),
    timeout_ms: z.number().int().min(50).max(120_000).default(1500),
    /**
     * Drop vector hits at or below this cosine score. Default 0 keeps only
     * strictly positive similarities, so negative hits are not used to fill `limit`.
     * Sent to the sidecar as `min_score` and applied again when results are read.
     */
    vector_min_score: z.number().finite().optional(),
  }).optional(),
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
    toolset: resolveToolset(parsed.toolset),
    advertise_output_schema: resolveOutputSchemaFlag(parsed.advertise_output_schema),
  };
}

/** `MEMORY_OUTPUT_SCHEMA` overrides the file. Unset or blank keeps the file value (default true). */
export function resolveOutputSchemaFlag(fromFile: boolean | undefined, env: string | undefined = process.env.MEMORY_OUTPUT_SCHEMA): boolean {
  const override = env?.trim();
  if (!override) return fromFile ?? true;
  const normalized = override.toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
  throw new Error(`MEMORY_OUTPUT_SCHEMA must be true or false (got ${JSON.stringify(override)})`);
}