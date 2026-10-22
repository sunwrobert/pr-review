import fc from 'fast-check';
import type { PullRequest } from '../github';

const NOW = Date.parse('2026-09-26T12:00:00Z');

export const FIXED_NOW = NOW;

export const pullArbitrary: fc.Arbitrary<PullRequest> = fc.record({
  id: fc.uuid(),
  number: fc.integer({ min: 1, max: 99_999 }),
  title: fc.string({ maxLength: 120 }),
  isDraft: fc.boolean(),
  createdAgoHours: fc.integer({ min: 0, max: 24 * 90 }),
  updatedAgoHours: fc.integer({ min: 0, max: 24 * 60 }),
  additions: fc.integer({ min: 0, max: 20_000 }),
  deletions: fc.integer({ min: 0, max: 20_000 }),
  changedFiles: fc.integer({ min: 0, max: 400 }),
  mergeable: fc.constantFrom('MERGEABLE', 'CONFLICTING', 'UNKNOWN') as fc.Arbitrary<PullRequest['mergeable']>,
  mergeStateStatus: fc.constantFrom('CLEAN', 'HAS_HOOKS', 'UNSTABLE', 'BLOCKED', 'BEHIND', 'DIRTY', 'DRAFT', 'UNKNOWN'),
  reviewDecision: fc.constantFrom('APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED', null) as fc.Arbitrary<PullRequest['reviewDecision']>,
  checkState: fc.constantFrom('SUCCESS', 'FAILURE', 'ERROR', 'PENDING', 'EXPECTED', null) as fc.Arbitrary<PullRequest['checkState']>,
  queueEntry: fc.option(fc.record({ position: fc.integer({ min: 0, max: 30 }), state: fc.constantFrom('QUEUED', 'AWAITING_CHECKS', 'MERGEABLE', 'UNMERGEABLE') }), { nil: null }),
  repo: fc.constantFrom('o/web', 'o/api', 'o/plugins'),
}).map(({ createdAgoHours, updatedAgoHours, repo, ...rest }): PullRequest => ({
  ...rest,
  url: `https://github.com/${repo}/pull/${rest.number}`,
  createdAt: new Date(NOW - createdAgoHours * 3_600_000).toISOString(),
  updatedAt: new Date(NOW - updatedAgoHours * 3_600_000).toISOString(),
  headRefName: `branch-${rest.number}`,
  baseRefName: 'main',
  stack: null,
  author: { login: 'author', avatarUrl: '' },
  repository: { nameWithOwner: repo },
}));

export const pullListArbitrary: fc.Arbitrary<PullRequest[]> = fc.uniqueArray(pullArbitrary, { maxLength: 150, selector: (pull) => pull.url });
