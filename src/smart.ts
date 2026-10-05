import type { PullRequest } from './github';

export type SmartFilter = 'all' | 'ready' | 'small' | 'recent' | 'attention' | 'tested' | 'threads';
export type SortOrder = 'smart' | 'updated' | 'size';

export const SMALL_DIFF_LINES = 150;
export const RECENT_HOURS = 48;

const HOUR_MS = 3_600_000;

export function diffSize(pull: PullRequest): number {
  return pull.additions + pull.deletions;
}

export function hoursSinceUpdate(pull: PullRequest, now: number): number {
  return (now - Date.parse(pull.updatedAt)) / HOUR_MS;
}

export function isGreen(pull: PullRequest): boolean {
  if (pull.failingRequired != null && pull.checkState !== 'PENDING' && pull.checkState !== 'EXPECTED') return pull.failingRequired.length === 0;
  return pull.checkState === 'SUCCESS';
}

export function isApproved(pull: PullRequest): boolean {
  return pull.reviewDecision === 'APPROVED';
}

export function isMergeStateKnown(pull: PullRequest): boolean {
  return pull.mergeStateStatus !== 'UNKNOWN';
}

export function isMergeable(pull: PullRequest): boolean {
  if (pull.isDraft || pull.mergeable === 'CONFLICTING') return false;
  return pull.mergeStateStatus === 'CLEAN' || pull.mergeStateStatus === 'HAS_HOOKS';
}

export function isReady(pull: PullRequest): boolean {
  if (pull.queueEntry != null) return false;
  return isGreen(pull) && isMergeable(pull) && pull.reviewDecision !== 'CHANGES_REQUESTED';
}

export function isSmall(pull: PullRequest): boolean {
  return diffSize(pull) <= SMALL_DIFF_LINES;
}

export function isRecent(pull: PullRequest, now: number): boolean {
  return hoursSinceUpdate(pull, now) <= RECENT_HOURS;
}

export function matchesSmartFilter(pull: PullRequest, filter: SmartFilter, now: number): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'ready':
      return isReady(pull);
    case 'small':
      return isSmall(pull);
    case 'recent':
      return isRecent(pull, now);
    case 'attention':
    case 'tested':
      return true;
    case 'threads':
      return (pull.openThreads ?? 0) > 0;
    default:
      return filter satisfies never;
  }
}

export function readinessScore(pull: PullRequest, now: number): number {
  const readiness = (isReady(pull) ? 1_000 : 0) + (isApproved(pull) ? 400 : 0) + (isGreen(pull) ? 200 : 0) + (isMergeable(pull) ? 100 : 0);
  const sizePenalty = Math.min(300, Math.log2(1 + diffSize(pull)) * 25);
  const agePenalty = Math.min(200, hoursSinceUpdate(pull, now) * 1.5);
  const blockedPenalty = pull.isDraft || pull.mergeable === 'CONFLICTING' || pull.reviewDecision === 'CHANGES_REQUESTED' ? 800 : 0;
  return readiness - sizePenalty - agePenalty - blockedPenalty;
}

export type AiScoreLookup = (pull: PullRequest) => number | undefined;

const AI_SCORE_WEIGHT = 1_200;

export function smartScore(pull: PullRequest, now: number, aiScore: AiScoreLookup): number {
  const ai = aiScore(pull);
  const blockedPenalty = pull.isDraft || pull.mergeable === 'CONFLICTING' || (pull.failingRequired != null ? pull.failingRequired.length > 0 : pull.checkState === 'FAILURE' || pull.checkState === 'ERROR') ? 800 : 0;
  if (ai == null) return readinessScore(pull, now);
  return ai * AI_SCORE_WEIGHT + (isGreen(pull) ? 150 : 0) + (isMergeable(pull) ? 100 : 0) - Math.min(100, hoursSinceUpdate(pull, now) * 0.5) - blockedPenalty;
}

export function sortPulls(pulls: readonly PullRequest[], order: SortOrder, now: number, aiScore: AiScoreLookup = () => undefined): PullRequest[] {
  const sorted = [...pulls];
  switch (order) {
    case 'smart':
    {
      const scores = new Map(sorted.map((pull) => [pull.id, smartScore(pull, now, aiScore)]));
      return sorted.sort((left, right) => (scores.get(right.id) ?? 0) - (scores.get(left.id) ?? 0));
    }
    case 'updated': {
      const times = new Map(sorted.map((pull) => [pull.id, Date.parse(pull.updatedAt)]));
      return sorted.sort((left, right) => (times.get(right.id) ?? 0) - (times.get(left.id) ?? 0));
    }
    case 'size':
      return sorted.sort((left, right) => diffSize(left) - diffSize(right));
    default:
      return order satisfies never;
  }
}
