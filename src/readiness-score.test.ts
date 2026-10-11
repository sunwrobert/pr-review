import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import type { PullRequest } from './github';
import { buildReadinessRequest, type ReviewContext } from './readiness';
import { readinessBreakdown, readinessScoreOf, type ReadinessSignals } from './readiness-score';

function pull(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    id: 'id', number: 1, title: 't', url: 'https://github.com/o/r/pull/1', isDraft: false, createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-26T10:00:00Z',
    additions: 10, deletions: 2, changedFiles: 1, headRefName: 'h', baseRefName: 'main', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED',
    author: null, repository: { nameWithOwner: 'o/r' }, checkState: 'SUCCESS', queueEntry: null, openThreads: 0, failingRequired: [], failingOptional: 0,
    ...overrides,
  };
}

const STRONG: ReadinessSignals = { evidence: 0.9, tested: 0.8, scope: 1, risk: 0.5, blocker: 0.2 };

describe('readinessScoreOf', () => {
  test('an approved, green, clean pull with strong review scores high even when the area is risky', () => {
    expect(readinessScoreOf(pull(), { ...STRONG, risk: 0.85 })).toBeGreaterThan(0.8);
  });

  test("Jev's background blocker odds on a clean pull cost nothing; a confident blocker does", () => {
    expect(readinessScoreOf(pull(), { ...STRONG, blocker: 0.45 })).toBe(readinessScoreOf(pull(), { ...STRONG, blocker: 0 }));
    expect(readinessScoreOf(pull(), { ...STRONG, blocker: 0.9 })).toBeLessThan(readinessScoreOf(pull(), STRONG) - 0.15);
  });

  test('conflicts, failing required checks, drafts and change requests cap the score whatever Jev says', () => {
    const perfect: ReadinessSignals = { evidence: 1, tested: 1, scope: 1, risk: 0, blocker: 0 };
    expect(readinessScoreOf(pull({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }), perfect)).toBeLessThanOrEqual(0.55);
    expect(readinessScoreOf(pull({ checkState: 'FAILURE', failingRequired: ['ci'] }), perfect)).toBeLessThanOrEqual(0.5);
    expect(readinessScoreOf(pull({ isDraft: true }), perfect)).toBeLessThanOrEqual(0.5);
    expect(readinessScoreOf(pull({ reviewDecision: 'CHANGES_REQUESTED' }), perfect)).toBeLessThanOrEqual(0.45);
  });

  test('approval outranks an unreviewed pull with the same signals', () => {
    expect(readinessScoreOf(pull(), STRONG)).toBeGreaterThan(readinessScoreOf(pull({ reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'BLOCKED' }), STRONG));
  });

  test('property: the score stays in 0..1 and never rises when Jev reports more blocker or less evidence', () => {
    const unit = fc.double({ min: 0, max: 1, noNaN: true });
    const signals = fc.record({ evidence: unit, tested: unit, scope: unit, risk: unit, blocker: unit });
    const pulls = fc.record({
      reviewDecision: fc.constantFrom('APPROVED', 'REVIEW_REQUIRED', 'CHANGES_REQUESTED', null),
      mergeable: fc.constantFrom('MERGEABLE', 'CONFLICTING', 'UNKNOWN'),
      checkState: fc.constantFrom('SUCCESS', 'FAILURE', 'PENDING', null),
      isDraft: fc.boolean(),
      openThreads: fc.nat(3),
    }).map((fields) => pull({ ...fields, failingRequired: fields.checkState === 'FAILURE' ? ['ci'] : [] } as Partial<PullRequest>));
    fc.assert(fc.property(pulls, signals, unit, (subject, base, bump) => {
      const score = readinessScoreOf(subject, base);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
      expect(readinessScoreOf(subject, { ...base, blocker: Math.min(1, base.blocker + bump) })).toBeLessThanOrEqual(score + 1e-9);
      expect(readinessScoreOf(subject, { ...base, evidence: Math.max(0, base.evidence - bump) })).toBeLessThanOrEqual(score + 1e-9);
      const cap = readinessBreakdown(subject, base).cap;
      if (cap != null) expect(score).toBeLessThanOrEqual(cap);
    }), { numRuns: 500 });
  });
});

describe('readiness request timeline', () => {
  const bot = (login: string) => ({ login, __typename: 'Bot' as const });
  const human = (login: string) => ({ login, __typename: 'User' as const });
  const context: ReviewContext = {
    body: 'Adds a cache.',
    files: { totalCount: 1, nodes: [{ path: 'src/a.ts', additions: 1, deletions: 0 }] },
    reviewThreads: { nodes: [] },
    reviews: { nodes: [
      { state: 'COMMENTED', bodyText: 'Devin Review found 1 potential issue.', submittedAt: '2026-10-01T10:00:00Z', author: bot('devin-ai-integration') },
      { state: 'COMMENTED', bodyText: 'Verdict: comments, one suggestion worth a decision, no blockers.', submittedAt: '2026-10-01T11:00:00Z', author: bot('perry-the-pr-reviewer') },
      { state: 'COMMENTED', bodyText: 'Devin Review found no new issues.', submittedAt: '2026-10-02T10:00:00Z', author: bot('devin-ai-integration') },
      { state: 'APPROVED', bodyText: 'Approve: my round-1 suggestion was taken.', submittedAt: '2026-10-02T12:00:00Z', author: bot('perry-the-pr-maintainer') },
    ] },
    comments: { nodes: [
      { bodyText: "I'll fix CI failures and address comments that start with 'Devin'.", createdAt: '2026-10-01T09:00:00Z', author: bot('devin-ai-integration') },
      { bodyText: 'We planted 666 small deliberate bugs in 6 files.', createdAt: '2026-10-01T12:00:00Z', author: human('github-actions') },
      { bodyText: 'Ran it locally against staging, works.', createdAt: '2026-10-02T09:00:00Z', author: human('sam') },
    ] },
  };
  const timeline = (JSON.parse(buildReadinessRequest(pull(), context)) as { state: { timeline: { at: string; from: string; text: string }[] } }).state.timeline;

  test('merges reviews and comments oldest first', () => {
    expect(timeline.map((entry) => entry.at)).toEqual([...timeline.map((entry) => entry.at)].sort());
  });

  test('keeps only the latest report per bot, plus bot approvals', () => {
    expect(timeline.filter((entry) => entry.from === 'devin-ai-integration').map((entry) => entry.text)).toEqual(['Devin Review found no new issues.']);
    expect(timeline.some((entry) => entry.text.startsWith('Approve: my round-1'))).toBe(true);
  });

  test('drops agent status lines and mutation reports', () => {
    expect(timeline.some((entry) => entry.text.includes('deliberate bugs') || entry.text.startsWith("I'll fix CI"))).toBe(false);
    expect(timeline.some((entry) => entry.text.startsWith('Ran it locally'))).toBe(true);
  });
});
