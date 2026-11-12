import { isIsoDate, nearestKnownType } from './entity-types.js';
import { todayInPrague } from './name-days.js';
import { stripAccents } from './similarity.js';

/**
 * Inline filters inside one `find` query. Keys and relative words are
 * accent- and case-insensitive, in Czech or English.
 *
 *   typ:úkol  type:task  #tag  osoba:Novák  person:"Jan Novák"
 *   projekt:pamat  project:memory  do:týden  due:week  od:2026-01-01  since:week
 *
 * A colon token whose key is not a filter stays in the text (`14:30`, `n8n:prod`).
 */
export interface DateWindow {
  from: string;
  to: string;
}

export interface ParsedFindQuery {
  text: string;
  types: string[];
  tags: string[];
  person?: string;
  project?: string;
  /** Inclusive calendar window matched against `due` (tasks) or `starts_at` (events). */
  due?: DateWindow;
  /** Inclusive lower bound on `updated_at` (`YYYY-MM-DD`). */
  since?: string;
  /** Type filters that are neither a registry id nor an alias. They do not match anything. */
  unresolvedTypes: string[];
}

const FILTER_KEYS = new Map<string, 'type' | 'person' | 'project' | 'due' | 'since'>([
  ['type', 'type'], ['typ', 'type'],
  ['person', 'person'], ['osoba', 'person'],
  ['project', 'project'], ['projekt', 'project'],
  ['due', 'due'], ['do', 'due'],
  ['since', 'since'], ['od', 'since'],
]);

export function parseFindQuery(input: string, today = todayInPrague()): ParsedFindQuery {
  const types: string[] = [];
  const tags: string[] = [];
  let person: string | undefined;
  let project: string | undefined;
  let due: DateWindow | undefined;
  let since: string | undefined;
  const unresolvedTypes: string[] = [];
  const text: string[] = [];

  const tokens = scanTokens(input);
  for (let index = 0; index < tokens.length; index += 1) {
    let token = tokens[index]!;
    token = absorbSpacedDate(token, tokens, index, (skip) => { index += skip; });
    if (token.startsWith('#') && token.length > 1) {
      tags.push(token.slice(1));
      continue;
    }
    const colon = token.indexOf(':');
    if (colon > 0) {
      const key = FILTER_KEYS.get(stripAccents(token.slice(0, colon)).replace(/[^a-z0-9]+/g, ''));
      const value = token.slice(colon + 1).trim();
      if (key && value) {
        if (key === 'type') {
          for (const part of value.split(',')) {
            const resolved = resolveType(part);
            if (!resolved) continue;
            if (resolved.unresolved) {
              if (!unresolvedTypes.includes(resolved.unresolved)) unresolvedTypes.push(resolved.unresolved);
              continue;
            }
            if (resolved.type && !types.includes(resolved.type)) types.push(resolved.type);
          }
        } else if (key === 'person') person = value;
        else if (key === 'project') project = value;
        else if (key === 'due') {
          const window = dueWindow(value, today);
          if (!window) { text.push(token); continue; }
          due = intersectWindows(due, window);
        } else {
          const bound = sinceBound(value, today);
          if (!bound) { text.push(token); continue; }
          since = laterDate(since, bound);
        }
        continue;
      }
    }
    text.push(token);
  }

  return {
    text: text.join(' ').trim(),
    types,
    tags,
    ...(person ? { person } : {}),
    ...(project ? { project } : {}),
    ...(due ? { due } : {}),
    ...(since ? { since } : {}),
    unresolvedTypes,
  };
}

/** `od:12. 11. 2026` is three tokens. Glue a day, a month, and a year back together. */
function absorbSpacedDate(token: string, tokens: string[], index: number, skip: (count: number) => void): string {
  const colon = token.indexOf(':');
  if (colon <= 0) return token;
  const key = FILTER_KEYS.get(stripAccents(token.slice(0, colon)).replace(/[^a-z0-9]+/g, ''));
  if (key !== 'due' && key !== 'since') return token;
  const value = token.slice(colon + 1).trim();
  const month = tokens[index + 1];
  const year = tokens[index + 2];
  if (/^\d{1,2}\.$/.test(value) && month && year && /^\d{1,2}\.$/.test(month) && /^\d{4}$/.test(year)) {
    skip(2);
    return `${token.slice(0, colon + 1)}${value}${month}${year}`;
  }
  return token;
}

/**
 * Exact registry id or alias only. A near-miss such as `úkoly` is reported
 * unresolved instead of being coerced by similarity or matched as a raw string.
 */
function resolveType(raw: string): { type: string; unresolved?: undefined } | { type?: undefined; unresolved: string } | undefined {
  const name = raw.trim();
  if (!name) return undefined;
  const nearest = nearestKnownType(name);
  if (nearest?.via === 'alias') return { type: nearest.type };
  return { unresolved: name };
}

function dueWindow(value: string, today: string): DateWindow | undefined {
  const word = relativeWord(value);
  if (word === 'today') return { from: today, to: today };
  if (word === 'tomorrow') { const day = addDays(today, 1); return { from: day, to: day }; }
  if (word === 'yesterday') { const day = addDays(today, -1); return { from: day, to: day }; }
  if (word === 'week') return { from: today, to: addDays(today, 7) };
  if (word === 'month') return { from: today, to: addDays(today, 31) };
  const day = looseDate(value);
  if (!day) return undefined;
  // "do <datum>" is "by that day": from today through the date, or that day when it is already past.
  if (day < today) return { from: day, to: day };
  return { from: today, to: day };
}

function sinceBound(value: string, today: string): string | undefined {
  const word = relativeWord(value);
  if (word === 'today') return today;
  if (word === 'yesterday') return addDays(today, -1);
  if (word === 'tomorrow') return addDays(today, 1);
  if (word === 'week') return addDays(today, -7);
  if (word === 'month') return addDays(today, -31);
  return looseDate(value);
}

function relativeWord(value: string): 'today' | 'tomorrow' | 'yesterday' | 'week' | 'month' | undefined {
  const word = stripAccents(value).replace(/[^a-z0-9]+/g, '');
  if (word === 'today' || word === 'dnes' || word === 'dnesek') return 'today';
  if (word === 'tomorrow' || word === 'zitra') return 'tomorrow';
  if (word === 'yesterday' || word === 'vcera') return 'yesterday';
  if (word === 'week' || word === 'tyden' || word === 'tydne') return 'week';
  if (word === 'month' || word === 'mesic' || word === 'mesice') return 'month';
  return undefined;
}

function looseDate(value: string): string | undefined {
  const trimmed = value.trim();
  if (isIsoDate(trimmed)) return trimmed;
  const czech = /^(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})$/.exec(trimmed);
  if (!czech) return undefined;
  const iso = `${czech[3]}-${czech[2]!.padStart(2, '0')}-${czech[1]!.padStart(2, '0')}`;
  return isIsoDate(iso) ? iso : undefined;
}

export function addDays(isoDate: string, days: number): string {
  const next = new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * 86_400_000);
  return next.toISOString().slice(0, 10);
}

function intersectWindows(left: DateWindow | undefined, right: DateWindow | undefined): DateWindow | undefined {
  if (!right) return left;
  if (!left) return right;
  const from = left.from > right.from ? left.from : right.from;
  const to = left.to < right.to ? left.to : right.to;
  return from <= to ? { from, to } : { from, to: from };
}

function laterDate(left: string | undefined, right: string | undefined): string | undefined {
  if (!right) return left;
  if (!left) return right;
  return left > right ? left : right;
}

function scanTokens(input: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < input.length) {
    while (index < input.length && /\s/u.test(input[index]!)) index += 1;
    if (index >= input.length) break;
    let token = '';
    while (index < input.length && !/\s/u.test(input[index]!)) {
      const char = input[index]!;
      if ((char === '"' || char === "'") && (token.endsWith(':') || token.length === 0)) {
        index += 1;
        while (index < input.length && input[index] !== char) {
          token += input[index];
          index += 1;
        }
        if (input[index] === char) index += 1;
        continue;
      }
      token += char;
      index += 1;
    }
    if (token) tokens.push(token);
  }
  return tokens;
}
