import { describe, expect, it } from 'vitest';
import { relationBulletLine, rewriteRelationBullets } from '../src/domain/model.js';

const target = { title: 'Tiiny-AI-Kickstarter', path: '07 Communication/tiiny-ai-kickstarter.md' };

describe('relation bullets', () => {
  it('links the basename and shows the title as alias text', () => {
    expect(relationBulletLine(target, 'R1')).toBe('- [[tiiny-ai-kickstarter|Tiiny-AI-Kickstarter]] <!-- rel:R1 -->');
  });

  it('qualifies folder index notes with their folder', () => {
    expect(relationBulletLine({ title: 'Homelab', path: '02 Projects/homelab/index.md' }, 'R9')).toBe('- [[homelab/index|Homelab]] <!-- rel:R9 -->');
  });

  it('rewrites a legacy title link and leaves correct bullets and other text unchanged', () => {
    const content = [
      '## Relations',
      '',
      '- [[Tiiny-AI-Kickstarter]] <!-- rel:R1 -->',
      '- [[tiiny-ai-kickstarter|Tiiny-AI-Kickstarter]] <!-- rel:R2 -->',
      'See [[Tiiny-AI-Kickstarter]] in the text.',
    ].join('\n');
    const result = rewriteRelationBullets(content, new Map([['R1', target], ['R2', target]]));
    expect(result.changed).toBe(1);
    expect(result.unresolved).toEqual([]);
    expect(result.content).toContain('- [[tiiny-ai-kickstarter|Tiiny-AI-Kickstarter]] <!-- rel:R1 -->');
    expect(result.content).toContain('See [[Tiiny-AI-Kickstarter]] in the text.');
  });

  it('is idempotent and reports markers without a known target', () => {
    const content = '- [[Old]] <!-- rel:GONE -->';
    const first = rewriteRelationBullets(content, new Map());
    expect(first.changed).toBe(0);
    expect(first.unresolved).toEqual(['GONE']);
    const again = rewriteRelationBullets(rewriteRelationBullets(content, new Map([['GONE', target]])).content, new Map([['GONE', target]]));
    expect(again.changed).toBe(0);
  });
});

describe('legacy marker ids', () => {
  it('rewrites markers that contain hyphens, such as phase-3 relation ids', () => {
    const result = rewriteRelationBullets('- [[Old]] <!-- rel:p3r-abc123 -->', new Map([['p3r-abc123', target]]));
    expect(result.changed).toBe(1);
    expect(result.content).toBe('- [[tiiny-ai-kickstarter|Tiiny-AI-Kickstarter]] <!-- rel:p3r-abc123 -->');
  });
});
