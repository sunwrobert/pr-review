import { describe, expect, test } from 'bun:test';
import { collectStack, findStacks, orderByStacks } from './stacks';

const pull = (number: number, head: string, base: string, repo = 'o/r') => ({ id: `p${number}`, number, headRefName: head, baseRefName: base, repository: { nameWithOwner: repo } });
const ids = (pulls: { id: string }[]): string[] => pulls.map((item) => item.id);

describe('findStacks', () => {
  test('links base to head bottom first', () => {
    const slots = findStacks([pull(3, 'c', 'b'), pull(1, 'a', 'main'), pull(2, 'b', 'a')]);
    expect(slots.get('p1')).toEqual({ stackId: 'p1', index: 0, size: 3 });
    expect(slots.get('p2')).toEqual({ stackId: 'p1', index: 1, size: 3 });
    expect(slots.get('p3')).toEqual({ stackId: 'p1', index: 2, size: 3 });
  });

  test('lone pulls and other repos are not stacks', () => {
    const slots = findStacks([pull(1, 'a', 'main'), pull(2, 'b', 'a', 'o/other'), pull(3, 'c', 'main')]);
    expect(slots.size).toBe(0);
  });

  test('a cycle does not hang and is not a stack', () => {
    expect(findStacks([pull(1, 'a', 'b'), pull(2, 'b', 'a')]).size).toBe(0);
  });

  test('PRs that only share a base branch with a GitHub stack are not pulled into it', () => {
    const native = { baseRefName: 'main', mergeCount: 1 };
    const slots = findStacks([
      { ...pull(60511, 'smoke', 'main'), stack: native },
      { ...pull(60517, 'mcp', 'smoke'), stack: null },
      { ...pull(60518, 'chat', 'smoke'), stack: null },
      { ...pull(60519, 'expiry', 'smoke'), stack: null },
      { ...pull(60527, 'rankings', 'smoke'), stack: { baseRefName: 'main', mergeCount: 2 } },
    ]);
    expect([...slots.keys()].sort()).toEqual(['p60511', 'p60527']);
    expect(slots.get('p60527')).toEqual({ stackId: 'p60511', index: 1, size: 2 });
  });

  test('hand-made chains outside GitHub stacks still group by branch', () => {
    const slots = findStacks([{ ...pull(1, 'a', 'main'), stack: null }, { ...pull(2, 'b', 'a'), stack: null }]);
    expect(slots.get('p2')).toEqual({ stackId: 'p1', index: 1, size: 2 });
  });

  test('branches list siblings by number under their parent', () => {
    const slots = findStacks([pull(1, 'a', 'main'), pull(5, 'y', 'a'), pull(4, 'x', 'a')]);
    expect([...slots.entries()].sort((l, r) => l[1].index - r[1].index).map(([id]) => id)).toEqual(['p1', 'p4', 'p5']);
  });
});

describe('orderByStacks', () => {
  test('stack sits at its best-ranked member, in stack order', () => {
    const all = [pull(9, 'z', 'main'), pull(3, 'c', 'b'), pull(1, 'a', 'main'), pull(7, 'q', 'main'), pull(2, 'b', 'a')];
    expect(ids(orderByStacks(all, findStacks(all)))).toEqual(['p9', 'p1', 'p2', 'p3', 'p7']);
  });

  test('filtered-out members leave the rest of the stack in order', () => {
    const all = [pull(1, 'a', 'main'), pull(2, 'b', 'a'), pull(3, 'c', 'b')];
    expect(ids(orderByStacks([all[2]!, all[0]!], findStacks(all)))).toEqual(['p1', 'p3']);
  });
});

describe('collectStack', () => {
  const chain = [pull(1, 'a', 'main'), pull(2, 'b', 'a'), pull(3, 'c', 'b'), pull(4, 'd', 'b')];
  const neighbors = async (target: (typeof chain)[number]) => chain.filter((other) => other.baseRefName === target.headRefName || other.headRefName === target.baseRefName);

  test('finds the whole stack from a middle pull', async () => {
    expect(ids(await collectStack(chain[1]!, neighbors)).sort()).toEqual(['p1', 'p2', 'p3', 'p4']);
  });

  test('stops at the limit', async () => {
    expect((await collectStack(chain[0]!, neighbors, 2)).length).toBe(2);
  });
});
