import type { AliasCollision, ArchivedVisibility, ResolveCandidate, ResolveMatch, SearchIndex, SourceFilter } from '../../ports/index.js';
import type { Entity, RelationEdge, SearchQuery } from '../../domain/types.js';
import { normalizeRelations } from '../../domain/model.js';
import { sourceIdentity } from '../../domain/source-identity.js';

/**
 * Disposable process-local index. Markdown is the only persisted data store.
 * Restarting the server simply rebuilds this map from the vault.
 */
const ARCHIVED = 'archived';

export class InMemoryIndex implements SearchIndex {
  entities = new Map<string, Entity>();
  rebuildQueue: Promise<unknown> = Promise.resolve();
  /** alias key → entity ids claiming it, per normal form */
  private byNormalized = new Map<string, Set<string>>();
  private byCompact = new Map<string, Set<string>>();
  /**
   * Obsidian-style path keys. The full vault-relative path (without the
   * extension) is unique by construction; the bare file name may legitimately
   * be shared (two `index.md` in different folders), so it stays a separate
   * key space and resolves to multiple candidates — reported, never picked.
   */
  private byFullPath = new Map<string, Set<string>>();
  private byBasename = new Map<string, Set<string>>();
  private byPathNormalized = new Map<string, Set<string>>();
  /** entity id → its current alias keys, so upsert can retract the old ones */
  private aliasKeys = new Map<string, { normalized: string[]; compact: string[] }>();
  private pathKeys = new Map<string, { full: string[]; base: string[]; normalized: string[] }>();
  private bySource = new Map<string, RelationEdge[]>();
  private byTarget = new Map<string, RelationEdge[]>();

  async rebuild(source: AsyncIterable<Entity>): Promise<{ indexed: number }> {
    const run = this.rebuildQueue.then(async () => {
      const next = new Map<string, Entity>();
      for await (const entity of source) next.set(entity.metadata.id, entity);
      this.entities = next;
      this.rebuildGraph();
      return next.size;
    });
    this.rebuildQueue = run.then(() => undefined, () => undefined);
    return { indexed: await run };
  }
  async upsert(entity: Entity): Promise<void> {
    await this.rebuildQueue;
    this.entities.set(entity.metadata.id, entity);
    this.retractAliases(entity.metadata.id);
    this.extendAliases(entity);
    this.retractPaths(entity.metadata.id);
    this.extendPaths(entity);
    this.retractEdges(entity.metadata.id);
    this.extendEdges(entity);
  }
  async remove(id: string): Promise<void> {
    await this.rebuildQueue;
    this.entities.delete(id);
    this.retractAliases(id);
    this.retractPaths(id);
    this.retractEdges(id);
  }
  async listEntries(): Promise<Array<{ id: string; path: string; revision: string }>> {
    return [...this.entities.values()].map(entity => ({ id: entity.metadata.id, path: entity.path, revision: entity.revision }));
  }
  async findById(id: string): Promise<{ path: string; revision: string } | undefined> {
    const entity = this.entities.get(id);
    return entity ? { path: entity.path, revision: entity.revision } : undefined;
  }
  async search(query: SearchQuery): Promise<Entity[]> {
    const normalized = normalize(query.query ?? '');
    const tokens = tokenize(normalized);
    return [...this.entities.values()]
      .filter(entity =>
        (!query.types?.length || query.types.includes(entity.metadata.type)) &&
        (!query.status || entity.metadata.status === query.status) &&
        (!query.tags?.length || query.tags.every(tag => entity.metadata.tags.includes(tag))) &&
        (!normalized || matches(entity, normalized, tokens)))
      .sort((a, b) =>
        rank(b, normalized, tokens) - rank(a, normalized, tokens) ||
        b.metadata.updated_at.localeCompare(a.metadata.updated_at) ||
        a.metadata.title.localeCompare(b.metadata.title))
      .slice(0, Math.min(query.limit ?? 20, 200));
  }
  async backlinks(titleOrAlias: string): Promise<Entity[]> {
    const needle = normalize(titleOrAlias);
    return [...this.entities.values()].filter(entity => entity.wikilinks.some(link => normalize(link) === needle));
  }
  async linksFrom(id: string): Promise<string[]> { return this.entities.get(id)?.wikilinks ?? []; }
  async dateWindow(field: 'birth_date' | 'name_day', from: string, to: string, visibility: ArchivedVisibility = {}): Promise<Entity[]> {
    const start = new Date(`${from}T00:00:00Z`), end = new Date(`${to}T23:59:59Z`);
    const people = await this.search({ types: ['person'], limit: 200 });
    return people.filter(person => {
      if (!this.isVisible(person, visibility)) return false;
      const raw = person.metadata[field];
      if (typeof raw !== 'string') return false;
      const [, month, day] = raw.match(/^(?:\d{4}-)?(\d{2})-(\d{2})$/) ?? [];
      if (!month || !day) return false;
      for (let year = start.getUTCFullYear(); year <= end.getUTCFullYear(); year++) {
        const date = new Date(Date.UTC(year, Number(month) - 1, Number(day)));
        if (date >= start && date <= end) return true;
      }
      return false;
    });
  }
  async resolveLookup(raw: string, visibility: ArchivedVisibility = {}): Promise<ResolveCandidate[]> {
    const value = raw.trim();
    if (!value) return [];
    // Archived entities stay indexed (ID-addressable, auditable, restorable)
    // but are not resolution candidates unless the caller explicitly asks.
    const visible = (entity: Entity | undefined): boolean => entity !== undefined && this.isVisible(entity, visibility);
    const direct = this.entities.get(value);
    if (direct && visible(direct)) return [{ entity: direct, match: 'id' as ResolveMatch }];
    const candidates: ResolveCandidate[] = [];
    for (const entity of this.entities.values())
      if (visible(entity) && (entity.metadata.title === value || entity.metadata.aliases.includes(value))) candidates.push({ entity, match: 'exact' as ResolveMatch });
    if (!candidates.length) {
      // Exact path first (full vault-relative path, then bare file name), then
      // a spaced-normalized path — all ahead of any fuzzy title matching.
      const path = `${value.replace(/\\/g, '/').replace(/\.md$/i, '')}`;
      for (const key of this.pathSet(this.byFullPath, [path.toLocaleLowerCase()]))
        if (visible(this.entities.get(key))) candidates.push({ entity: this.entities.get(key)!, match: 'path' as ResolveMatch });
      for (const key of this.pathSet(this.byBasename, [path.split('/').at(-1)!.toLocaleLowerCase()]))
        if (visible(this.entities.get(key))) candidates.push({ entity: this.entities.get(key)!, match: 'path' as ResolveMatch });
      for (const key of this.pathSet(this.byPathNormalized, normalizedKeys([path])))
        if (visible(this.entities.get(key))) candidates.push({ entity: this.entities.get(key)!, match: 'path' as ResolveMatch });
    }
    if (!candidates.length) {
      for (const key of this.aliasSet(this.byNormalized, normalizedKeys([value])))
        if (visible(this.entities.get(key))) candidates.push({ entity: this.entities.get(key)!, match: 'normalized' as ResolveMatch });
      for (const key of this.aliasSet(this.byCompact, compactKeys([value])))
        if (visible(this.entities.get(key))) candidates.push({ entity: this.entities.get(key)!, match: 'compact' as ResolveMatch });
    }
    return candidates;
  }
  async edgesFrom(id: string): Promise<RelationEdge[]> { await this.rebuildQueue; return this.bySource.get(id) ?? []; }
  async edgesTo(id: string): Promise<RelationEdge[]> { await this.rebuildQueue; return this.byTarget.get(id) ?? []; }
  async aliasCollisions(visibility: ArchivedVisibility = {}): Promise<AliasCollision[]> {
    const result: AliasCollision[] = [];
    const resolvable = (ids: Iterable<string>): string[] =>
      [...ids].filter(id => this.isVisible(this.entities.get(id), visibility));
    for (const [form, map] of [['normalized', this.byNormalized], ['compact', this.byCompact]] as const)
      for (const [key, ids] of [...map].sort((a, b) => a[0].localeCompare(b[0]))) {
        const claimants = resolvable(ids);
        if (claimants.length > 1) result.push({ key, form, entity_ids: claimants });
      }
    // Only bare-name collisions are real collisions: a full path key is
    // unique by construction (one entity per vault path).
    for (const [key, ids] of [...this.byBasename].sort((a, b) => a[0].localeCompare(b[0]))) {
      const claimants = resolvable(ids);
      if (claimants.length > 1) result.push({ key, form: 'path', entity_ids: claimants });
    }
    return result;
  }
  async findSources(filter: SourceFilter): Promise<Entity[]> {
    // Identity match runs over the canonical triple space (Phase-3C VARIANTA
    // B §7/§8): typed filters and legacy single-field filters normalize to the
    // same identity, so a typed source is found by its legacy key and a
    // legacy source by its normalized identity. When BOTH legacy keys are
    // supplied together, the pre-VARIANTA semantics are preserved (all
    // supplied keys must match stored fields).
    const wantProvider = typeof filter.provider === 'string' ? filter.provider.trim().toLowerCase() : undefined;
    const typed = filter.identity_type !== undefined && filter.identity_value !== undefined
      ? { identity_type: String(filter.identity_type), identity_value: String(filter.identity_value).trim() }
      : undefined;
    const legacyBoth = filter.conversation_id !== undefined && filter.content_hash !== undefined;
    return [...this.entities.values()].filter(entity => {
      if (entity.metadata.type !== 'source') return false;
      const identity = sourceIdentity(entity.metadata);
      if (wantProvider !== undefined && (identity === undefined || identity.provider !== wantProvider)) return false;
      if (typed)
        return identity !== undefined && identity.identity_type === typed.identity_type && identity.identity_value === typed.identity_value;
      if (legacyBoth)
        return entity.metadata.conversation_id === filter.conversation_id && entity.metadata.content_hash === filter.content_hash;
      if (typeof filter.conversation_id === 'string') {
        const want = filter.conversation_id.trim();
        return identity !== undefined && identity.identity_type === 'conversation' && identity.identity_value === want;
      }
      if (typeof filter.content_hash === 'string') {
        const want = filter.content_hash.trim();
        return identity !== undefined && identity.identity_type === 'content_hash' && identity.identity_value === want;
      }
      return true;
    });
  }

  /** Archived entities are invisible to resolution and collision reporting
   * unless the caller explicitly opts in. Rebuild and upsert both route through
   * this predicate, so the rule cannot drift between a cold start and a write. */
  private isVisible(entity: Entity | undefined, visibility: ArchivedVisibility): boolean {
    if (!entity) return false;
    return visibility.includeArchived === true || entity.metadata.status !== ARCHIVED;
  }

  private aliasSet(map: Map<string, Set<string>>, keys: string[]): string[] {
    const ids = new Set<string>();
    for (const key of keys) for (const id of map.get(key) ?? []) ids.add(id);
    return [...ids];
  }
  /** Path lookup over case-insensitive key space; ids are validated (upsert/remove keep the maps consistent). */
  private pathSet(map: Map<string, Set<string>>, keys: string[]): string[] {
    const ids = new Set<string>();
    for (const key of keys) for (const id of map.get(key) ?? []) if (this.entities.has(id)) ids.add(id);
    return [...ids];
  }
  private retractPaths(id: string): void {
    const previous = this.pathKeys.get(id);
    if (!previous) return;
    for (const key of previous.full) this.drop(this.byFullPath, key, id);
    for (const key of previous.base) this.drop(this.byBasename, key, id);
    for (const key of previous.normalized) this.drop(this.byPathNormalized, key, id);
    this.pathKeys.delete(id);
  }
  private extendPaths(entity: Entity): void {
    const fullPath = entity.path.replace(/\\/g, '/').replace(/\.md$/i, '').toLocaleLowerCase();
    const base = fullPath.split('/').at(-1)!;
    const keys = {
      full: [fullPath],
      base: [base],
      normalized: normalizedKeys([fullPath]).filter(Boolean),
    };
    for (const key of keys.full) this.add(this.byFullPath, key, entity.metadata.id);
    for (const key of keys.base) this.add(this.byBasename, key, entity.metadata.id);
    for (const key of keys.normalized) this.add(this.byPathNormalized, key, entity.metadata.id);
    this.pathKeys.set(entity.metadata.id, keys);
  }
  private retractAliases(id: string): void {
    const previous = this.aliasKeys.get(id);
    if (!previous) return;
    for (const key of previous.normalized) this.drop(this.byNormalized, key, id);
    for (const key of previous.compact) this.drop(this.byCompact, key, id);
    this.aliasKeys.delete(id);
  }
  private extendAliases(entity: Entity): void {
    const keys = { normalized: normalizedKeys(aliasValues(entity)), compact: compactKeys(aliasValues(entity)) };
    for (const key of keys.normalized) this.add(this.byNormalized, key, entity.metadata.id);
    for (const key of keys.compact) this.add(this.byCompact, key, entity.metadata.id);
    this.aliasKeys.set(entity.metadata.id, keys);
  }
  private retractEdges(id: string): void {
    for (const edge of this.bySource.get(id) ?? []) this.dropList(this.byTarget, edge.target_id, (e) => e.id === edge.id && e.source_id === id);
    this.bySource.delete(id);
  }
  private extendEdges(entity: Entity): void {
    const edges = normalizeRelations(entity.metadata, entity.metadata.id).map(relation => ({ ...relation, source_id: entity.metadata.id }));
    if (edges.length) this.bySource.set(entity.metadata.id, edges);
    for (const edge of edges) {
      const target = this.byTarget.get(edge.target_id) ?? [];
      if (!target.some(r => r.id === edge.id && r.source_id === edge.source_id)) target.push(edge);
      this.byTarget.set(edge.target_id, target);
    }
  }
  private rebuildGraph(): void {
    this.byNormalized = new Map(); this.byCompact = new Map(); this.aliasKeys = new Map();
    this.byFullPath = new Map(); this.byBasename = new Map(); this.byPathNormalized = new Map(); this.pathKeys = new Map();
    this.bySource = new Map(); this.byTarget = new Map();
    for (const entity of this.entities.values()) { this.extendAliases(entity); this.extendPaths(entity); this.extendEdges(entity); }
  }

  private add(map: Map<string, Set<string>>, key: string, id: string): void {
    const bucket = map.get(key) ?? new Set<string>();
    bucket.add(id);
    map.set(key, bucket);
  }
  private drop(map: Map<string, Set<string>>, key: string, id: string): void {
    const bucket = map.get(key);
    if (bucket) { bucket.delete(id); if (!bucket.size) map.delete(key); }
  }
  private dropList(map: Map<string, RelationEdge[]>, key: string, predicate: (edge: RelationEdge) => boolean): void {
    const list = map.get(key);
    if (!list) return;
    const next = list.filter(relation => !predicate(relation));
    if (next.length) map.set(key, next); else map.delete(key);
  }
}

const stopWords = new Set(['informace', 'potrebuji', 'potreboval', 'chci', 'prosim', 'najdi', 'hledej', 'neco', 'vse', 'vsechno', 'ohledne', 'kolik', 'mam', 'ma', 'mas', 'mame', 'mate', 'jsou', 'je', 'jak', 'kdy', 'kdo', 'co', 'ktery', 'kterou', 'kterem', 'mi', 'me', 'moje', 'muj', 'moji', 'nase', 'about', 'find', 'show', 'tell', 'what', 'when', 'who', 'how', 'the', 'and']);
const normalize = (value: string): string => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const relationshipTerms: Record<string, string[]> = { dite: ['deti', 'syn', 'dcera', 'child', 'children'], deti: ['dite', 'syn', 'dcera', 'child', 'children'], children: ['child', 'deti', 'syn', 'dcera'], child: ['children', 'dite', 'deti', 'syn', 'dcera'] };
const tokenize = (value: string): string[] => { const tokens = value.split(/\s+/).filter(token => token.length >= 2 && !stopWords.has(token)); return [...new Set(tokens.flatMap(token => [token, ...(relationshipTerms[token] ?? [])]))]; };
const haystack = (entity: Entity): string => normalize([entity.metadata.title, ...entity.metadata.aliases, entity.path, entity.content].join('\n'));
const matches = (entity: Entity, phrase: string, tokens: string[]): boolean => haystack(entity).includes(phrase) || tokens.some(token => haystack(entity).includes(token));
function rank(entity: Entity, phrase: string, tokens: string[]): number {
  const title = normalize(entity.metadata.title), aliases = normalize(entity.metadata.aliases.join(' ')), path = normalize(entity.path), content = normalize(entity.content);
  let score = 0;
  if (phrase) {
    if (title === phrase) score += 2000;
    else if (title.includes(phrase)) score += 1000;
    if (path.includes(phrase)) score += 700;
    if (aliases.includes(phrase)) score += 600;
    if (content.includes(phrase)) score += 200;
  }
  for (const token of tokens) {
    if (title === token) score += 500;
    else if (title.includes(token)) score += 250;
    if (path.includes(token)) score += 180;
    if (aliases.includes(token)) score += 150;
    if (content.includes(token)) score += 5;
  }
  return score;
}

/** Alias keys of one entity: the title plus every declared alias. */
const aliasValues = (entity: Entity): string[] => [entity.metadata.title, ...entity.metadata.aliases];

/** Spaced normal form: accents stripped, lowercase, non-alphanumerics → space. */
const normalizedKeys = (values: string[]): string[] => [...new Set(values.map(value => normalize(value)).filter(Boolean))];
/** Compact normal form: non-alphanumerics removed — matches "RTX2070" with "RTX 2070". */
const compactKeys = (values: string[]): string[] =>
  [...new Set(values.map(value => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().replace(/[^a-z0-9]/g, '')).filter(Boolean))];