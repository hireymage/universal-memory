import path from 'node:path';
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { z } from 'zod';
import { DEFAULT_INBOX_CONFIDENCE_THRESHOLD } from '../domain/inbox-policy.js';
import { DEFAULT_RANKING, type RankingConfig } from '../domain/ranking.js';
import { resolveDiscovery, resolveToolset } from '../transports/mcp/toolsets.js';

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
  /** MCP catalog. Default `full` keeps every tool name. `MEMORY_TOOLSET` overrides this. */
  toolset: z.enum(['minimal', 'standard', 'full']).optional(),
  /**
   * `eager` (default) lists every tool in the toolset. `lazy` lists the standard
   * tools when toolset is `full`, and `tool_groups` can enable the rest for a
   * long-lived session. `MEMORY_TOOL_DISCOVERY` overrides this.
   */
  tool_discovery: z.enum(['lazy', 'eager']).optional(),
  /**
   * Advertise the previous, larger JSON Schema (oneOf branches, defaults,
   * additionalProperties, minLength). Off by default. `MEMORY_VERBOSE_SCHEMA` overrides this.
   */
  verbose_schema: z.boolean().optional(),
  /**
   * `compact` (default) drops nulls and empty strings, echoed inputs, and full
   * frontmatter, keeps list keys and revisions, and returns JSON once as text.
   * `full` restores the previous envelope, entity bodies, and structuredContent.
   * `MEMORY_RESPONSE` overrides this.
   */
  response: z.enum(['compact', 'full']).optional(),
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
   * Creates whose advisory classification scores below this threshold are
   * stored as inbox. Default 0.5 parks only `low` (0.3). `medium` (0.6) and
   * a confident create (1) keep the caller's type.
   * `MEMORY_INBOX_CONFIDENCE_THRESHOLD` overrides the file.
   */
  classification: z.object({
    inbox_confidence_threshold: z.number().min(0).max(1).optional(),
  }).optional(),
  /**
   * Result ranking. Usage counts, when enabled, are stored under audit_dir
   * and never in Markdown. Weights do not have to sum to 1.
   */
  ranking: z.object({
    track_usage: z.boolean().optional(),
    half_life_days: z.number().positive().max(3_650).optional(),
    weights: z.object({
      match: z.number().min(0).max(100).optional(),
      recency: z.number().min(0).max(100).optional(),
      links: z.number().min(0).max(100).optional(),
      usage: z.number().min(0).max(100).optional(),
    }).optional(),
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
    tool_discovery: resolveDiscovery(parsed.tool_discovery),
    verbose_schema: resolveFlag('MEMORY_VERBOSE_SCHEMA', parsed.verbose_schema),
    response: resolveResponse(parsed.response),
    advertise_output_schema: resolveOutputSchemaFlag(parsed.advertise_output_schema),
    health: resolveHealth(parsed.health),
    classification: resolveClassification(parsed.classification),
    ranking: resolveRanking(parsed.ranking),
  };
}

export interface ClassificationConfig {
  inbox_confidence_threshold: number;
}

/** File value, then `MEMORY_INBOX_CONFIDENCE_THRESHOLD`. Default parks only low confidence. */
export function resolveClassification(
  fromFile?: { inbox_confidence_threshold?: number } | null,
  env: string | undefined = process.env.MEMORY_INBOX_CONFIDENCE_THRESHOLD,
): ClassificationConfig {
  let inbox_confidence_threshold = fromFile?.inbox_confidence_threshold ?? DEFAULT_INBOX_CONFIDENCE_THRESHOLD;
  const override = envNumber('MEMORY_INBOX_CONFIDENCE_THRESHOLD', env, 0, 1);
  if (override !== undefined) inbox_confidence_threshold = override;
  return { inbox_confidence_threshold };
}

/** File values, then MEMORY_TRACK_USAGE and MEMORY_RANK_* overrides. */
export function resolveRanking(
  fromFile?: {
    track_usage?: boolean;
    half_life_days?: number;
    weights?: Partial<RankingConfig['weights']>;
  } | null,
  env: NodeJS.ProcessEnv = process.env,
): RankingConfig {
  const weights = { ...DEFAULT_RANKING.weights, ...(fromFile?.weights ?? {}) };
  const ranking: RankingConfig = {
    track_usage: fromFile?.track_usage ?? DEFAULT_RANKING.track_usage,
    half_life_days: fromFile?.half_life_days ?? DEFAULT_RANKING.half_life_days,
    weights,
  };
  const track = envFlag('MEMORY_TRACK_USAGE', env.MEMORY_TRACK_USAGE);
  if (track !== undefined) ranking.track_usage = track;
  const halfLife = envNumber('MEMORY_RANK_HALF_LIFE_DAYS', env.MEMORY_RANK_HALF_LIFE_DAYS, 0.01, 3650);
  if (halfLife !== undefined) ranking.half_life_days = halfLife;
  const match = envNumber('MEMORY_RANK_MATCH', env.MEMORY_RANK_MATCH, 0, 100);
  const recency = envNumber('MEMORY_RANK_RECENCY', env.MEMORY_RANK_RECENCY, 0, 100);
  const links = envNumber('MEMORY_RANK_LINKS', env.MEMORY_RANK_LINKS, 0, 100);
  const usage = envNumber('MEMORY_RANK_USAGE', env.MEMORY_RANK_USAGE, 0, 100);
  if (match !== undefined) ranking.weights.match = match;
  if (recency !== undefined) ranking.weights.recency = recency;
  if (links !== undefined) ranking.weights.links = links;
  if (usage !== undefined) ranking.weights.usage = usage;
  return ranking;
}

function envNumber(name: string, raw: string | undefined, min: number, max: number): number | undefined {
  const override = raw?.trim();
  if (!override) return undefined;
  const value = Number(override);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number from ${min} to ${max} (got ${JSON.stringify(override)})`);
  }
  return value;
}

function envFlag(name: string, raw: string | undefined): boolean | undefined {
  const override = raw?.trim().toLowerCase();
  if (!override) return undefined;
  if (override === '1' || override === 'true' || override === 'yes' || override === 'on') return true;
  if (override === '0' || override === 'false' || override === 'no' || override === 'off') return false;
  throw new Error(`${name} must be true or false (got ${JSON.stringify(raw)})`);
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
  return resolveFlag('MEMORY_OUTPUT_SCHEMA', fromFile, env);
}

/** Shared boolean env override. Unset or blank keeps the file value (default false). */
export function resolveFlag(name: string, fromFile: boolean | undefined, env: string | undefined = process.env[name]): boolean {
  const override = env?.trim();
  if (!override) return fromFile ?? false;
  const normalized = override.toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
  throw new Error(`${name} must be true or false (got ${JSON.stringify(override)})`);
}

export type ResponseMode = 'compact' | 'full';

/** `MEMORY_RESPONSE` overrides the file. Unset or blank keeps the file value (default compact). */
export function resolveResponse(fromFile: string | undefined, env: string | undefined = process.env.MEMORY_RESPONSE): ResponseMode {
  const override = env?.trim();
  const value = (override && override.length > 0 ? override : fromFile) ?? 'compact';
  const normalized = value.toLowerCase();
  if (normalized === 'compact' || normalized === 'full') return normalized;
  const source = override && override.length > 0 ? 'MEMORY_RESPONSE' : 'response';
  throw new Error(`${source} must be compact or full (got ${JSON.stringify(value)})`);
}