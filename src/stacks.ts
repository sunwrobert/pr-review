import type { PullRequest } from './github';

/** Where a pull sits in its stack: `index` 0 is the bottom (merges first). */
export interface StackSlot {
  stackId: string;
  index: number;
  size: number;
}

type StackPull = Pick<PullRequest, 'id' | 'number' | 'headRefName' | 'baseRefName' | 'repository'>;

const branchKey = (repo: string, branch: string): string => `${repo}\u0000${branch}`;

/** Finds stacks: pulls in one repo where a pull's base branch is another open pull's head branch. */
export function findStacks(pulls: readonly StackPull[]): Map<string, StackSlot> {
  const byHead = new Map<string, StackPull>();
  pulls.forEach((pull) => {
    const key = branchKey(pull.repository.nameWithOwner, pull.headRefName);
    if (!byHead.has(key)) byHead.set(key, pull);
  });
  const parentOf = (pull: StackPull): StackPull | undefined => {
    const parent = byHead.get(branchKey(pull.repository.nameWithOwner, pull.baseRefName));
    return parent === pull ? undefined : parent;
  };
  const children = new Map<string, StackPull[]>();
  pulls.forEach((pull) => {
    const parent = parentOf(pull);
    if (parent != null) children.set(parent.id, [...(children.get(parent.id) ?? []), pull]);
  });
  const slots = new Map<string, StackSlot>();
  const roots = pulls.filter((pull) => parentOf(pull) == null && children.has(pull.id));
  roots.forEach((root) => {
    const members = walk(root, children, new Set());
    members.forEach((pull, index) => slots.set(pull.id, { stackId: root.id, index, size: members.length }));
  });
  return slots;
}

/** Keeps the ranking, but pulls each stack together at its best-ranked member, bottom first. */
export function orderByStacks<T extends { id: string }>(ranked: readonly T[], slots: ReadonlyMap<string, StackSlot>): T[] {
  const byStack = new Map<string, T[]>();
  ranked.forEach((pull) => {
    const slot = slots.get(pull.id);
    if (slot != null) byStack.set(slot.stackId, [...(byStack.get(slot.stackId) ?? []), pull]);
  });
  const placed = new Set<string>();
  return ranked.flatMap((pull) => {
    const slot = slots.get(pull.id);
    if (slot == null) return [pull];
    if (placed.has(slot.stackId)) return [];
    placed.add(slot.stackId);
    return [...(byStack.get(slot.stackId) ?? [])].sort((left, right) => (slots.get(left.id)?.index ?? 0) - (slots.get(right.id)?.index ?? 0));
  });
}

/** Walks a stack outwards from `start` one neighbour lookup at a time, up to `limit` pulls. */
export async function collectStack<T extends { id: string }>(start: T, neighborsOf: (pull: T) => Promise<T[]>, limit = 100): Promise<T[]> {
  const found = new Map([[start.id, start]]);
  let frontier = [start];
  while (frontier.length > 0 && found.size < limit) {
    const batches = await Promise.all(frontier.map(neighborsOf));
    frontier = batches.flat().filter((pull) => !found.has(pull.id) && found.size < limit && found.set(pull.id, pull) != null);
  }
  return [...found.values()];
}

function walk(pull: StackPull, children: ReadonlyMap<string, StackPull[]>, seen: Set<string>): StackPull[] {
  if (seen.has(pull.id)) return [];
  seen.add(pull.id);
  const next = [...(children.get(pull.id) ?? [])].sort((left, right) => left.number - right.number);
  return [pull, ...next.flatMap((child) => walk(child, children, seen))];
}
