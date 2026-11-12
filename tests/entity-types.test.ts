import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import {
  ENTITY_TYPES,
  defaultRoutes,
  isInvalidDate,
  isIsoDate,
  isIsoDateTime,
  isMonthDay,
  nearestKnownType,
  normalizeTags,
} from '../src/domain/entity-types.js';
import { compactForm } from '../src/domain/similarity.js';

describe('entity type registry', () => {
  it('routes the types classification and distill mention', () => {
    const routes = defaultRoutes();
    for (const type of ['event', 'preference', 'fact', 'topic', 'conversation', 'task', 'idea', 'decision', 'person']) {
      expect(routes[type]?.path, type).toMatch(/\.md$/);
    }
  });

  it('resolves aliases and near-misses, and ignores a short accidental containment', () => {
    expect(nearestKnownType('todo')).toEqual({ type: 'task', via: 'alias', score: 1 });
    expect(nearestKnownType('Úkol')).toEqual({ type: 'task', via: 'alias', score: 1 });
    expect(nearestKnownType('preferences')?.type).toBe('preference');
    expect(nearestKnownType('preferences')?.via).toBe('similarity');
    expect(nearestKnownType('project_decisions')?.type).toBe('project_decision');
    expect(nearestKnownType('widget')).toBeUndefined();
    expect(nearestKnownType('art')).toBeUndefined();
    expect(nearestKnownType('NOTE')?.type).toBe('note');
  });

  it('rejects non-ISO dates and accepts real calendar dates', () => {
    expect(isIsoDate('1990-05-12')).toBe(true);
    expect(isIsoDate('2023-02-29')).toBe(false);
    expect(isIsoDate('2024-02-29')).toBe(true);
    expect(isIsoDate('12.5.1990')).toBe(false);
    expect(isMonthDay('05-12')).toBe(true);
    expect(isMonthDay('02-29')).toBe(true);
    expect(isMonthDay('02-30')).toBe(false);
    expect(isMonthDay('32-13')).toBe(false);
    expect(isIsoDateTime('2026-11-12T14:30:00Z')).toBe(true);
    expect(isIsoDateTime('2026-11-12')).toBe(true);
    expect(isIsoDateTime('v pátek')).toBe(false);
    expect(isInvalidDate('12.5.1990', 'date')).toBe(true);
    expect(isInvalidDate(null, 'date')).toBe(false);
  });

  it('matches docker and strata routes to the registry, and keeps the example routes present', () => {
    const defaults = defaultRoutes();
    for (const file of ['config.docker.yml', 'config.strata.yml']) {
      const routing = (YAML.parse(readFileSync(file, 'utf8')) as { routing: Record<string, { path: string }> }).routing;
      expect(Object.keys(routing).sort(), file).toEqual(ENTITY_TYPES.map(spec => spec.type).sort());
      for (const spec of ENTITY_TYPES) expect(routing[spec.type]?.path, `${file} ${spec.type}`).toBe(defaults[spec.type]?.path);
    }
    const example = (YAML.parse(readFileSync('config.example.yml', 'utf8')) as { routing: Record<string, { path: string }> }).routing;
    for (const type of ['event', 'preference', 'fact', 'topic', 'conversation', 'task', 'idea', 'decision', 'person', 'note', 'memory']) {
      expect(example[type]?.path, type).toMatch(/\.md$/);
    }
  });

  it('normalizes tag case and duplicates without stripping Czech letters', () => {
    expect(normalizeTags(['Rodina', 'rodina', '  Kafka ', ''])).toEqual({ tags: ['rodina', 'kafka'], changed: true });
    expect(normalizeTags(['příbuzní'])).toEqual({ tags: ['příbuzní'], changed: false });
    expect(compactForm('Novák')).toBe(compactForm('Novak'));
    expect(compactForm('Éva Nováková')).toBe('evanovakova');
  });
});
