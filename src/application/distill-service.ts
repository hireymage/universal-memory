import { MemoryError } from '../domain/errors.js';
import { parseTranscriptMessages, planChunks, renderChunkText } from '../domain/session-chunks.js';
import type { MemoryService } from './memory-service.js';

/**
 * Stateless paging over a stored source transcript for distillation.
 * The caller passes back `next_cursor` to continue; the server keeps no state,
 * so an interrupted run resumes from the last cursor the model recorded.
 */

export interface DistillChunkResult {
  source_id: string;
  title: string;
  chunk: number;
  total_chunks: number;
  from_message: number;
  to_message: number;
  next_cursor: number | null;
  done: boolean;
  instructions: string;
  text: string;
}

export const DISTILL_INSTRUCTIONS =
  'Write notes only from this chunk. For each note set source_ids to [source_id] and cite the message numbers you used (for example "msgs 12-14"). Prefer updating an existing entity over creating a duplicate. Put uncertain items in the inbox instead of memory. Short replies such as "ano" are decisions: read them with the question they answer.';

export async function distillNextChunk(memory: MemoryService, input: { source_id: string; cursor: number; max_chars: number }): Promise<DistillChunkResult> {
  const entity = await memory.get(input.source_id);
  if (entity.metadata.type !== 'source') throw new MemoryError('NOT_FOUND', `Entity is not a source: ${input.source_id}`);
  const messages = parseTranscriptMessages(entity.content);
  const plans = planChunks(messages, input.max_chars);
  const plan = plans[input.cursor];
  if (!plan) {
    return {
      source_id: input.source_id, title: entity.metadata.title, chunk: input.cursor, total_chunks: plans.length,
      from_message: 0, to_message: 0, next_cursor: null, done: true, instructions: DISTILL_INSTRUCTIONS, text: '',
    };
  }
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
    instructions: DISTILL_INSTRUCTIONS,
    text: renderChunkText(messages, plan),
  };
}
