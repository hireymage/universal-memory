import type { SearchIndex } from '../ports/index.js';
import type { NeuralAssociativeMemory } from '../ports/neural.js';
import type { Entity } from '../domain/types.js';

export type AssociateMode = 'neural' | 'hybrid';
export type AssociateSource = 'neural' | 'lexical' | 'both';

export interface AssociatedEntity {
  id: string;
  score: number;
  source: AssociateSource;
  title?: string;
  path?: string;
  type?: string;
  status?: string;
  revision?: string;
  snippet?: string;
}

export interface AssociateResult {
  advisory: true;
  note: string;
  method: 'bdh-hebbian-v1';
  enabled: boolean;
  available: boolean;
  degraded: boolean;
  mode: AssociateMode;
  query: string;
  warning?: string;
  results: AssociatedEntity[];
}

const ADVISORY = 'Advisory only: hits are learned associations from the experimental BDH layer, not verified facts and not a substring search. Read the Markdown before asserting anything.';
const DISABLED = 'Neural associative memory is disabled. No associations were computed.';
const DEGRADED = 'Neural associative memory is enabled but the sidecar did not answer. No associations were computed.';
const HYBRID_DEGRADED = 'Neural associative memory is enabled but the sidecar did not answer. Results are local substring matches only.';

/**
 * Turns sidecar ids into entity summaries and, in hybrid mode, merges them
 * with the existing substring index. The sidecar is never required.
 */
export class NeuralMemoryService {
  constructor(
    private readonly neural: NeuralAssociativeMemory,
    private readonly index: SearchIndex,
    private readonly lookup: (id: string) => Promise<Entity | undefined>,
  ) {}

  async associate(query: string, limit = 10, mode: AssociateMode = 'neural'): Promise<AssociateResult> {
    const bounded = Math.min(Math.max(limit, 1), 50);
    if (!this.neural.enabled) return this.empty(query, mode, false, false, DISABLED);
    const neural = await this.neural.associate(query, bounded);
    if (!neural.available && mode === 'neural') return this.empty(query, mode, true, true, DEGRADED, neural.warning);
    const lexical = mode === 'hybrid' ? await this.index.search({ query, limit: bounded }) : [];
    const rows = new Map<string, { id: string; neural?: number; lexical?: number; entity?: Entity }>();
    if (neural.available) {
      for (const hit of neural.results) rows.set(hit.id, { id: hit.id, neural: hit.score });
    }
    lexical.forEach((entity, index) => {
      const row = rows.get(entity.metadata.id) ?? { id: entity.metadata.id };
      row.lexical = Number((1 - index / Math.max(lexical.length, 1)).toFixed(4));
      row.entity = entity;
      rows.set(entity.metadata.id, row);
    });
    const ranked = [...rows.values()]
      .map(row => ({ row, score: blend(row.neural, row.lexical, mode) }))
      .sort((a, b) => b.score - a.score || a.row.id.localeCompare(b.row.id))
      .slice(0, bounded);
    const results: AssociatedEntity[] = [];
    for (const item of ranked) {
      const entity = item.row.entity ?? await this.lookup(item.row.id).catch(() => undefined);
      results.push(present(item.row.id, item.score, sourceOf(item.row.neural, item.row.lexical), entity));
    }
    const degraded = !neural.available;
    return {
      advisory: true,
      note: degraded ? HYBRID_DEGRADED : ADVISORY,
      method: 'bdh-hebbian-v1',
      enabled: true,
      available: neural.available,
      degraded,
      mode,
      query,
      ...(neural.warning && degraded ? { warning: neural.warning } : {}),
      results,
    };
  }

  private empty(query: string, mode: AssociateMode, enabled: boolean, degraded: boolean, note: string, warning?: string): AssociateResult {
    return {
      advisory: true, note, method: 'bdh-hebbian-v1', enabled, available: false, degraded, mode, query,
      ...(warning ? { warning } : {}),
      results: [],
    };
  }
}

function blend(neural: number | undefined, lexical: number | undefined, mode: AssociateMode): number {
  if (mode === 'neural') return neural ?? 0;
  // Lexical hits are a small tie-break. A learned association outranks a
  // substring hit that the synapses never connected.
  return Number(((neural ?? 0) + (lexical !== undefined ? lexical * 0.25 : 0)).toFixed(6));
}

function sourceOf(neural: number | undefined, lexical: number | undefined): AssociateSource {
  if (neural !== undefined && lexical !== undefined) return 'both';
  return neural !== undefined ? 'neural' : 'lexical';
}

function present(id: string, score: number, source: AssociateSource, entity: Entity | undefined): AssociatedEntity {
  if (!entity) return { id, score, source };
  const snippet = entity.content.replace(/\s+/g, ' ').trim().slice(0, 240);
  return {
    id, score, source,
    title: entity.metadata.title,
    path: entity.path,
    type: entity.metadata.type,
    status: entity.metadata.status,
    revision: entity.revision,
    ...(snippet ? { snippet } : {}),
  };
}
