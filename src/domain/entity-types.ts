import { DEFAULT_SIMILARITY_THRESHOLD, compactForm, similarity, stripAccents } from './similarity.js';

/**
 * Known entity types. Routing in config.yml wins for a given vault; `defaultRoute`
 * is the path used when a config has not chosen one yet. `required` frontmatter
 * is enforced by the health check (error). `expected` is the same check at
 * warning severity: the file is valid without those keys, but the type is
 * incomplete. Aliases are accent-insensitive ("úkol" matches "ukol").
 *
 * Classification and health use this table. Neither one writes the vault.
 */
export type DateKind = 'date' | 'month-day' | 'datetime';

export interface DateField {
  key: string;
  kind: DateKind;
}

export interface EntityTypeSpec {
  type: string;
  defaultRoute: string;
  expected: string[];
  required: string[];
  aliases: string[];
  dates?: DateField[];
}

export interface NearestType {
  type: string;
  via: 'alias' | 'similarity';
  score: number;
}

const spec = (
  type: string,
  defaultRoute: string,
  extra: Partial<Pick<EntityTypeSpec, 'expected' | 'required' | 'aliases' | 'dates'>> = {},
): EntityTypeSpec => ({
  type,
  defaultRoute,
  expected: extra.expected ?? [],
  required: extra.required ?? [],
  aliases: extra.aliases ?? [],
  ...(extra.dates ? { dates: extra.dates } : {}),
});

export const ENTITY_TYPES: readonly EntityTypeSpec[] = [
  spec('memory', 'Memory/{slug}.md', { aliases: ['pamet', 'paměť'] }),
  spec('inbox', '00 Inbox/AI Inbox/{date}-{slug}.md', { aliases: ['schranka', 'schránka'] }),
  spec('note', '04 Knowledge/{slug}.md', { aliases: ['notes', 'poznamka', 'poznámka', 'poznamky', 'poznámky', 'memo'] }),
  spec('knowledge', '04 Knowledge/{slug}.md', { aliases: ['znalost'] }),
  spec('topic', '04 Knowledge/Topics/{slug}.md', { aliases: ['tema', 'téma'] }),
  spec('fact', '16 Facts/{slug}.md', { aliases: ['fakt', 'faktum'] }),
  spec('idea', '08 Ideas/{slug}.md', { aliases: ['napad', 'nápad'] }),
  spec('task', '11 Tasks/{slug}.md', { aliases: ['todo', 'to-do', 'ukol', 'úkol'], dates: [{ key: 'due', kind: 'date' }], expected: ['due'] }),
  spec('event', '14 Events/{date}-{slug}.md', {
    aliases: ['udalost', 'událost', 'schuzka', 'schůzka'],
    expected: ['starts_at'],
    dates: [{ key: 'starts_at', kind: 'datetime' }, { key: 'ends_at', kind: 'datetime' }],
  }),
  spec('preference', '15 Preferences/{slug}.md', { aliases: ['preferuji'] }),
  spec('decision', '10 Decisions/{slug}.md', {
    aliases: ['rozhodnuti', 'rozhodnutí'],
    expected: ['decided_at'],
    dates: [{ key: 'decided_at', kind: 'datetime' }],
  }),
  spec('conversation', '17 Conversations/{date}-{slug}.md', { aliases: ['konverzace', 'rozhovor'] }),
  spec('person', 'People/{slug}.md', {
    aliases: ['osoba', 'clovek', 'člověk'],
    expected: ['birth_date', 'name_day'],
    dates: [{ key: 'birth_date', kind: 'date' }, { key: 'name_day', kind: 'month-day' }],
  }),
  spec('project', '02 Projects/{project_slug}/index.md', { aliases: ['projekt'] }),
  spec('project_note', '02 Projects/{project_slug}/{project_subpath}{slug}.md'),
  spec('project_decision', '02 Projects/{project_slug}/decisions/{date}-{slug}.md', {
    required: ['project_id'],
    expected: ['project_slug', 'decided_at'],
    dates: [{ key: 'decided_at', kind: 'datetime' }],
  }),
  spec('project_collection', '02 Projects/{slug}.md'),
  spec('company', 'Companies/{slug}.md', { aliases: ['firma', 'spolecnost', 'společnost'] }),
  spec('property', 'Assets/{slug}.md'),
  spec('experience', '01 Me/{slug}.md'),
  spec('collection', '01 Me/{slug}.md'),
  spec('area', '03 Areas/{slug}.md'),
  spec('system', '05 Systems/{slug}.md'),
  spec('device', '05 Systems/Devices/{slug}.md'),
  spec('access', '06 Access/{slug}.md'),
  spec('reference', '13 Resources/References/{slug}.md'),
  spec('source', '13 Resources/Sources/{provider}/{date}-{slug}.md', {
    required: ['provider'],
    expected: ['identity_type', 'identity_value'],
  }),
  spec('communication', '07 Communication/{slug}.md'),
  spec('research', '09 Research/{slug}.md'),
  spec('web-clipping', '09 Research/Web Clippings/{slug}.md'),
  spec('purchase-decision', '10 Decisions/Purchases/{slug}.md'),
  spec('configuration', '05 Systems/Configuration/{slug}.md'),
  spec('journal', '12 Journal/{slug}.md'),
  spec('resource', '13 Resources/{slug}.md'),
  spec('archive', '90 Archive/{slug}.md'),
  spec('system_artifact', '99 System/{system_subpath}{slug}.md'),
  spec('folder_collection', '{collection_path}/index.md'),
  spec('agent_identity', 'Agents/{agent_id}/identity.en.md', { required: ['agent_id'] }),
  spec('agent_identity_cs', 'Agents/{agent_id}/identity.cs.md', { required: ['agent_id'] }),
  spec('agent_soul', 'Agents/{agent_id}/soul.en.md', { required: ['agent_id'] }),
  spec('agent_soul_cs', 'Agents/{agent_id}/soul.cs.md', { required: ['agent_id'] }),
  spec('agent_role', 'Agents/{agent_id}/roles/{role_id}.en.md', { required: ['agent_id'] }),
  spec('agent_role_cs', 'Agents/{agent_id}/roles/{role_id}.cs.md', { required: ['agent_id'] }),
];

/** Date keys recognized on every type, even when the type does not list them. */
export const GLOBAL_DATE_FIELDS: readonly DateField[] = [
  { key: 'birth_date', kind: 'date' },
  { key: 'name_day', kind: 'month-day' },
  { key: 'decided_at', kind: 'datetime' },
  { key: 'starts_at', kind: 'datetime' },
  { key: 'ends_at', kind: 'datetime' },
  { key: 'due', kind: 'date' },
  { key: 'due_date', kind: 'date' },
  { key: 'started_at', kind: 'datetime' },
  { key: 'completed_at', kind: 'datetime' },
];

const byType = new Map(ENTITY_TYPES.map(item => [item.type, item]));

export function entityTypeSpec(type: string): EntityTypeSpec | undefined {
  return byType.get(type);
}

export function defaultRoutes(): Record<string, { backend: string; path: string }> {
  return Object.fromEntries(ENTITY_TYPES.map(item => [item.type, { backend: 'markdown', path: item.defaultRoute }]));
}

export function dateFieldsFor(type: string): DateField[] {
  const seen = new Set<string>();
  const fields: DateField[] = [];
  for (const field of [...GLOBAL_DATE_FIELDS, ...(entityTypeSpec(type)?.dates ?? [])]) {
    if (seen.has(field.key)) continue;
    seen.add(field.key);
    fields.push(field);
  }
  return fields;
}

/**
 * Nearest registry type for a name that is not itself a configured route.
 * Exact id or alias (accent- and case-insensitive) wins. Otherwise the
 * shared similarity score, with a floor at DEFAULT_SIMILARITY_THRESHOLD.
 * Very short containment matches ("art" inside "system_artifact") are ignored
 * so a three-letter token cannot claim a long type name.
 */
export function nearestKnownType(name: string): NearestType | undefined {
  const key = stripAccents(name).trim();
  if (!key) return undefined;
  for (const item of ENTITY_TYPES) {
    if (stripAccents(item.type) === key) return { type: item.type, via: 'alias', score: 1 };
    if (item.aliases.some(alias => stripAccents(alias) === key)) return { type: item.type, via: 'alias', score: 1 };
  }
  let best: { type: string; score: number; gap: number } | undefined;
  for (const item of ENTITY_TYPES) {
    for (const label of [item.type, ...item.aliases]) {
      const score = typeSimilarity(name, label);
      if (score < DEFAULT_SIMILARITY_THRESHOLD) continue;
      const gap = Math.abs(compactForm(item.type).length - compactForm(name).length);
      if (!best || score > best.score + 1e-9 || (Math.abs(score - best.score) <= 1e-9 && (gap < best.gap || (gap === best.gap && item.type.length > best.type.length)))) {
        best = { type: item.type, score, gap };
      }
    }
  }
  return best ? { type: best.type, via: 'similarity', score: best.score } : undefined;
}

function typeSimilarity(query: string, label: string): number {
  const score = similarity(query, label);
  if (score <= 0) return 0;
  const left = compactForm(query);
  const right = compactForm(label);
  if (left && right && left !== right && (left.includes(right) || right.includes(left)) && Math.min(left.length, right.length) < 4) return 0;
  return score;
}

export function isRealUtcDate(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_DAY = /^(\d{2})-(\d{2})$/;
const ISO_DATETIME = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export function isIsoDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  return isRealUtcDate(Number(match[1]), Number(match[2]), Number(match[3]));
}

/** `MM-DD` (leap day allowed) or a full ISO date. */
export function isMonthDay(value: string): boolean {
  const match = MONTH_DAY.exec(value);
  if (match) return isRealUtcDate(2024, Number(match[1]), Number(match[2]));
  return isIsoDate(value);
}

export function isIsoDateTime(value: string): boolean {
  if (isIsoDate(value)) return true;
  const match = ISO_DATETIME.exec(value);
  return match ? isIsoDate(match[1]!) : false;
}

/** A present value that is not a valid date of the requested kind. Absent values are not invalid. */
export function isInvalidDate(value: unknown, kind: DateKind): boolean {
  if (value == null) return false;
  if (value instanceof Date) return Number.isNaN(value.getTime());
  if (typeof value !== 'string' || !value.trim()) return true;
  if (kind === 'date') return !isIsoDate(value);
  if (kind === 'month-day') return !isMonthDay(value);
  return !isIsoDateTime(value);
}

/** Trim, collapse whitespace, Czech-lowercase, and drop duplicates. Order of first occurrence is kept. */
export function normalizeTags(tags: string[]): { tags: string[]; changed: boolean } {
  const next: string[] = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    const normalized = tag.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('cs');
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    next.push(normalized);
  }
  const changed = next.length !== tags.length || next.some((tag, index) => tag !== tags[index]);
  return { tags: next, changed };
}
