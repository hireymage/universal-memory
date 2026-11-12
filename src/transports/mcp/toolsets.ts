/**
 * MCP tool catalogs. `standard` is the default: everyday read/write plus the
 * graph, claim, and source tools. `full` keeps every historical name.
 * `minimal` and `standard` only hide tools; they do not change validation,
 * revisions, or the dry-run changeset model.
 *
 * `lazy` discovery (the default) lists `standard` tools when the catalog is
 * `full`, plus `tool_groups`, which can enable the remaining groups for a
 * long-lived session. `eager` lists every tool in the selected catalog up front.
 * Stateless HTTP does not keep an enable across requests.
 */
export const TOOLSETS = ['minimal', 'standard', 'full'] as const;
export type Toolset = (typeof TOOLSETS)[number];
export const TOOL_DISCOVERIES = ['lazy', 'eager'] as const;
export type ToolDiscovery = (typeof TOOL_DISCOVERIES)[number];

/** Everyday read/write surface. */
export const MINIMAL_TOOLS = [
  'retrieve_context',
  'find',
  'search_memory',
  'recall',
  'remember',
  'update_memory',
  'archive_memory',
  'find_related',
  'search_people',
  'find_name_days',
  'resolve_entity',
  'health_report',
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
  'triage_inbox',
] as const;

const MINIMAL = new Set<string>(MINIMAL_TOOLS);
const STANDARD = new Set<string>(STANDARD_TOOLS);

/**
 * Full-catalog tools that lazy discovery leaves out of tools/list until
 * `tool_groups` enables them. Old names stay registered; eager lists them.
 */
export const TOOL_GROUPS = {
  aliases: [
    'people', 'projects', 'notes', 'inbox', 'list_people', 'get_person', 'get_person_context',
    'find_birthdays', 'get_context', 'create_entity', 'get_entity', 'update_entity', 'search_entities',
    'link_entities', 'record_project_decision', 'retrieve_relevant_memory',
  ],
  maintenance: [
    'inspect_memory', 'validate_memory', 'find_conflicts', 'scan_external_files', 'prepare_file_adoption',
    'find_broken_links', 'find_duplicates', 'suggest_links', 'prepare_normalization', 'apply_changeset',
    'repair_relation_links', 'migrate_schema', 'reindex', 'audit_history', 'run_health_check',
  ],
  agents: ['agent_profiles', 'agent_bootstrap'],
  neural: ['associate'],
} as const;

export const TOOL_GROUP_NAMES = Object.keys(TOOL_GROUPS) as Array<keyof typeof TOOL_GROUPS>;

export const TOOL_GROUP_SUMMARY: Record<keyof typeof TOOL_GROUPS, string> = {
  aliases: 'Domain aliases and generic entity tools (people, projects, notes, inbox, get_entity).',
  maintenance: 'Read-only scans and dry-run changesets. apply_changeset is the only writer.',
  agents: 'Agent identity, soul, roles, and bootstrap.',
  neural: 'Advisory BDH associate. search_memory already returns neural hits when a query is set.',
};

export function assertToolset(value: string | undefined): Toolset {
  const toolset = value && value.length > 0 ? value : 'standard';
  if (toolset !== 'minimal' && toolset !== 'standard' && toolset !== 'full') {
    throw new Error(`toolset must be minimal, standard, or full (got ${JSON.stringify(toolset)})`);
  }
  return toolset;
}

export function assertDiscovery(value: string | undefined): ToolDiscovery {
  const discovery = value && value.length > 0 ? value : 'lazy';
  if (discovery !== 'lazy' && discovery !== 'eager') {
    throw new Error(`tool_discovery must be lazy or eager (got ${JSON.stringify(discovery)})`);
  }
  return discovery;
}

/** `MEMORY_TOOL_DISCOVERY` overrides the file. Blank is treated as unset. Default `lazy`. */
export function resolveDiscovery(fromFile: string | undefined, env: string | undefined = process.env.MEMORY_TOOL_DISCOVERY): ToolDiscovery {
  const override = env?.trim();
  try {
    return assertDiscovery(override && override.length > 0 ? override : fromFile);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const source = override && override.length > 0 ? 'MEMORY_TOOL_DISCOVERY' : 'tool_discovery';
    throw new Error(message.replace(/^tool_discovery/, source));
  }
}

/** Tools listed before any `tool_groups` enable. Eager lists the whole toolset. */
export function toolListed(name: string, toolset: Toolset, discovery: ToolDiscovery): boolean {
  if (!toolVisible(name, toolset)) return false;
  if (discovery === 'eager') return true;
  return toolVisible(name, 'standard');
}

/** `MEMORY_TOOLSET` overrides the file. Blank is treated as unset. Default `standard`. */
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
