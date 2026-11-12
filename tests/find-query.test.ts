import { describe, expect, it } from 'vitest';
import { parseFindQuery } from '../src/domain/find-query.js';

const today = '2026-11-12';

describe('find query filters', () => {
  it('resolves Czech and English type aliases and ignores accents', () => {
    expect(parseFindQuery('typ:úkol koupit mléko', today)).toMatchObject({ text: 'koupit mléko', types: ['task'] });
    expect(parseFindQuery('type:task', today).types).toEqual(['task']);
    expect(parseFindQuery('TYP:Ukol', today).types).toEqual(['task']);
    expect(parseFindQuery('typ:poznámka,úkol', today).types).toEqual(['note', 'task']);
  });

  it('parses tags, person, and project in either language', () => {
    const parsed = parseFindQuery('osoba:"Jan Novák" projekt:Paměť #Práce schůzka', today);
    expect(parsed.person).toBe('Jan Novák');
    expect(parsed.project).toBe('Paměť');
    expect(parsed.tags).toEqual(['Práce']);
    expect(parsed.text).toBe('schůzka');
    expect(parseFindQuery('person:Novak project:memory', today)).toMatchObject({ person: 'Novak', project: 'memory', text: '' });
  });

  it('parses due and since windows in Czech and English', () => {
    expect(parseFindQuery('do:týden', today).due).toEqual({ from: '2026-11-12', to: '2026-11-19' });
    expect(parseFindQuery('due:week', today).due).toEqual({ from: '2026-11-12', to: '2026-11-19' });
    expect(parseFindQuery('do:dnes', today).due).toEqual({ from: today, to: today });
    expect(parseFindQuery('due:2026-11-20', today).due).toEqual({ from: '2026-11-12', to: '2026-11-20' });
    expect(parseFindQuery('od:12. 11. 2026', today).since).toBe('2026-11-12');
    expect(parseFindQuery('since:week', today).since).toBe('2026-11-05');
    expect(parseFindQuery('od:mesic', today).since).toBe('2026-10-12');
  });

  it('leaves non-filter colons in the text', () => {
    expect(parseFindQuery('schůzka 14:30 n8n:prod', today).text).toBe('schůzka 14:30 n8n:prod');
    expect(parseFindQuery('do:not-a-date mléko', today).text).toBe('do:not-a-date mléko');
  });
});
