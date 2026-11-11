import { describe, expect, it } from 'vitest';
import { parseTranscriptMessages, planChunks, renderChunkText } from '../src/domain/session-chunks.js';

const transcript = [
  '# Session',
  '',
  '## User',
  'Jaké je rozhodnutí o DB?',
  '',
  '## Assistant',
  'Použijeme SQLite. Potvrdíš?',
  '',
  '## User',
  'ano',
  '',
  '## Assistant',
  'Zapsáno.',
].join('\n');

describe('parseTranscriptMessages', () => {
  it('numbers messages in order and keeps short replies', () => {
    const messages = parseTranscriptMessages(transcript);
    expect(messages.map(m => [m.number, m.role, m.text.split('\n')[0]])).toEqual([
      [1, 'User', 'Jaké je rozhodnutí o DB?'],
      [2, 'Assistant', 'Použijeme SQLite. Potvrdíš?'],
      [3, 'User', 'ano'],
      [4, 'Assistant', 'Zapsáno.'],
    ]);
  });
});

describe('planChunks', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    number: i + 1,
    role: (i % 2 === 0 ? 'User' : 'Assistant') as 'User' | 'Assistant',
    text: `message ${i + 1} ${'x'.repeat(200)}`,
  }));

  it('covers every message and respects the size bound', () => {
    const plans = planChunks(many, 1000);
    expect(plans.length).toBeGreaterThan(1);
    expect(plans[0]!.from).toBe(0);
    expect(plans[plans.length - 1]!.to).toBe(many.length - 1);
    for (const plan of plans) {
      const text = renderChunkText(many, plan);
      expect(text.length).toBeLessThanOrEqual(1000 + 200 + 50);
    }
  });

  it('starts the next chunk with an assistant message that ended the previous one', () => {
    const plans = planChunks(many, 1000);
    for (let i = 0; i + 1 < plans.length; i++) {
      const endMessage = many[plans[i]!.to]!;
      if (endMessage.role === 'Assistant') expect(plans[i + 1]!.from).toBe(plans[i]!.to);
      else expect(plans[i + 1]!.from).toBe(plans[i]!.to + 1);
    }
  });

  it('keeps a single oversized message as its own chunk and terminates', () => {
    const big = [{ number: 1, role: 'User' as const, text: 'y'.repeat(5000) }, { number: 2, role: 'Assistant' as const, text: 'short' }];
    const plans = planChunks(big, 1000);
    expect(plans.map(p => [p.from, p.to])).toEqual([[0, 0], [1, 1]]);
  });

  it('returns no chunks for an empty transcript', () => {
    expect(planChunks([], 1000)).toEqual([]);
  });
});
