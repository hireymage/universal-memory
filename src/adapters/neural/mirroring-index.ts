import type { AliasCollision, ArchivedVisibility, ResolveCandidate, SearchIndex, SourceFilter } from '../../ports/index.js';
import type { NeuralAssociativeMemory, NeuralDocument } from '../../ports/neural.js';
import type { Entity, RelationEdge, SearchQuery } from '../../domain/types.js';

/**
 * Decorates the disposable search index with a best-effort copy into the
 * neural sidecar. The inner index is updated first. A sidecar failure is
 * swallowed: Markdown writes must not depend on PyTorch being up.
 */
export class MirroringIndex implements SearchIndex {
  constructor(private readonly inner: SearchIndex, private readonly neural: NeuralAssociativeMemory) {}

  async rebuild(source: AsyncIterable<Entity>): Promise<{ indexed: number; neural_indexed?: number; neural_available?: boolean }> {
    const mirrored: Entity[] = [];
    const result = await this.inner.rebuild((async function* tee() {
      for await (const entity of source) {
        mirrored.push(entity);
        yield entity;
      }
    })());
    const neural = await this.safeRebuild(mirrored.map(toDocument));
    if (!neural.available && neural.warning) process.stderr.write(`Neural memory reindex skipped: ${neural.warning}\n`);
    return { indexed: result.indexed, neural_indexed: neural.indexed, neural_available: neural.available };
  }

  async upsert(entity: Entity): Promise<void> {
    await this.inner.upsert(entity);
    await this.neural.upsert(toDocument(entity)).catch(() => undefined);
  }

  async remove(id: string): Promise<void> {
    await this.inner.remove(id);
    await this.neural.remove(id).catch(() => undefined);
  }

  search(query: SearchQuery): Promise<Entity[]> { return this.inner.search(query); }
  findById(id: string): Promise<{ path: string; revision: string } | undefined> { return this.inner.findById(id); }
  backlinks(titleOrAlias: string): Promise<Entity[]> { return this.inner.backlinks(titleOrAlias); }
  linksFrom(id: string): Promise<string[]> { return this.inner.linksFrom(id); }
  dateWindow(field: 'birth_date' | 'name_day', from: string, to: string, visibility?: ArchivedVisibility): Promise<Entity[]> { return this.inner.dateWindow(field, from, to, visibility); }
  resolveLookup(raw: string, visibility?: ArchivedVisibility): Promise<ResolveCandidate[]> { return this.inner.resolveLookup(raw, visibility); }
  edgesFrom(id: string): Promise<RelationEdge[]> { return this.inner.edgesFrom(id); }
  edgesTo(id: string): Promise<RelationEdge[]> { return this.inner.edgesTo(id); }
  aliasCollisions(visibility?: ArchivedVisibility): Promise<AliasCollision[]> { return this.inner.aliasCollisions(visibility); }
  findSources(filter: SourceFilter): Promise<Entity[]> { return this.inner.findSources(filter); }

  private async safeRebuild(documents: NeuralDocument[]) {
    try { return await this.neural.rebuild(documents); }
    catch (error) { return { available: false, indexed: 0, warning: error instanceof Error ? error.message : String(error) }; }
  }
}

export function toDocument(entity: Entity): NeuralDocument {
  return {
    id: entity.metadata.id,
    title: entity.metadata.title,
    aliases: entity.metadata.aliases,
    content: entity.content,
    revision: entity.revision,
  };
}
