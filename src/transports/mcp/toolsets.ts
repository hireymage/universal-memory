/**
 * MCP tool catalogs. `full` is the default so existing clients keep every
 * current tool name. `minimal` and `standard` only hide tools; they do not
 * change validation, revisions, or the dry-run changeset model.
 */
export const TOOLSETS = ['minimal', 'standard', 'full'] as const;
export type Toolset = (typeof TOOLSETS)[number];

/** Everyday read/write surface. */
export const MINIMAL_TOOLS = [
  'retrieve_context',
  'search_memory',
  'recall',
  'remember',
  'update_memory',
  'archive_memory',
  'find_related',
  'search_people',
  'find_name_days',
  'resolve_entity',
] as const;

/**
 * Minimal plus the graph, claim, and source tools. Aliases (`people`,
 * `notes`, …), vault maintenance, and agent profiles stay on `full`.
 * `merge_entities` only prepares a changeset; applying it needs `apply_changeset`,
 * which is part of the full maintenance catalog.
 */
export const STANDARD_TOOLS = [
  ...MINIMAL_TOOLS,
  'merge_entities',
  'create_relation',
  'get_entity_relations',
  'query_relations',
  'delete_relation',
  'build_relations',
  'create_claim',
  'get_claims',
  'get_entity_timeline',
  'update_claim',
  'invalidate_claim',
  'correct_claim',
  'find_suspect_claims',
  'create_source',
  'get_source',
  'find_source',
  'distill_next_chunk',
] as const;

const MINIMAL = new Set<string>(MINIMAL_TOOLS);
const STANDARD = new Set<string>(STANDARD_TOOLS);

export function assertToolset(value: string | undefined): Toolset {
  const toolset = value && value.length > 0 ? value : 'full';
  if (toolset !== 'minimal' && toolset !== 'standard' && toolset !== 'full') {
    throw new Error(`toolset must be minimal, standard, or full (got ${JSON.stringify(toolset)})`);
  }
  return toolset;
}

/** `MEMORY_TOOLSET` overrides the file. Blank is treated as unset. */
export function resolveToolset(fromFile: string | undefined, env: string | undefined = process.env.MEMORY_TOOLSET): Toolset {
  const override = env?.trim();
  try {
    return assertToolset(override && override.length > 0 ? override : fromFile);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const source = override && override.length > 0 ? 'MEMORY_TOOLSET' : 'toolset';
    throw new Error(message.replace(/^toolset/, source));
  }
}

export function toolVisible(name: string, toolset: Toolset): boolean {
  if (toolset === 'full') return true;
  if (toolset === 'standard') return STANDARD.has(name);
  return MINIMAL.has(name);
}
