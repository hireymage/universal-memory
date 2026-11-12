import { describe, expect, it } from 'vitest';
import { combinedRank, compareSchedule, DEFAULT_RANK_WEIGHTS, recencyScore, saturatingScore, scheduleOf } from '../src/domain/ranking.js';
import { confidenceScore, parkLowConfidence } from '../src/domain/inbox-policy.js';
import type { Entity } from '../src/domain/types.js';

const entity = (type: string, extra: Record<string, unknown>): Entity => ({
  metadata: {
    id: '1', type, title: 'T', status: 'active', created_at: '', updated_at: '', aliases: [], tags: [], schema_version: 1,
    ...extra,
  },
  content: '', path: 'x.md', revision: 'r', wikilinks: [],
});

describe('ranking', () => {
  it('keeps a strong match ahead of a merely recent one with the default weights', () => {
    const strong = combinedRank({ match: 1, recency: 0, links: 0, usage: 0 }, DEFAULT_RANK_WEIGHTS);
    const recent = combinedRank({ match: 0.5, recency: 1, links: 1, usage: 1 }, DEFAULT_RANK_WEIGHTS);
    expect(strong).toBeGreaterThan(recent);
  });

  it('decays recency and saturates links and usage', () => {
    const now = new Date('2026-11-12T00:00:00.000Z');
    expect(recencyScore('2026-11-12T00:00:00.000Z', now, 30)).toBeCloseTo(1, 5);
    expect(recencyScore('2026-10-13T00:00:00.000Z', now, 30)).toBeCloseTo(0.5, 1);
    expect(saturatingScore(0)).toBe(0);
    expect(saturatingScore(1)).toBeCloseTo(0.5);
    expect(saturatingScore(9)).toBeGreaterThan(0.8);
  });

  it('orders upcoming tasks and events before overdue ones and flags the past', () => {
    const upcoming = scheduleOf(entity('task', { due: '2026-11-13' }), '2026-11-12');
    const overdue = scheduleOf(entity('task', { due: '2026-11-01' }), '2026-11-12');
    const event = scheduleOf(entity('event', { starts_at: '2026-11-12T09:00:00.000Z' }), '2026-11-12');
    expect(upcoming).toMatchObject({ date: '2026-11-13', overdue: false, field: 'due' });
    expect(overdue).toMatchObject({ overdue: true });
    expect(event).toMatchObject({ field: 'starts_at', overdue: false });
    expect(compareSchedule(upcoming, overdue)).toBeLessThan(0);
    expect(compareSchedule(overdue, undefined)).toBeLessThan(0);
  });
});

describe('inbox confidence threshold', () => {
  it('parks only low confidence at the default threshold', () => {
    expect(confidenceScore(null)).toBe(1);
    expect(confidenceScore({ confidence: 'medium' })).toBe(0.6);
    expect(confidenceScore({ confidence: 'low' })).toBe(0.3);
    const clear = parkLowConfidence(
      { type: 'note', title: 'Kafka', metadata: { tags: ['k'] } },
      { confidence: 'medium', suggested_type: 'task' },
    );
    expect(clear.parked).toBe(false);
    expect(clear.draft.type).toBe('note');
    expect(clear.draft.metadata).toEqual({ tags: ['k'] });
    const low = parkLowConfidence(
      { type: 'todo', title: 'Zavolat', metadata: { tags: ['k'] } },
      { confidence: 'low', suggested_type: 'task' },
    );
    expect(low.parked).toBe(true);
    expect(low.draft.type).toBe('inbox');
    expect(low.draft.metadata).toMatchObject({
      tags: ['k'],
      suggested_type: 'task',
      classification_confidence: 0.3,
      requested_type: 'todo',
    });
  });

  it('does not park a confident create when the threshold is raised to catch medium hints', () => {
    const confident = parkLowConfidence({ type: 'note', title: 'Kafka' }, null, 0.95);
    expect(confident.parked).toBe(false);
    expect(confident.draft.type).toBe('note');
  });
});
