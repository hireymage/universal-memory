import { describe, expect, it } from 'vitest';
import { normalizeDraft, normalizeMetadata, writeWarnings } from '../src/domain/write-guard.js';

describe('frontmatter synonyms', () => {
  it('renames deadline, narozeniny, and svatek and folds tags', () => {
    const normalized = normalizeMetadata({
      deadline: '2026-12-01',
      narozeniny: '1980-05-02',
      Svátek: '05-02',
      tags: ['Rodina', 'rodina', '  '],
    });
    expect(normalized.metadata).toMatchObject({
      due: '2026-12-01',
      birth_date: '1980-05-02',
      name_day: '05-02',
      tags: ['rodina'],
    });
    expect(normalized.metadata).not.toHaveProperty('deadline');
    expect(normalized.metadata).not.toHaveProperty('narozeniny');
    expect(normalized.metadata).not.toHaveProperty('Svátek');
    expect(normalized.changes).toEqual(expect.arrayContaining([
      { kind: 'key', from: 'deadline', to: 'due' },
      { kind: 'key', from: 'narozeniny', to: 'birth_date' },
      { kind: 'key', from: 'Svátek', to: 'name_day' },
      { kind: 'tag', from: 'Rodina', to: 'rodina' },
    ]));
    expect(normalized.conflicts).toEqual([]);
  });

  it('keeps both keys when a synonym disagrees with the canonical value', () => {
    const normalized = normalizeMetadata({ due: '2026-12-01', deadline: '2026-12-24' });
    expect(normalized.metadata.due).toBe('2026-12-01');
    expect(normalized.metadata.deadline).toBe('2026-12-24');
    expect(normalized.conflicts).toEqual([{ from: 'deadline', to: 'due' }]);
    expect(normalizeDraft({ type: 'task', title: 'Úkol', metadata: normalized.metadata }).draft.metadata?.deadline).toBe('2026-12-24');
  });
});

describe('pre-write warnings', () => {
  it('uses health-check severity for required fields and invalid dates', () => {
    const warnings = writeWarnings({
      type: 'project_decision',
      title: 'Zvolit Postgres',
      content: 'Delší zdůvodnění, které už není podezřele krátké a má větu.',
      metadata: { decided_at: 'zítra', project_slug: 'pamat' },
    });
    expect(warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'MISSING_FRONTMATTER', severity: 'error', field: 'project_id' }),
      expect.objectContaining({ code: 'INVALID_DATE', severity: 'error', field: 'decided_at' }),
    ]));
    const expected = warnings.find(warning => warning.field === 'decided_at' && warning.code === 'MISSING_FRONTMATTER');
    expect(expected).toBeUndefined();
  });

  it('warns on expected fields, title length, short content, and a likely duplicate', () => {
    const warnings = writeWarnings({
      type: 'task',
      title: '',
      content: 'x',
      metadata: {},
      duplicates: [{ id: '01TASK', score: 0.95, via: 'title' }, { id: '01VEC', score: 0.9, via: 'vector' }, { id: '01WEAK', score: 0.4, via: 'vector' }],
      conflicts: [{ from: 'deadline', to: 'due' }],
    });
    expect(warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'MISSING_FRONTMATTER', severity: 'warning', field: 'due' }),
      expect.objectContaining({ code: 'TITLE_EMPTY', severity: 'warning' }),
      expect.objectContaining({ code: 'SHORT_CONTENT', severity: 'warning' }),
      expect.objectContaining({ code: 'DUPLICATE_TITLE', severity: 'warning', candidate_id: '01TASK' }),
      expect.objectContaining({ code: 'VECTOR_SIMILARITY', severity: 'warning', candidate_id: '01VEC' }),
      expect.objectContaining({ code: 'SYNONYM_CONFLICT', severity: 'warning' }),
    ]));
    expect(warnings.some(warning => warning.candidate_id === '01WEAK')).toBe(false);
    const long = writeWarnings({
      type: 'note',
      title: 'N'.repeat(181),
      content: 'Dostatek textu, aby krátký obsah nehlásil varování navíc.',
      metadata: {},
    });
    expect(long).toEqual([expect.objectContaining({ code: 'TITLE_TOO_LONG', severity: 'warning' })]);
  });
});
