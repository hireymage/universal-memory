import type { NeuralAssociateResponse, NeuralAssociativeMemory, NeuralDocument, NeuralHealth, NeuralHit, NeuralRebuildResponse } from '../../ports/neural.js';

export interface BdhClientOptions {
  baseUrl: string;
  token?: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

const MAX_CONTENT = 80_000;
const REBUILD_CHUNK = 40;

/**
 * HTTP client for the Python BDH sidecar. Every method resolves. A refused
 * connection, a timeout, or a non-2xx response becomes `available: false`
 * so the caller can keep serving Markdown.
 */
export class BdhSidecarClient implements NeuralAssociativeMemory {
  readonly enabled = true;
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly options: BdhClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async upsert(document: NeuralDocument): Promise<void> {
    await this.post('/v1/upsert', boundDocument(document), this.options.timeoutMs);
  }

  async remove(id: string): Promise<void> {
    await this.post('/v1/remove', { id }, this.options.timeoutMs);
  }

  async associate(query: string, limit: number): Promise<NeuralAssociateResponse> {
    const response = await this.post('/v1/associate', { query, limit }, this.options.timeoutMs);
    if (!response.ok) return { available: false, results: [], warning: response.warning };
    const results = Array.isArray(response.body.results) ? response.body.results.flatMap(readHit) : [];
    const vectorResults = Array.isArray(response.body.vector_results) ? response.body.vector_results.flatMap(readHit) : [];
    return {
      available: true,
      results,
      vectorAvailable: response.body.vector_available === true,
      vectorResults,
    };
  }

  async rebuild(documents: NeuralDocument[]): Promise<NeuralRebuildResponse> {
    // A rebuild batch embeds 40 documents on CPU; a 1024-dim model needs far longer than 60 s per batch.
    const timeout = Math.min(600_000, Math.max(this.options.timeoutMs, 15_000));
    const chunks = documents.length ? chunk(documents.map(boundDocument), REBUILD_CHUNK) : [[]];
    let indexed = 0;
    for (let i = 0; i < chunks.length; i++) {
      const batch = chunks[i];
      if (!batch) continue;
      const response = await this.post('/v1/rebuild', { entities: batch, reset: i === 0 }, timeout);
      if (!response.ok) return { available: false, indexed, warning: response.warning };
      indexed = typeof response.body.indexed === 'number' ? response.body.indexed : indexed;
    }
    return { available: true, indexed };
  }

  async health(): Promise<NeuralHealth> {
    const response = await this.post('/health', undefined, this.options.timeoutMs, 'GET');
    if (!response.ok) return { enabled: true, available: false, warning: response.warning };
    return { enabled: true, available: true, entities: typeof response.body.entities === 'number' ? response.body.entities : undefined };
  }

  private async post(path: string, body: unknown, timeoutMs: number, method: 'GET' | 'POST' = 'POST'): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; warning: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = { accept: 'application/json' };
      if (method === 'POST') headers['content-type'] = 'application/json';
      if (this.options.token) headers.authorization = `Bearer ${this.options.token}`;
      const response = await this.fetchImpl(endpoint(this.options.baseUrl, path), {
        method,
        headers,
        body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
        signal: controller.signal,
      });
      const text = await response.text();
      const parsed = parseObject(text);
      if (!response.ok) {
        const message = typeof parsed?.error === 'object' && parsed.error && 'message' in parsed.error ? String((parsed.error as { message?: unknown }).message ?? '') : '';
        return { ok: false, warning: message ? `sidecar HTTP ${response.status}: ${message.slice(0, 200)}` : `sidecar HTTP ${response.status}` };
      }
      return { ok: true, body: parsed ?? {} };
    } catch (error) {
      return { ok: false, warning: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Used when `neural.enabled` is false. No network, no state. */
export class DisabledNeuralMemory implements NeuralAssociativeMemory {
  readonly enabled = false;
  async upsert(): Promise<void> { /* off */ }
  async remove(): Promise<void> { /* off */ }
  async associate(): Promise<NeuralAssociateResponse> {
    return { available: false, results: [], warning: 'Neural associative memory is disabled' };
  }
  async rebuild(): Promise<NeuralRebuildResponse> {
    return { available: false, indexed: 0, warning: 'Neural associative memory is disabled' };
  }
  async health(): Promise<NeuralHealth> {
    return { enabled: false, available: false };
  }
}

function endpoint(base: string, path: string): string {
  const trimmed = base.endsWith('/') ? base : `${base}/`;
  return new URL(path.replace(/^\//, ''), trimmed).toString();
}

function boundDocument(document: NeuralDocument): NeuralDocument {
  return {
    id: document.id,
    title: document.title.slice(0, 500),
    aliases: document.aliases.slice(0, 32).map(alias => alias.slice(0, 200)),
    content: document.content.slice(0, MAX_CONTENT),
    ...(document.revision ? { revision: document.revision } : {}),
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

function parseObject(text: string): Record<string, unknown> | undefined {
  if (!text) return {};
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function readHit(value: unknown): NeuralHit[] {
  if (!value || typeof value !== 'object') return [];
  const hit = value as { id?: unknown; score?: unknown };
  if (typeof hit.id !== 'string' || typeof hit.score !== 'number' || !Number.isFinite(hit.score)) return [];
  return [{ id: hit.id, score: hit.score }];
}
