import type { UsageStore } from '../adapters/audit/usage-store.js';
import { normalizeTags } from '../domain/entity-types.js';
import { parseFindQuery, type ParsedFindQuery } from '../domain/find-query.js';
import { todayInPrague } from '../domain/name-days.js';
import { combinedRank, compareSchedule, recencyScore, saturatingScore, scheduleOf, type RankingConfig } from '../domain/ranking.js';
import { oneSentence } from '../domain/snippet.js';
import { normalizedForm, similarity, stripAccents } from '../domain/similarity.js';
import type { Entity } from '../domain/types.js';
import type { SearchIndex } from '../ports/index.js';
import type { NeuralMemoryService } from './neural-memory-service.js';
import type { MemoryService } from './memory-service.js';

export interface FindHit {
  id: string;
  title: string;
  type: string;
  path: string;
  snippet: string;
  score: number;
  reason: string;
  overdue?: true;
  revision?: string;
  status?: string;
  updated_at?: string;
  tags?: string[];
  due?: string;
  starts_at?: string;
  scores?: { match: number; recency: number; links: number; usage: number; lexical?: number; neural?: number; vector?: number };
}

export interface FindResult {
  query: string;
  parsed: ParsedFindQuery;
  order: 'relevance' | 'due';
  hits: FindHit[];
}

interface Accumulator {
  entity: Entity;
  lexical?: number;
  neural?: number;
  vector?: number;
}

const PERSON_KEYS = ['person', 'people', 'owner', 'assignee'];
const PROJECT_KEYS = ['project', 'project_slug', 'project_title', 'project_id'];

/**
 * One query, three recall paths. Fulltext is the verifiable list. Neural and
 * vector hits are merged in when the sidecar has them, then dropped if they
 * miss an explicit filter. The default hit is six fields plus a short reason.
 */
export class FindService {
  constructor(
    private readonly memory: MemoryService,
    private readonly index: SearchIndex,
    private readonly neural: NeuralMemoryService,
    private readonly usage: UsageStore,
    private readonly ranking: RankingConfig,
  ) {}

  async find(input: { query: string; limit?: number; detail?: boolean; order?: 'relevance' | 'due' }): Promise<FindResult> {
    const limit = Math.min(Math.max(input.limit ?? 10, 1), 20);
    const order = input.order ?? 'relevance';
    const today = todayInPrague();
    const parsed = parseFindQuery(input.query, today);
    const rows = new Map<string, Accumulator>();

    for (const entity of await this.lexical(parsed)) {
      if (!matchesFilters(entity, parsed)) continue;
      rows.set(entity.metadata.id, {
        entity,
        ...(parsed.text ? { lexical: lexicalScore(parsed.text, entity) } : {}),
      });
    }

    if (parsed.text) {
      const assoc = await this.neural.associate(parsed.text, limit, 'neural').catch(() => undefined);
      if (assoc?.available) {
        for (const hit of assoc.results) await this.mergeSide(rows, hit.id, hit.score, 'neural', parsed);
      }
      if (assoc?.vector_available) {
        for (const hit of assoc.vector_results) await this.mergeSide(rows, hit.id, hit.score, 'vector', parsed);
      }
    }

    const entities = [...rows.values()];
    const usage = await this.usage.countsFor(entities.map(row => row.entity.metadata.id));
    const now = new Date();
    const ranked = await Promise.all(entities.map(async row => {
      const links = await linkCount(this.index, row.entity);
      const signals = {
        match: matchScore(row),
        recency: recencyScore(row.entity.metadata.updated_at, now, this.ranking.half_life_days),
        links: saturatingScore(links),
        usage: saturatingScore(usage.get(row.entity.metadata.id) ?? 0),
      };
      return { row, links, score: combinedRank(signals, this.ranking.weights), signals };
    }));

    ranked.sort((a, b) => {
      if (order === 'due') {
        const byDate = compareSchedule(scheduleOf(a.row.entity, today), scheduleOf(b.row.entity, today));
        if (byDate) return byDate;
      }
      return b.score - a.score || a.row.entity.metadata.title.localeCompare(b.row.entity.metadata.title, 'cs');
    });

    const hits = ranked.slice(0, limit).map(item => toHit(item.row, item.score, parsed.text, today, input.detail === true, item.signals));
    return { query: input.query, parsed, order, hits };
  }

  private async lexical(parsed: ParsedFindQuery): Promise<Entity[]> {
    if (parsed.text || parsed.types.length) {
      return this.memory.search({
        ...(parsed.text ? { query: parsed.text } : {}),
        ...(parsed.types.length ? { types: parsed.types } : {}),
        limit: 200,
      });
    }
    return this.index.listAll();
  }

  private async mergeSide(
    rows: Map<string, Accumulator>,
    id: string,
    score: number,
    source: 'neural' | 'vector',
    parsed: ParsedFindQuery,
  ): Promise<void> {
    const clamped = clamp01(score);
    if (!(clamped > 0)) return;
    let row = rows.get(id);
    if (!row) {
      let entity: Entity | undefined;
      try { entity = await this.memory.get(id); } catch { entity = undefined; }
      if (!entity || !matchesFilters(entity, parsed)) return;
      row = { entity };
      rows.set(id, row);
    }
    row[source] = Math.max(row[source] ?? 0, clamped);
  }
}

export async function linkCount(index: SearchIndex, entity: Entity): Promise<number> {
  const [outgoing, incoming] = await Promise.all([
    index.edgesFrom(entity.metadata.id),
    index.edgesTo(entity.metadata.id),
  ]);
  return entity.wikilinks.length + outgoing.length + incoming.length;
}

export function matchScore(row: Pick<Accumulator, 'lexical' | 'neural' | 'vector'>): number {
  const parts = [row.lexical, row.neural, row.vector].filter((score): score is number => score !== undefined && score > 0);
  if (!parts.length) return 0;
  const best = Math.max(...parts);
  return clamp01(best + (parts.length - 1) * 0.05);
}

function toHit(
  row: Accumulator,
  score: number,
  text: string,
  today: string,
  detail: boolean,
  signals: { match: number; recency: number; links: number; usage: number },
): FindHit {
  const entity = row.entity;
  const schedule = scheduleOf(entity, today);
  const reason = explain(row, schedule?.overdue === true);
  const hit: FindHit = {
    id: entity.metadata.id,
    title: entity.metadata.title,
    type: entity.metadata.type,
    path: entity.path,
    snippet: oneSentence(entity.content, text, detail ? 320 : 140),
    score,
    reason,
    ...(schedule?.overdue ? { overdue: true } : {}),
  };
  if (!detail) return hit;
  const starts = typeof entity.metadata.starts_at === 'string' ? entity.metadata.starts_at : undefined;
  const due = typeof entity.metadata.due === 'string' ? entity.metadata.due : undefined;
  return {
    ...hit,
    revision: entity.revision,
    status: entity.metadata.status,
    updated_at: entity.metadata.updated_at,
    tags: entity.metadata.tags,
    ...(due ? { due } : {}),
    ...(starts ? { starts_at: starts } : {}),
    scores: {
      ...signals,
      ...(row.lexical !== undefined ? { lexical: row.lexical } : {}),
      ...(row.neural !== undefined ? { neural: row.neural } : {}),
      ...(row.vector !== undefined ? { vector: row.vector } : {}),
    },
  };
}

function explain(row: Accumulator, overdue: boolean): string {
  const parts: string[] = [];
  if (row.lexical !== undefined) parts.push('fulltext');
  if (row.vector !== undefined) parts.push('vector');
  if (row.neural !== undefined) parts.push('neural');
  if (overdue) parts.push('overdue');
  return parts.join('+') || 'filter';
}

function lexicalScore(text: string, entity: Entity): number {
  const title = similarity(text, entity.metadata.title);
  const alias = entity.metadata.aliases.reduce((best, item) => Math.max(best, similarity(text, item)), 0);
  return Math.max(title, alias, 0.35);
}

function matchesFilters(entity: Entity, parsed: ParsedFindQuery): boolean {
  if (parsed.types.length && !parsed.types.includes(entity.metadata.type)) return false;
  if (parsed.tags.length && !parsed.tags.every(tag => hasTag(entity, tag))) return false;
  if (parsed.person && !mentions(entity, parsed.person, PERSON_KEYS)) return false;
  if (parsed.project && !mentions(entity, parsed.project, PROJECT_KEYS)) return false;
  if (parsed.since && entity.metadata.updated_at.slice(0, 10) < parsed.since) return false;
  if (parsed.due) {
    const day = filterDay(entity, parsed);
    if (!day || day < parsed.due.from || day > parsed.due.to) return false;
  }
  return true;
}

function filterDay(entity: Entity, parsed: ParsedFindQuery): string | undefined {
  const due = calendarDay(entity.metadata.due ?? entity.metadata.due_date);
  const starts = calendarDay(entity.metadata.starts_at);
  if (entity.metadata.type === 'event') return starts ?? due;
  if (entity.metadata.type === 'task') return due ?? starts;
  if (parsed.types.length === 1 && parsed.types[0] === 'event') return starts ?? due;
  return due ?? starts;
}

function hasTag(entity: Entity, tag: string): boolean {
  const want = stripAccents(normalizeTags([tag]).tags[0] ?? '');
  if (!want) return false;
  return normalizeTags(entity.metadata.tags).tags.some(item => stripAccents(item) === want);
}

function mentions(entity: Entity, needle: string, keys: string[]): boolean {
  const folded = normalizedForm(needle);
  if (!folded) return true;
  const blobs = [entity.metadata.title, ...entity.metadata.aliases, ...entity.wikilinks, entity.content, entity.path];
  for (const key of keys) {
    const value = entity.metadata[key];
    if (typeof value === 'string') blobs.push(value);
    else if (Array.isArray(value)) for (const item of value) if (typeof item === 'string') blobs.push(item);
  }
  return blobs.some(value => normalizedForm(value).includes(folded));
}

function calendarDay(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const day = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : undefined;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
