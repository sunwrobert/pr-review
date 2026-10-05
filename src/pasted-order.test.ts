import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import type { PullRequest } from './github';
import { applyPastedOrder, parsePastedOrder } from './pasted-order';

const SAMPLE = `Merge Now (33)
All approved, clean, required checks green, no open threads.
Backend and infrastructure
- 11 ★ #47629 fix(embeddings): attribute provider token-limit refusals
- 9 ★ #47793 fix: attribute an oversized hydrated image body
Generated-media stack (the rest of it)
- 10 #46733 feat(video): copy completed outputs — its base #46732 has merged
- 10 #46734 feat(video): stream stored copies — stacked on #46733; merge it right after
Also https://github.com/o/r/pull/48182 and see #47629 again`;

const pull = (number: number): PullRequest => ({ id: `id-${number}`, number }) as unknown as PullRequest;

describe('parsePastedOrder', () => {
  test('reads the first PR number on each line, in order, ignoring later mentions on the same line', () => {
    expect(parsePastedOrder(SAMPLE).numbers).toEqual([47629, 47793, 46733, 46734, 48182]);
  });

  test('remembers the heading each PR sat under', () => {
    const { headings } = parsePastedOrder(SAMPLE);
    expect(headings.get(47629)).toBe('Backend and infrastructure');
    expect(headings.get(46733)).toBe('Generated-media stack (the rest of it)');
  });

  test('takes every PR from a comma list, but only the subject PR from a line that mentions dependencies', () => {
    const text = '- ★ #47878, #47879, #47880, plus #47331 from before.\n- 10 #46734 feat: stream — stacked on #46733; merge it right after';
    expect(parsePastedOrder(text).numbers).toEqual([47878, 47879, 47880, 47331, 46734]);
  });

  test('ignores scores and counts that are not PR references', () => {
    expect(parsePastedOrder('Merge Now (33)\n- 11 ★ #100 a\n- 9 #200 b').numbers).toEqual([100, 200]);
  });
});

describe('applyPastedOrder', () => {
  test('puts pasted PRs first in pasted order and keeps the rest in place', () => {
    const pulls = [1, 2, 3, 4, 5].map(pull);
    expect(applyPastedOrder(pulls, { numbers: [4, 2], headings: new Map() }).map((item) => item.number)).toEqual([4, 2, 1, 3, 5]);
  });

  test('property: output is a permutation, pasted PRs lead in pasted order, the rest keep relative order', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.integer({ min: 1, max: 60 }), { maxLength: 40 }), fc.uniqueArray(fc.integer({ min: 1, max: 80 }), { maxLength: 30 }), (present, pasted) => {
        const pulls = present.map(pull);
        const result = applyPastedOrder(pulls, { numbers: pasted, headings: new Map() }).map((item) => item.number);
        expect([...result].sort((a, b) => a - b)).toEqual([...present].sort((a, b) => a - b));
        const lead = pasted.filter((number) => present.includes(number));
        expect(result.slice(0, lead.length)).toEqual(lead);
        expect(result.slice(lead.length)).toEqual(present.filter((number) => !pasted.includes(number)));
      }),
      { numRuns: 1_000 },
    );
  });
});
