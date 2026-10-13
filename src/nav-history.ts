import type { QueueKind } from './github';

/** Where the selection change came from: a single j/k step, a deliberate jump, or the app picking a PR on its own. */
export type NavSource = 'step' | 'jump' | 'replace' | 'none';

export interface NavEntry {
  kind: QueueKind;
  pullId: string;
  descScroll: number;
  diffScroll: number;
}

interface Slot extends NavEntry {
  source: NavSource;
  at: number;
}

/** A run of j/k presses counts as one move until the user pauses this long. */
const STEP_SETTLE_MS = 1_200;
const MAX_ENTRIES = 100;

/** Linear/Slack-style back/forward stack: visiting truncates forward history, steps coalesce, repeats are ignored. */
export class NavHistory {
  private slots: Slot[] = [];
  private index = -1;

  visit(entry: Omit<NavEntry, 'descScroll' | 'diffScroll'>, source: NavSource, now: number): void {
    if (source === 'none') return;
    const current = this.slots[this.index];
    if (current != null && current.pullId === entry.pullId && current.kind === entry.kind) return;
    const slot: Slot = { ...entry, descScroll: 0, diffScroll: 0, source, at: now };
    const isCoalescedStep = source === 'step' && current?.source === 'step' && now - current.at < STEP_SETTLE_MS && this.index > 0;
    if (current != null && (source === 'replace' || isCoalescedStep)) {
      this.slots[this.index] = slot;
      this.mergeNeighbours();
      return;
    }
    this.slots = [...this.slots.slice(0, this.index + 1), slot].slice(-MAX_ENTRIES);
    this.index = this.slots.length - 1;
  }

  /** An in-place write can make the current entry equal its neighbour (c → a → c in one j/k run); keep one of them. */
  private mergeNeighbours(): void {
    const same = (left: Slot | undefined, right: Slot | undefined): boolean => left != null && right != null && left.pullId === right.pullId && left.kind === right.kind;
    if (same(this.slots[this.index - 1], this.slots[this.index])) {
      this.slots.splice(this.index, 1);
      this.index -= 1;
    }
    if (same(this.slots[this.index], this.slots[this.index + 1])) this.slots.splice(this.index + 1, 1);
  }

  /** Remembers where the current PR was scrolled so returning lands in the same place. */
  saveScroll(descScroll: number, diffScroll: number): void {
    const current = this.slots[this.index];
    if (current != null) this.slots[this.index] = { ...current, descScroll, diffScroll };
  }

  /** Moves one step and returns the entry, skipping entries `isLive` rejects (merged or closed PRs). */
  go(delta: -1 | 1, isLive: (entry: NavEntry) => boolean): NavEntry | null {
    for (let next = this.index + delta; next >= 0 && next < this.slots.length; next += delta) {
      const slot = this.slots[next];
      if (slot == null || !isLive(slot)) continue;
      this.index = next;
      return slot;
    }
    return null;
  }

  peek(delta: -1 | 1, isLive: (entry: NavEntry) => boolean): NavEntry | null {
    for (let next = this.index + delta; next >= 0 && next < this.slots.length; next += delta) {
      const slot = this.slots[next];
      if (slot != null && isLive(slot)) return slot;
    }
    return null;
  }
}
