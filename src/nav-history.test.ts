import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { NavHistory } from './nav-history';

const live = (): boolean => true;
const at = (pullId: string) => ({ kind: 'review' as const, pullId });

describe('NavHistory', () => {
  test('back and forward walk visited PRs, and a new visit drops forward history', () => {
    const history = new NavHistory();
    history.visit(at('a'), 'jump', 0);
    history.visit(at('b'), 'jump', 10_000);
    history.visit(at('c'), 'jump', 20_000);
    expect(history.go(-1, live)?.pullId).toBe('b');
    expect(history.go(-1, live)?.pullId).toBe('a');
    expect(history.go(-1, live)).toBeNull();
    expect(history.go(1, live)?.pullId).toBe('b');
    history.visit(at('d'), 'jump', 30_000);
    expect(history.go(1, live)).toBeNull();
    expect(history.go(-1, live)?.pullId).toBe('b');
  });

  test('a quick run of j/k steps is one entry; a pause starts a new one', () => {
    const history = new NavHistory();
    history.visit(at('a'), 'jump', 0);
    history.visit(at('b'), 'step', 5_000);
    history.visit(at('c'), 'step', 5_200);
    history.visit(at('d'), 'step', 5_400);
    expect(history.go(-1, live)?.pullId).toBe('a');
    history.go(1, live);
    history.visit(at('e'), 'step', 9_000);
    expect(history.go(-1, live)?.pullId).toBe('d');
  });

  test('replace and none never add entries; revisiting the current PR is a no-op', () => {
    const history = new NavHistory();
    history.visit(at('a'), 'jump', 0);
    history.visit(at('b'), 'replace', 1);
    history.visit(at('b'), 'jump', 2);
    history.visit(at('c'), 'none', 3);
    expect(history.go(-1, live)).toBeNull();
    expect(history.peek(1, live)).toBeNull();
  });

  test('skips PRs that have since merged or closed', () => {
    const history = new NavHistory();
    ['a', 'b', 'c'].forEach((id, index) => history.visit(at(id), 'jump', index * 10_000));
    expect(history.go(-1, (entry) => entry.pullId !== 'b')?.pullId).toBe('a');
  });

  test('remembers scroll per entry', () => {
    const history = new NavHistory();
    history.visit(at('a'), 'jump', 0);
    history.saveScroll(120, 900);
    history.visit(at('b'), 'jump', 10_000);
    expect(history.go(-1, live)).toMatchObject({ pullId: 'a', descScroll: 120, diffScroll: 900 });
  });

  test('property: back then forward returns to the same entry, and back never yields the current PR', () => {
    const ids = fc.constantFrom('a', 'b', 'c', 'd');
    const ops = fc.array(fc.oneof(fc.record({ visit: ids, source: fc.constantFrom('step', 'jump', 'replace' as const), gap: fc.nat(3_000) }), fc.constantFrom(-1 as const, 1 as const)), { maxLength: 40 });
    fc.assert(fc.property(ops, (steps) => {
      const history = new NavHistory();
      let now = 0;
      let current: string | null = null;
      for (const step of steps) {
        if (typeof step === 'number') {
          const entry = history.go(step, live);
          if (entry != null) current = entry.pullId;
          continue;
        }
        now += step.gap;
        history.visit(at(step.visit), step.source, now);
        current = step.visit;
      }
      const back = history.go(-1, live);
      if (back == null) return;
      expect(back.pullId).not.toBe(current);
      expect(history.go(1, live)?.pullId).toBe(current);
    }), { numRuns: 5_000 });
  });
});
