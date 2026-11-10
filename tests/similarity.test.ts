import { describe, expect, it } from 'vitest';
import { DEFAULT_SIMILARITY_THRESHOLD, rankSimilar, similarity, tokenize } from '../src/domain/similarity.js';
import { preCreateCheck } from '../src/domain/dedup-check.js';
import type { Entity } from '../src/domain/types.js';

/**
 * Coverage for the search-before-create similarity foundation:
 * normalization (accent strip, compact form), tokenization, the three
 * similarity mechanisms (compact equality, containment, token/numeric
 * overlap), rankSimilar filtering/sorting, and the read-only pre-create
 * decision helper. All fixtures are in-memory; nothing touches a vault.
 */
const entity = (id: string, title: string, type: string, aliases: string[] = [], status = 'active'): Entity => ({
  metadata: {
    id,
    type,
    title,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    aliases,
    tags: [],
    status,
    schema_version: 1,
  },
  content: '',
  path: `entities/${id}.md`,
  revision: 'rev-1',
  wikilinks: [],
});

describe('similarity', () => {
  it('strips accents via NFKD before comparing', () => {
    expect(similarity('Nováková', 'novakova')).toBe(1);
  });

  it('scores compact-form equality as 1', () => {
    expect(similarity('RTX 2070', 'RTX2070')).toBe(1);
  });

  it('scores compact containment as 0.9', () => {
    expect(similarity('M1-256', 'Mac mini M1 256GB')).toBe(0.9);
  });

  it('keeps numeric near-misses below the default threshold', () => {
    const score = similarity('256GB', '512GB');
    expect(score).toBeLessThan(DEFAULT_SIMILARITY_THRESHOLD);
    expect(score).toBeGreaterThan(0);
  });

  it('matches "M1-256" against "Mac mini M1 256GB" above zero', () => {
    expect(similarity('M1-256', 'Mac mini M1 256GB')).toBeGreaterThan(0);
  });

  it('tokenizes mixed alphanumeric runs into whole run plus digit/letter runs', () => {
    expect(tokenize('256GB')).toEqual(['256gb', '256', 'gb']);
    expect(tokenize('M1')).toEqual(['m1', '1', 'm']);
  });

  it('returns 0 for empty or non-alphanumeric input', () => {
    expect(similarity('', 'RTX 2070')).toBe(0);
    expect(similarity('RTX 2070', '   ')).toBe(0);
    expect(similarity('!!!', '---')).toBe(0);
  });
});

describe('rankSimilar', () => {
  const entities = [
    entity('e1', 'Mac mini M1 256GB', 'knowledge', ['M1-256', 'mini']),
    entity('e2', 'RTX 2070 GPU', 'knowledge'),
    entity('e3', 'Mac mini M1 512GB', 'project'),
    entity('e4', 'Mac mini', 'person', [], 'archived'),
  ];

  it('filters by type when types are given', () => {
    const candidates = rankSimilar('Mac mini', entities, { types: ['knowledge'] });
    expect(candidates.map(c => c.entity.metadata.id)).toEqual(['e1']);
  });

  it('excludes archived entities by default and includes them on request', () => {
    const defaultCandidates = rankSimilar('Mac mini', entities);
    expect(defaultCandidates.some(c => c.entity.metadata.id === 'e4')).toBe(false);
    const withArchived = rankSimilar('Mac mini', entities, { includeArchived: true });
    expect(withArchived.some(c => c.entity.metadata.id === 'e4')).toBe(true);
  });

  it('drops candidates below the threshold', () => {
    const candidates = rankSimilar('256GB', [entity('e5', '512GB', 'note')], { threshold: DEFAULT_SIMILARITY_THRESHOLD });
    expect(candidates).toHaveLength(0);
  });

  it('sorts deterministically: score desc, then title asc', () => {
    const candidates = rankSimilar('a', [entity('e6', 'Zebra', 'note'), entity('e7', 'Apple', 'note')]);
    expect(candidates.map(c => c.entity.metadata.title)).toEqual(['Apple', 'Zebra']);
    expect(candidates.every(c => c.score === candidates[0]?.score)).toBe(true);
  });

  it('truncates to limit', () => {
    const candidates = rankSimilar('a', [entity('e6', 'Zebra', 'note'), entity('e7', 'Apple', 'note')], { limit: 1 });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.entity.metadata.title).toBe('Apple');
  });

  it('prefers the best-scoring field and names it in the reason', () => {
    const candidates = rankSimilar('M1-256', [entity('e1', 'Mac mini M1 256GB', 'knowledge', ['M1-256'])]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.score).toBe(1);
    expect(candidates[0]?.reason).toContain('alias');
  });
});

describe('preCreateCheck', () => {
  it('flags an exact compact match as likely_duplicate', () => {
    const result = preCreateCheck('RTX 2070', 'knowledge', [entity('e1', 'RTX2070', 'knowledge')]);
    expect(result.decision).toBe('likely_duplicate');
    expect(result.candidates).toHaveLength(1);
  });

  it('flags containment (0.9) as likely_duplicate', () => {
    const result = preCreateCheck('M1-256', 'knowledge', [entity('e1', 'Mac mini M1 256GB', 'knowledge')]);
    expect(result.decision).toBe('likely_duplicate');
  });

  it('flags a threshold-passing token/numeric match as possible_duplicate', () => {
    const result = preCreateCheck('RTX 2070 GPU', 'knowledge', [entity('e1', 'RTX 2070 Graphics', 'knowledge')]);
    expect(result.candidates[0]?.score).toBeGreaterThanOrEqual(DEFAULT_SIMILARITY_THRESHOLD);
    expect(result.candidates[0]?.score).toBeLessThan(0.9);
    expect(result.decision).toBe('possible_duplicate');
  });

  it('reports no_match when nothing passes the threshold', () => {
    const result = preCreateCheck('256GB', 'note', [entity('e1', '512GB', 'note')]);
    expect(result.decision).toBe('no_match');
    expect(result.candidates).toHaveLength(0);
  });

  it('honours a custom threshold', () => {
    const result = preCreateCheck('RTX 2070 GPU', 'knowledge', [entity('e1', 'RTX 2070 Graphics', 'knowledge')], { threshold: 0.95 });
    expect(result.decision).toBe('no_match');
  });

  it('only considers entities of the requested type', () => {
    const result = preCreateCheck('RTX 2070', 'person', [entity('e1', 'RTX2070', 'knowledge')]);
    expect(result.decision).toBe('no_match');
  });

  it('ignores archived entities unless includeArchived is set', () => {
    const entities = [entity('e1', 'RTX2070', 'knowledge', [], 'archived')];
    expect(preCreateCheck('RTX 2070', 'knowledge', entities).decision).toBe('no_match');
    expect(preCreateCheck('RTX 2070', 'knowledge', entities, { includeArchived: true }).decision).toBe('likely_duplicate');
  });

  it('is read-only: it never mutates the entities it is given', () => {
    const entities = [entity('e1', 'Mac mini M1 256GB', 'knowledge', ['M1-256'])];
    const snapshot = JSON.stringify(entities);
    preCreateCheck('M1-256', 'knowledge', entities);
    expect(JSON.stringify(entities)).toBe(snapshot);
  });
});
