import { CZECH_NAME_DAYS } from './name-days-data.js';
import { MemoryError } from './errors.js';

/** Czech name days for an ISO date (YYYY-MM-DD). Days without a name return []. */
export function namesOn(isoDate: string): string[] {
  return [...(CZECH_NAME_DAYS[isoDate.slice(5)] ?? [])];
}

/** Today's ISO date in Europe/Prague. */
export function todayInPrague(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

const MAX_DAYS = 366;

function dayCount(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

/**
 * Resolves the query: `date` wins; otherwise `from` (default: today) and `to`
 * (default: `from`). A single `from` is one day.
 */
export function resolveWindow(input: { date?: string; from?: string; to?: string }, today: string): { from: string; to: string } {
  const from = input.date ?? input.from ?? today;
  const to = input.date ?? input.to ?? from;
  if (from > to) throw new MemoryError('VALIDATION_ERROR', 'from must not be after to');
  if (dayCount(from, to) > MAX_DAYS) throw new MemoryError('VALIDATION_ERROR', `range must not exceed ${MAX_DAYS} days`);
  return { from, to };
}

/** Calendar entries for every day in the inclusive window, crossing year ends if needed. */
export function calendarWindow(from: string, to: string): Array<{ date: string; names: string[] }> {
  const out: Array<{ date: string; names: string[] }> = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
    const date = new Date(t).toISOString().slice(0, 10);
    out.push({ date, names: namesOn(date) });
  }
  return out;
}
