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
  /**
   * Follow symlinks inside the vault during reads and writes. Off by default:
   * a directory symlink would otherwise let a move or a routed create write
   * outside the vault. `MEMORY_ALLOW_SYMLINKS=1` opts back in.
   */
  follow_symlinks: z.boolean().optional(),
  audit_dir: z.string().default('./.state/audit'),
  /** MCP catalog. Default `full` keeps every current tool name. `MEMORY_TOOLSET` overrides this. */
  toolset: z.enum(['minimal', 'standard', 'full']).optional(),
  /**
   * Repeat the generic result envelope as each tool's `outputSchema`.
   * Off by default: the envelope is identical for every tool and dominates tools/list.
   * `MEMORY_OUTPUT_SCHEMA` overrides this.
   */
  advertise_output_schema: z.boolean().optional(),
  transport: z.enum(['stdio', 'http']).default('stdio'),
  http: z.object({
    bind: z.string().default('127.0.0.1'),
    port: z.number().int().min(1).max(65535).default(3333),
    allowed_origins: z.array(z.string()).default([]),
    /**
     * Extra Host / Origin names when the server is not bound to loopback.
     * Localhost is always included unless `MEMORY_HTTP_ALLOW_ANY_HOST=1`.
     */
    allowed_hosts: z.array(z.string()).optional(),
    bearer_token_env: z.string().default('MEMORY_API_TOKEN'),
  }).default({ bind: '127.0.0.1', port: 3333, allowed_origins: [], bearer_token_env: 'MEMORY_API_TOKEN' }),
  routing: z.record(z.string(), routeSchema),
  /**
   * Periodic vault self-check. Off by default. Reports and dry-run changesets
   * are written under audit_dir; the vault is not modified and changesets are
   * not applied. `MEMORY_HEALTH_INTERVAL_HOURS` overrides `interval_hours`.
   * The timer runs only for a long-lived HTTP `serve` process.
   */
  health: z.object({
    enabled: z.boolean().default(false),
    interval_hours: z.number().positive().max(8_760).default(24),
    startup_delay_s: z.number().int().min(0).max(86_400).default(60),
    max_changesets: z.number().int().min(0).max(100).default(5),
  }).optional(),
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
  const raw = YAML.parse(await readFile(absolute, 'utf8'), { maxAliasCount: 10, schema: 'core' }) as unknown;
  const parsed = configSchema.parse(raw);
  const base = path.dirname(absolute);
  return {
    ...parsed,
    vault_root: path.resolve(base, parsed.vault_root),
    audit_dir: path.resolve(base, parsed.audit_dir),
    follow_symlinks: resolveFollowSymlinks(parsed.follow_symlinks),
    toolset: resolveToolset(parsed.toolset),
    advertise_output_schema: resolveOutputSchemaFlag(parsed.advertise_output_schema),
    health: resolveHealth(parsed.health),
  };
}

export interface HealthConfig {
  enabled: boolean;
  interval_hours: number;
  startup_delay_s: number;
  max_changesets: number;
}

export const DEFAULT_HEALTH: HealthConfig = {
  enabled: false,
  interval_hours: 24,
  startup_delay_s: 60,
  max_changesets: 5,
};

/** File values win over the defaults. `MEMORY_HEALTH_INTERVAL_HOURS` overrides the interval only. */
export function resolveHealth(
  fromFile?: Partial<HealthConfig> | null,
  env: string | undefined = process.env.MEMORY_HEALTH_INTERVAL_HOURS,
): HealthConfig {
  const health: HealthConfig = { ...DEFAULT_HEALTH };
  if (fromFile) {
    if (fromFile.enabled !== undefined) health.enabled = fromFile.enabled;
    if (fromFile.interval_hours !== undefined) health.interval_hours = fromFile.interval_hours;
    if (fromFile.startup_delay_s !== undefined) health.startup_delay_s = fromFile.startup_delay_s;
    if (fromFile.max_changesets !== undefined) health.max_changesets = fromFile.max_changesets;
  }
  const override = env?.trim();
  if (!override) return health;
  const value = Number(override);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`MEMORY_HEALTH_INTERVAL_HOURS must be a positive number (got ${JSON.stringify(override)})`);
  }
  health.interval_hours = value;
  return health;
}

/** `MEMORY_ALLOW_SYMLINKS=1` follows vault symlinks. Unset keeps the file value, which defaults to false. */
export function resolveFollowSymlinks(fromFile?: boolean, env: string | undefined = process.env.MEMORY_ALLOW_SYMLINKS): boolean {
  const override = env?.trim().toLowerCase();
  if (!override) return fromFile ?? false;
  if (override === '1' || override === 'true' || override === 'yes' || override === 'on') return true;
  if (override === '0' || override === 'false' || override === 'no' || override === 'off') return false;
  throw new Error(`MEMORY_ALLOW_SYMLINKS must be true or false (got ${JSON.stringify(env)})`);
}

/** `MEMORY_OUTPUT_SCHEMA` overrides the file. Unset or blank keeps the file value (default false). */
export function resolveOutputSchemaFlag(fromFile: boolean | undefined, env: string | undefined = process.env.MEMORY_OUTPUT_SCHEMA): boolean {
  const override = env?.trim();
  if (!override) return fromFile ?? false;
  const normalized = override.toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
  throw new Error(`MEMORY_OUTPUT_SCHEMA must be true or false (got ${JSON.stringify(override)})`);
}