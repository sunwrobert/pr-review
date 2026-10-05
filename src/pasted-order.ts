import type { PullRequest } from './github';

export interface PastedOrder {
  numbers: number[];
  headings: Map<number, string>;
}

const PR_REFERENCE = /(?:\/pull\/|(?<![\w/])#)(\d{1,7})\b/g;
const HEADING = /^(?!\s*[-*•]|\s*\d+[.)]\s)(.{2,80}?)\s*$/;

const DEPENDENCY_WORDS = /\b(?:stacked on|base(?: for)?|depends on|after|blocked by|its base|see)\b/i;

/** A line that enumerates several PRs ("#1, #2, #3 plus #4") rather than naming one PR and mentioning others. */
function isPrList(line: string): boolean {
  const refs = [...line.matchAll(PR_REFERENCE)];
  if (refs.length < 2) return false;
  const between = line.slice(refs[0]?.index ?? 0, (refs.at(-1)?.index ?? 0) + 1);
  return !DEPENDENCY_WORDS.test(between) && /^[\s#\d,;/&+]*(?:(?:and|plus|or)\s+#\d+[\s,;]*)*/i.test(between.replace(/\b(?:and|plus|or)\b/gi, ','));
}

/** Pulls PR numbers out of free-form text in the order they first appear, remembering the nearest heading above each. */
export function parsePastedOrder(text: string): PastedOrder {
  const numbers: number[] = [];
  const seen = new Set<number>();
  const headings = new Map<number, string>();
  let heading = '';
  for (const line of text.split(/\r?\n/)) {
    const matches = [...line.matchAll(PR_REFERENCE)].map((match) => Number(match[1]));
    if (matches.length === 0) {
      const candidate = HEADING.exec(line.trim())?.[1];
      if (candidate != null && candidate !== '') heading = candidate.replace(/[:：]\s*$/, '');
      continue;
    }
    const listed = isPrList(line) ? matches : [matches[0] as number];
    for (const number of listed) {
      if (seen.has(number)) continue;
      seen.add(number);
      numbers.push(number);
      if (heading !== '') headings.set(number, heading);
    }
  }
  return { numbers, headings };
}

/** Puts pasted PRs first in pasted order; everything else keeps its existing order after them. */
export function applyPastedOrder(pulls: readonly PullRequest[], order: PastedOrder): PullRequest[] {
  const rank = new Map(order.numbers.map((number, index) => [number, index]));
  const listed = pulls.filter((pull) => rank.has(pull.number)).sort((left, right) => (rank.get(left.number) ?? 0) - (rank.get(right.number) ?? 0));
  const rest = pulls.filter((pull) => !rank.has(pull.number));
  return [...listed, ...rest];
}
