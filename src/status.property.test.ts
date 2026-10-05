import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { isReady, matchesSmartFilter, sortPulls, type SmartFilter, type SortOrder } from './smart';
import { ATTENTION_ORDER, attentionReasons, buildAgentPrompt, isConflicted, isFailing, needsAttention, prStatus } from './status';
import { FIXED_NOW, pullArbitrary, pullListArbitrary } from './testing/arbitraries';

const RUNS = { numRuns: Number(process.env.PROPERTY_RUNS ?? 2_000) };

describe('status invariants', () => {
  test('ready never coexists with a conflict, failing check, change request, draft or queue entry', () => {
    fc.assert(
      fc.property(pullArbitrary, (pull) => {
        if (!isReady(pull)) return;
        expect(isConflicted(pull)).toBe(false);
        expect(isFailing(pull)).toBe(false);
        expect(pull.reviewDecision).not.toBe('CHANGES_REQUESTED');
        expect(pull.isDraft).toBe(false);
        expect(pull.queueEntry).toBeNull();
      }),
      RUNS,
    );
  });

  test('every pull gets exactly one status, red is exactly the blocking conditions, and conflicts stay red in the queue', () => {
    fc.assert(
      fc.property(pullArbitrary, (pull) => {
        const { tone } = prStatus(pull);
        const isBlocking = isConflicted(pull) || isFailing(pull) || pull.reviewDecision === 'CHANGES_REQUESTED' || (pull.reviewDecision === 'APPROVED' && pull.mergeStateStatus === 'BLOCKED');
        if (isConflicted(pull)) expect(tone).toBe('blocked');
        else if (pull.queueEntry != null) expect(tone).toBe('queued');
        else expect(tone === 'blocked').toBe(isBlocking);
        if (tone === 'approved') expect(pull.reviewDecision).toBe('APPROVED');
        if (tone === 'pending') expect(pull.reviewDecision === 'APPROVED').toBe(false);
      }),
      RUNS,
    );
  });

  test('ready pulls never need attention, and attention reasons are ordered and unique', () => {
    fc.assert(
      fc.property(pullArbitrary, (pull) => {
        const reasons = attentionReasons(pull);
        expect(new Set(reasons).size).toBe(reasons.length);
        expect([...reasons].sort((left, right) => ATTENTION_ORDER.indexOf(left) - ATTENTION_ORDER.indexOf(right))).toEqual(reasons);
        if (isReady(pull) && pull.reviewDecision === 'APPROVED') expect(needsAttention(pull)).toBe(false);
        if (needsAttention(pull)) expect(pull.queueEntry == null && !pull.isDraft).toBe(true);
      }),
      RUNS,
    );
  });

  test('the agent prompt lists every target url exactly once and only included problems', () => {
    fc.assert(
      fc.property(pullListArbitrary, fc.subarray([...ATTENTION_ORDER], { minLength: 1 }), (pulls, included) => {
        const includedSet = new Set(included);
        const targets = pulls.filter((pull) => attentionReasons(pull).some((reason) => includedSet.has(reason)));
        const prompt = buildAgentPrompt(targets, includedSet);
        targets.forEach((pull) => expect(prompt.split(`- ${pull.url}\n`).length - 1).toBe(1));
        ATTENTION_ORDER.filter((reason) => !includedSet.has(reason)).forEach((reason) => expect(prompt).not.toContain(`problem: ${reason}`));
      }),
      { numRuns: Math.max(100, RUNS.numRuns / 10) },
    );
  });
});

describe('list invariants', () => {
  const orders: SortOrder[] = ['smart', 'updated', 'size'];
  const filters: SmartFilter[] = ['all', 'ready', 'small', 'recent'];

  test('sorting is a permutation and is deterministic', () => {
    fc.assert(
      fc.property(pullListArbitrary, fc.constantFrom(...orders), (pulls, order) => {
        const once = sortPulls(pulls, order, FIXED_NOW);
        expect(once.map((pull) => pull.id).sort()).toEqual(pulls.map((pull) => pull.id).sort());
        expect(sortPulls(once, order, FIXED_NOW).map((pull) => pull.id)).toEqual(once.map((pull) => pull.id));
      }),
      { numRuns: Math.max(100, RUNS.numRuns / 10) },
    );
  });

  test('size order is non-decreasing and smart order puts no blocked pull above a ready one', () => {
    fc.assert(
      fc.property(pullListArbitrary, (pulls) => {
        const bySize = sortPulls(pulls, 'size', FIXED_NOW).map((pull) => pull.additions + pull.deletions);
        bySize.slice(1).forEach((size, index) => expect(size).toBeGreaterThanOrEqual(bySize[index] ?? 0));
        const smart = sortPulls(pulls, 'smart', FIXED_NOW);
        const lastReady = smart.findLastIndex(isReady);
        const firstBlocked = smart.findIndex((pull) => pull.isDraft || isConflicted(pull));
        if (lastReady >= 0 && firstBlocked >= 0) expect(firstBlocked).toBeGreaterThan(lastReady);
      }),
      { numRuns: Math.max(100, RUNS.numRuns / 10) },
    );
  });

  test('filters are subsets and "all" is the identity', () => {
    fc.assert(
      fc.property(pullListArbitrary, fc.constantFrom(...filters), (pulls, filter) => {
        const kept = pulls.filter((pull) => matchesSmartFilter(pull, filter, FIXED_NOW));
        expect(kept.length).toBeLessThanOrEqual(pulls.length);
        if (filter === 'all') expect(kept.length).toBe(pulls.length);
        if (filter === 'ready') kept.forEach((pull) => expect(isReady(pull)).toBe(true));
      }),
      { numRuns: Math.max(100, RUNS.numRuns / 10) },
    );
  });
});
