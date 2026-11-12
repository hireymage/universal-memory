import { MemoryError } from '../domain/errors.js';
import { parseTranscriptMessages, planChunks, renderChunkText } from '../domain/session-chunks.js';
import type { MemoryService } from './memory-service.js';

/**
 * Stateless paging over a stored source transcript for distillation.
 * The caller passes back `next_cursor` to continue; the server keeps no state.
 *
 * Each chunk also carries:
 * - `candidates`: existing entities that the chunk's key terms match, so the
 *   caller links to them instead of creating duplicates;
 * - `procedure`: the exact write steps, so a small model can follow them
 *   without extra reasoning about the MCP itself.
 */

export interface CandidateEntity {
  id: string;
  type: string;
  title: string;
  path: string;
  matched_terms: string[];
}

export interface DistillChunkResult {
  source_id: string;
  title: string;
  chunk: number;
  total_chunks: number;
  from_message: number;
  to_message: number;
  next_cursor: number | null;
  done: boolean;
  procedure: string[];
  candidates: CandidateEntity[];
  text: string;
}

export const DISTILL_PROCEDURE: string[] = [
  '1. Read `text`. Note only facts, decisions, statuses and open items. Skip greetings and tool chatter, but keep short replies such as "ano" together with the question they answer.',
  '2. For each note, check `candidates`. If one of them is about the same subject, write the new fact into it with create_claim (entity_id = candidate.id, source_ids = [source_id]). Do not create a second entity for the same subject.',
  '3. If no candidate fits, create one entity with remember. Use a routed entity_type: "fact" (durable fact), "decision" (decision), "topic" (subject note), "task" (open item), "idea" (idea), "preference" (like or dislike), or "event" (something at a date and time). These types have configured routes; do not invent an unrouted type. In the body link related candidates as [[path without .md]] and cite the messages, for example "zdroj: msgs 24-26".',
  '4. For every new note, create_relation from the new note to each linked candidate.',
  '5. Mark anything not verified as "neověřeno" in its value. Do not write guesses as facts.',
  '6. Store progress: continue with next_cursor until done = true. Keep the cursor you processed.',
];

const STOPWORDS = new Set([
  // transcript role headings and generic words that match everything
  'assistant', 'user', 'message', 'false', 'true', 'null', 'text', 'zařízení', 'services', 'start', 'image',
  'this', 'that', 'with', 'from', 'your', 'have', 'will', 'would', 'there', 'their', 'about', 'which', 'when', 'what',
  'jak', 'the', 'and', 'for', 'pro', 'jsem', 'jsou', 'toho', 'tohle', 'taky', 'proto', 'takže', 'když', 'nebo', 'jako',
  'tady', 'teď', 'pak', 'ale', 'ten', 'ta', 'to', 'je', 'se', 'si', 'na', 'co', 'by', 'že', 'už', 'mám', 'máme',
]);

/** Deterministic key terms: frequent words of length >= 5 that are not stopwords. */
export function keyTerms(text: string, limit = 8): string[] {
  const counts = new Map<string, number>();
  for (const raw of text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}-]{4,}/gu) ?? []) {
    if (STOPWORDS.has(raw)) continue;
    counts.set(raw, (counts.get(raw) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([term]) => term);
}

async function findCandidates(memory: MemoryService, terms: string[]): Promise<CandidateEntity[]> {
  const byId = new Map<string, CandidateEntity>();
  for (const term of terms) {
    const hits = await memory.search({ query: term, limit: 3 });
    for (const hit of hits) {
      const existing = byId.get(hit.metadata.id);
      if (existing) {
        existing.matched_terms.push(term);
        continue;
      }
      byId.set(hit.metadata.id, {
        id: hit.metadata.id,
        type: hit.metadata.type,
        title: hit.metadata.title,
        path: hit.path.replace(/\.md$/, ''),
        matched_terms: [term],
      });
    }
  }
  // Keep precise matches: the term appears in the title, or at least two key terms hit the entity.
  const ranked = [...byId.values()]
    .map(c => ({ c, titleHit: c.matched_terms.some(t => c.title.toLowerCase().includes(t)) }))
    .filter(({ c, titleHit }) => titleHit || c.matched_terms.length >= 2);
  return ranked
    .sort((a, b) => Number(b.titleHit) - Number(a.titleHit) || b.c.matched_terms.length - a.c.matched_terms.length)
    .slice(0, 10)
    .map(({ c }) => c);
}

export async function distillNextChunk(memory: MemoryService, input: { source_id: string; cursor: number; max_chars: number }): Promise<DistillChunkResult> {
  const entity = await memory.get(input.source_id);
  if (entity.metadata.type !== 'source') throw new MemoryError('NOT_FOUND', `Entity is not a source: ${input.source_id}`);
  const messages = parseTranscriptMessages(entity.content);
  const plans = planChunks(messages, input.max_chars);
  const plan = plans[input.cursor];
  if (!plan) {
    return {
      source_id: input.source_id, title: entity.metadata.title, chunk: input.cursor, total_chunks: plans.length,
      from_message: 0, to_message: 0, next_cursor: null, done: true, procedure: DISTILL_PROCEDURE, candidates: [], text: '',
    };
  }
  const text = renderChunkText(messages, plan);
  const isLast = input.cursor + 1 >= plans.length;
  return {
    source_id: input.source_id,
    title: entity.metadata.title,
    chunk: plan.chunk,
    total_chunks: plans.length,
    from_message: messages[plan.from]!.number,
    to_message: messages[plan.to]!.number,
    next_cursor: isLast ? null : plan.chunk + 1,
    done: isLast,
    procedure: DISTILL_PROCEDURE,
    candidates: await findCandidates(memory, keyTerms(text)),
    text,
  };
}
