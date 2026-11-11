/**
 * Splits a stored conversation transcript into numbered messages and plans
 * bounded chunks for distillation. Pure functions, no I/O.
 *
 * Rules:
 * - Every message is kept, including short replies such as "ano" or "ok":
 *   a short reply is often a decision, so nothing is filtered by length.
 * - Messages are numbered 1..N in transcript order (the `## User` /
 *   `## Assistant` headings written by buildTranscriptMarkdown).
 * - A chunk never starts in the middle of a question/answer pair: when a
 *   chunk ends on an assistant message, the next chunk starts with that same
 *   message, so the answer that follows it stays with its question.
 * - A chunk holds at least one message even if that message exceeds max_chars.
 */

export interface TranscriptMessage {
  number: number;
  role: 'User' | 'Assistant';
  text: string;
}

export interface ChunkPlan {
  chunk: number;
  from: number;
  to: number;
}

const HEADING = /^## (User|Assistant)$/;

export function parseTranscriptMessages(markdown: string): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  let current: { role: 'User' | 'Assistant'; lines: string[] } | undefined;
  const flush = () => {
    if (!current) return;
    const text = current.lines.join('\n').trim();
    messages.push({ number: messages.length + 1, role: current.role, text });
    current = undefined;
  };
  for (const line of markdown.split('\n')) {
    const match = HEADING.exec(line);
    if (match) {
      flush();
      current = { role: match[1] as 'User' | 'Assistant', lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  flush();
  return messages;
}

const messageSize = (message: TranscriptMessage): number => message.role.length + message.text.length + 8;

/** Greedy plan of chunks over messages, bounded by max_chars per chunk. */
export function planChunks(messages: TranscriptMessage[], maxChars: number): ChunkPlan[] {
  const plans: ChunkPlan[] = [];
  if (messages.length === 0) return plans;
  let start = 0;
  while (start < messages.length) {
    let end = start;
    let size = messageSize(messages[start]!);
    while (end + 1 < messages.length && size + messageSize(messages[end + 1]!) <= maxChars) {
      end += 1;
      size += messageSize(messages[end]!);
    }
    plans.push({ chunk: plans.length, from: start, to: end });
    if (end === messages.length - 1) break;
    // Keep a question with its answer: if this chunk ends on an assistant message, the next one starts with it.
    const endsOnAssistant = messages[end]!.role === 'Assistant';
    start = endsOnAssistant && end > start ? end : end + 1;
  }
  return plans;
}

/** Renders one chunk with message numbers so notes can cite exact ranges. */
export function renderChunkText(messages: TranscriptMessage[], plan: ChunkPlan): string {
  return messages
    .slice(plan.from, plan.to + 1)
    .map(message => `[${message.number}] ${message.role}:\n${message.text}`)
    .join('\n\n');
}
