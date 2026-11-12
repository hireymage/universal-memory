import { stripAccents } from './similarity.js';

/** First sentence that touches the query, capped so a search hit stays small. */
export function oneSentence(content: string, query?: string, maxLength = 160): string {
  const clean = content.replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const sentences = clean.split(/(?<=[.!?…])\s+/).filter(Boolean);
  const needle = stripAccents(query ?? '').split(/\s+/).find(token => token.length >= 3);
  const picked = (needle
    ? sentences.find(sentence => stripAccents(sentence).includes(needle))
    : undefined) ?? sentences[0] ?? clean;
  if (picked.length <= maxLength) return picked;
  const cut = picked.slice(0, maxLength - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > 40 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
