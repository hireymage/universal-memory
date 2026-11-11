import { describe, expect, it } from 'vitest';
import { InMemoryIndex } from '../src/adapters/index/in-memory-index.js';
import { NeuralMemoryService } from '../src/application/neural-memory-service.js';
import type { NeuralAssociativeMemory } from '../src/ports/neural.js';
import type { Entity } from '../src/domain/types.js';

function entity(id: string, title: string): Entity {
  return {
    metadata: {
      id, type: 'note', title, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
      aliases: [], tags: [], status: 'active', schema_version: 1,
    },
    content: `${title} body`, path: `Notes/${id}.md`, revision: `rev-${id}`, wikilinks: [],
  };
}

function neuralWith(response: Partial<Awaited<ReturnType<NeuralAssociativeMemory['associate']>>>): NeuralAssociativeMemory {
  return {
    enabled: true,
    async upsert() { /* unused */ },
    async remove() { /* unused */ },
    async associate() { return { available: true, results: [], ...response }; },
    async rebuild() { return { available: true, indexed: 0 }; },
    async health() { return { enabled: true, available: true }; },
  };
}

describe('vector recall as a third result list', () => {
  const notes = new Map([['v1', entity('v1', 'Database decision')]]);
  const lookup = async (id: string) => notes.get(id);

  it('returns vector hits with source "vector" and keeps the neural list separate', async () => {
    const service = new NeuralMemoryService(
      neuralWith({ results: [{ id: 'n1', score: 0.4 }], vectorAvailable: true, vectorResults: [{ id: 'v1', score: 0.87 }] }),
      new InMemoryIndex(),
      lookup,
    );
    const out = await service.associate('which database', 5, 'neural');
    expect(out.vector_available).toBe(true);
    expect(out.vector_results).toEqual([
      expect.objectContaining({ id: 'v1', score: 0.87, source: 'vector', title: 'Database decision' }),
    ]);
    expect(out.results.map(r => r.id)).toEqual(['n1']);
  });

  it('reports vectors unavailable when the sidecar has them off', async () => {
    const service = new NeuralMemoryService(neuralWith({ results: [] }), new InMemoryIndex(), lookup);
    const out = await service.associate('anything', 5, 'neural');
    expect(out.vector_available).toBe(false);
    expect(out.vector_results).toEqual([]);
  });

  it('empty answers carry the vector fields too', async () => {
    const service = new NeuralMemoryService(
      { ...neuralWith({}), async associate() { return { available: false, results: [], warning: 'down' }; } },
      new InMemoryIndex(),
      lookup,
    );
    const out = await service.associate('x', 5, 'neural');
    expect(out.available).toBe(false);
    expect(out.vector_results).toEqual([]);
  });
});
