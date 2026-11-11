import { describe, expect, it } from 'vitest';
import { calendarWindow, namesOn, resolveWindow, todayInPrague } from '../src/domain/name-days.js';

describe('Czech name-day calendar', () => {
  it('has the expected names for fixed dates', () => {
    expect(namesOn('2026-11-11')).toEqual(['Martin']);
    expect(namesOn('2026-12-24')).toEqual(['Adam', 'Eva']);
    expect(namesOn('2026-02-29')).toEqual(['Horymír']);
    expect(namesOn('2026-01-01')).toEqual([]);
  });

  it('covers a leap day and a year-end window across the boundary', () => {
    const window = calendarWindow('2027-12-30', '2028-01-02');
    expect(window.map(day => day.date)).toEqual(['2027-12-30', '2027-12-31', '2028-01-01', '2028-01-02']);
    expect(calendarWindow('2028-02-28', '2028-03-01').map(day => day.date)).toEqual(['2028-02-28', '2028-02-29', '2028-03-01']);
  });
});

describe('name-day query resolution', () => {
  const today = '2026-11-11';

  it('uses today when called without arguments', () => {
    expect(resolveWindow({}, today)).toEqual({ from: today, to: today });
  });

  it('accepts a single date', () => {
    expect(resolveWindow({ date: '2026-12-24' }, today)).toEqual({ from: '2026-12-24', to: '2026-12-24' });
  });

  it('treats from without to as one day and keeps explicit ranges', () => {
    expect(resolveWindow({ from: '2026-11-11' }, today)).toEqual({ from: '2026-11-11', to: '2026-11-11' });
    expect(resolveWindow({ from: '2026-11-10', to: '2026-11-12' }, today)).toEqual({ from: '2026-11-10', to: '2026-11-12' });
  });

  it('rejects an inverted or oversized range', () => {
    expect(() => resolveWindow({ from: '2026-11-12', to: '2026-11-10' }, today)).toThrow();
    expect(() => resolveWindow({ from: '2026-01-01', to: '2027-12-31' }, today)).toThrow();
  });

  it('reports the current day in Europe/Prague', () => {
    // 2026-11-10 23:30 UTC is already 2026-11-11 in Prague (UTC+1).
    expect(todayInPrague(new Date('2026-11-10T23:30:00Z'))).toBe('2026-11-11');
  });
});
