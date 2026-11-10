import type { SearchIndex } from '../ports/index.js';
import type { Entity } from '../domain/types.js';
import { MemoryError } from '../domain/errors.js';
import { MemoryService } from './memory-service.js';
import { resolveCreateSourceIdentity, type SourceIdentityType } from '../domain/source-identity.js';

export interface CreateSourceInput {
  title: string;
  provider: string;
  /**
   * Phase-3C VARIANTA B: typed identity. A web-URL source is
   * `identity_type: 'url'` + `identity_value: <URL>` — a web URL must never
   * travel in `conversation_id` (§2/§4). Omitted: the legacy shapes
   * `conversation_id` / `content_hash` keep working (§8).
   */
  identity_type?: SourceIdentityType;
  identity_value?: string;
  conversation_id?: string;
  content_hash?: string;
  original_file?: string;
  message_range?: unknown;
  url?: string;
  content?: string;
  metadata?: Record<string, unknown>;
  /** `return_existing` makes an import idempotent: re-importing the same conversation reuses the stored source. */
  if_exists?: 'error' | 'return_existing';
}

export class SourceService {
  constructor(private readonly memory: MemoryService, private readonly index: SearchIndex) {}

  async createSource(input: CreateSourceInput, client?: string): Promise<unknown> {
    const provider = input.provider?.trim() ?? '';
    if (!provider) throw new MemoryError('VALIDATION_ERROR', 'provider must not be empty');
    // VARIANTA B: identity resolution validates every forbidden shape here —
    // URL in `conversation_id`, unknown identity_type, url identity carrying
    // a conversation_id (§2/§4).
    const { identity } = resolveCreateSourceIdentity({
      identity_type: input.identity_type, identity_value: input.identity_value,
      conversation_id: input.conversation_id, content_hash: input.content_hash,
    });
    const legacyFields =
      identity.identity_type === 'conversation' ? { conversation_id: identity.identity_value } :
      identity.identity_type === 'content_hash' ? { content_hash: identity.identity_value } : {};
    const existing = await this.index.findSources({ provider, identity_type: identity.identity_type, identity_value: identity.identity_value });
    if (existing.length) {
      if (input.if_exists === 'return_existing') return this.sourceResult(existing[0]!, false);
      throw new MemoryError('CONFLICT', `Source already exists for ${provider}`, { found: existing.map(source => source.metadata.id) });
    }
    const source = await this.memory.create({
      type: 'source',
      title: input.title,
      content: input.content ?? '',
      metadata: {
        ...input.metadata,
        provider,
        identity_type: identity.identity_type,
        identity_value: identity.identity_value,
        ...legacyFields,
        ...(input.original_file ? { original_file: input.original_file } : {}),
        ...(input.message_range !== undefined ? { message_range: input.message_range } : {}),
        // `url` stays a passthrough/descriptor field. It mirrors the canonical
        // url identity when one exists; it is never an identity key (§14).
        ...(identity.identity_type === 'url' ? { url: identity.identity_value } : input.url ? { url: input.url } : {}),
      },
    }, client);
    return this.sourceResult(source, true);
  }

  async getSource(id: string): Promise<unknown> {
    const entity = await this.memory.get(id);
    if (entity.metadata.type !== 'source') throw new MemoryError('NOT_FOUND', `Entity is not a source: ${id}`);
    return this.sourceResult(entity, undefined);
  }

  async findSource(filter: {
    provider: string; conversation_id?: string; content_hash?: string;
    identity_type?: string; identity_value?: string;
  }): Promise<unknown[]> {
    if (!filter.provider?.trim()) throw new MemoryError('VALIDATION_ERROR', 'provider must not be empty');
    if (filter.identity_type === undefined
      && !filter.conversation_id && !filter.content_hash)
      throw new MemoryError('VALIDATION_ERROR', 'Find by identity_type+identity_value, conversation_id, or content_hash');
    return (await this.index.findSources(filter)).map(source => this.sourceResult(source, undefined));
  }

  private sourceResult(entity: Entity, created?: boolean): unknown {
    const metadata = entity.metadata;
    return {
      id: metadata.id, title: metadata.title, path: entity.path, revision: entity.revision,
      provider: metadata.provider, identity_type: metadata.identity_type, identity_value: metadata.identity_value,
      conversation_id: metadata.conversation_id, content_hash: metadata.content_hash,
      original_file: metadata.original_file, message_range: metadata.message_range, url: metadata.url,
      ...(created === undefined ? {} : { created }),
    };
  }
}