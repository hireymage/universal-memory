import type { Entity } from './types.js';
import { isIsoDate } from './entity-types.js';

/**
 * Ranking weights. `match` stays dominant so a clearly better text hit is not
 * displaced by recency. The divisor is the sum of the weights, so raising one
 * weight is enough; they do not have to add up to 1.
 */
export interface RankWeights {
  match: number;
  recency: number;
  links: number;
  usage: number;
}

export interface RankSignals {
  match: number;
  recency: number;
  links: number;
  usage: number;
}

export const DEFAULT_RANK_WEIGHTS: RankWeights = {
  match: 1,
  recency: 0.15,
  links: 0.1,
  usage: 0.05,
};

/** Age at which recency falls to 0.5. Thirty days keeps last month visible. */
export const DEFAULT_RECENCY_HALF_LIFE_DAYS = 30;

export interface RankingConfig {
  track_usage: boolean;
  half_life_days: number;
  weights: RankWeights;
}

export const DEFAULT_RANKING: RankingConfig = {
  track_usage: false,
  half_life_days: DEFAULT_RECENCY_HALF_LIFE_DAYS,
  weights: DEFAULT_RANK_WEIGHTS,
};

export function recencyScore(updatedAt: string | undefined, now: Date, halfLifeDays = DEFAULT_RECENCY_HALF_LIFE_DAYS): number {
  if (!updatedAt || !(halfLifeDays > 0)) return 0;
  const timestamp = Date.parse(updatedAt);
  if (Number.isNaN(timestamp)) return 0;
  const ageDays = Math.max(0, (now.getTime() - timestamp) / 86_400_000);
  return Math.exp(-Math.LN2 * ageDays / halfLifeDays);
}

/** 0 links → 0, 1 → 0.5, 3 → 0.75, then flattens. Usage uses the same curve. */
export function saturatingScore(count: number): number {
  if (!Number.isFinite(count) || count <= 0) return 0;
  return 1 - 1 / (1 + count);
}

export function combinedRank(signals: RankSignals, weights: RankWeights = DEFAULT_RANK_WEIGHTS): number {
  const weight = weights.match + weights.recency + weights.links + weights.usage;
  if (!(weight > 0)) return clamp01(signals.match);
  const raw = signals.match * weights.match
    + signals.recency * weights.recency
    + signals.links * weights.links
    + signals.usage * weights.usage;
  return Number((raw / weight).toFixed(4));
}

export interface ScheduleInfo {
  /** Calendar day `YYYY-MM-DD` from `due` / `due_date` (tasks) or `starts_at` (events). */
  date: string;
  field: 'due' | 'starts_at';
  overdue: boolean;
}

/** Upcoming day for a task or event. Other types return undefined. */
export function scheduleOf(entity: Entity, today: string): ScheduleInfo | undefined {
  const type = entity.metadata.type;
  if (type === 'task') {
    const date = calendarDay(entity.metadata.due ?? entity.metadata.due_date);
    return date ? { date, field: 'due', overdue: date < today } : undefined;
  }
  if (type === 'event') {
    const date = calendarDay(entity.metadata.starts_at);
    return date ? { date, field: 'starts_at', overdue: date < today } : undefined;
  }
  return undefined;
}

/**
 * Upcoming first (soonest date first), then overdue (most recently missed first),
 * then items with no schedule. `tie` breaks equal dates.
 */
export function compareSchedule(a: ScheduleInfo | undefined, b: ScheduleInfo | undefined, tie = 0): number {
  const group = (info: ScheduleInfo | undefined): number => !info ? 2 : info.overdue ? 1 : 0;
  const ga = group(a), gb = group(b);
  if (ga !== gb) return ga - gb;
  if (a && b && a.date !== b.date) return ga === 1 ? b.date.localeCompare(a.date) : a.date.localeCompare(b.date);
  return tie;
}

function calendarDay(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const day = value.slice(0, 10);
  return isIsoDate(day) ? day : undefined;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
