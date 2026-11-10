/**
 * Source identity, Phase-3C VARIANTA B (typed identity).
 *
 * A source identity is the canonical triple
 * (provider, identity_type, identity_value). Two sources are the same source
 * exactly when their triples are equal — identity lookup, never ULID
 * comparison, must make a duplicate impossible (§7).
 *
 * Legacy compatibility (§8): sources created before the typed fields existed
 * normalize from `conversation_id` → ('conversation', value) and
 * `content_hash` → ('content_hash', value). Web provenance (§2/§4/§14):
 * a URL identity is `identity_type: 'url'` only — a web URL must never be
 * written into `conversation_id`, and a conversation identity must never
 * hold an http(s) URL.
 */
import { MemoryError } from './errors.js';

export type SourceIdentityType = 'conversation' | 'content_hash' | 'url';

export interface SourceIdentity {
  provider: string;
  identity_type: SourceIdentityType;
  identity_value: string;
}

/** Minimal deterministic URL canonicalization (§6): surrounding whitespace
 * is trimmed, nothing else. No query-parameter stripping, no aggressive
 * normalization, no scheme/host case rewriting — two URLs that differ beyond
 * surrounding whitespace stay two identities (the safe direction: dedup can
 * miss, never falsely merge). */
export const canonicalizeUrl = (raw: string): string => raw.trim();

const isHttpUrl = (value: string): boolean => /^https?:\/\/\S+$/i.test(value);

export const looksLikeHttpUrl = isHttpUrl;

/** Identity of a stored (or candidate) source. Legacy single-key shapes
 * normalize into the typed triple space so old and new rows dedup together. */
export function sourceIdentity(metadata: Record<string, unknown>): SourceIdentity | undefined {
  const provider = typeof metadata.provider === 'string' ? metadata.provider.trim().toLowerCase() : '';
  if (!provider) return undefined;
  const identityType = typeof metadata.identity_type === 'string' ? metadata.identity_type : '';
  const identityValue = typeof metadata.identity_value === 'string' ? metadata.identity_value : '';
  if (identityType) {
    if (identityType === 'conversation' || identityType === 'content_hash' || identityType === 'url') {
      if (!identityValue.trim()) return undefined;
      return { provider, identity_type: identityType, identity_value: identityType === 'url' ? canonicalizeUrl(identityValue) : identityValue.trim() };
    }
    return undefined; // unknown typed identity is outside the dedup space, never merged
  }
  if (typeof metadata.conversation_id === 'string' && metadata.conversation_id.trim())
    return { provider, identity_type: 'conversation', identity_value: metadata.conversation_id.trim() };
  if (typeof metadata.content_hash === 'string' && metadata.content_hash.trim())
    return { provider, identity_type: 'content_hash', identity_value: metadata.content_hash.trim() };
  return undefined;
}

/** Resolve the identity a create-input asks for, legacy or typed. Throws
 * MemoryError('VALIDATION_ERROR') for every forbidden shape:
 * unknown identity_type, empty identity_value, an http(s) URL in
 * `conversation_id` (VARIANTA B, §2/§4), or a url identity carrying a
 * conversation_id. */
export function resolveCreateSourceIdentity(input: {
  identity_type?: unknown; identity_value?: unknown;
  conversation_id?: unknown; content_hash?: unknown;
}): { identity: SourceIdentity; fields: { identity_type: SourceIdentityType; identity_value: string } } {
  const conversationId = typeof input.conversation_id === 'string' ? input.conversation_id.trim() : '';
  const contentHash = typeof input.content_hash === 'string' ? input.content_hash.trim() : '';
  const identityType = typeof input.identity_type === 'string' ? input.identity_type.trim() : '';

  if (identityType) {
    if (identityType !== 'conversation' && identityType !== 'content_hash' && identityType !== 'url')
      throw new MemoryError('VALIDATION_ERROR', `identity_type must be 'conversation', 'content_hash', or 'url', got: ${identityType}`);
    const identityValue = typeof input.identity_value === 'string' ? input.identity_value.trim() : '';
    if (!identityValue) throw new MemoryError('VALIDATION_ERROR', `identity_type '${identityType}' requires a non-empty identity_value`);
    if (identityType === 'url') {
      if (conversationId) throw new MemoryError('VALIDATION_ERROR', 'identity_type url must not carry conversation_id — web URLs are forbidden in the conversation_id slot (Phase-3C VARIANTA B)');
      if (!isHttpUrl(canonicalizeUrl(identityValue))) throw new MemoryError('VALIDATION_ERROR', `identity_type 'url' requires an http(s) URL, got: ${identityValue}`);
      return { identity: { provider: '', identity_type: 'url', identity_value: canonicalizeUrl(identityValue) }, fields: { identity_type: 'url', identity_value: canonicalizeUrl(identityValue) } };
    }
    return { identity: { provider: '', identity_type: identityType, identity_value: identityValue }, fields: { identity_type: identityType, identity_value: identityValue } };
  }

  if (conversationId) {
    if (isHttpUrl(canonicalizeUrl(conversationId)))
      throw new MemoryError('VALIDATION_ERROR', 'conversation_id must not hold an http(s) URL — use identity_type: url for web provenance (Phase-3C VARIANTA B)');
    return { identity: { provider: '', identity_type: 'conversation', identity_value: conversationId }, fields: { identity_type: 'conversation', identity_value: conversationId } };
  }
  if (contentHash)
    return { identity: { provider: '', identity_type: 'content_hash', identity_value: contentHash }, fields: { identity_type: 'content_hash', identity_value: contentHash } };
  throw new MemoryError('VALIDATION_ERROR', 'A source needs identity_type+identity_value, or conversation_id or content_hash to be findable');
}