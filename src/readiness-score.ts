import type { PullRequest } from './github';
import { isConflicted, isFailing } from './status';

/** Jev's answers, each 0–1. `blocker` is the probability that an unresolved concern remains. */
export interface ReadinessSignals {
  evidence: number;
  risk: number;
  blocker: number;
  scope: number;
  tested: number;
}

export interface ReadinessBreakdown {
  score: number;
  facts: number;
  judgement: number;
  blockerPenalty: number;
  cap: number | null;
  capReason: string | null;
}

/** GitHub facts give up to 0.55; Jev adds up to 0.40 for what GitHub can't see, so a perfect pull tops out at 0.95. */
const REVIEW_WEIGHT: Record<'APPROVED' | 'REVIEW_REQUIRED' | 'NONE' | 'CHANGES_REQUESTED', number> = { APPROVED: 0.3, REVIEW_REQUIRED: 0.12, NONE: 0.12, CHANGES_REQUESTED: 0 };
const CHECKS_WEIGHT = 0.1;
const MERGEABLE_WEIGHT = 0.1;
const THREADS_WEIGHT = 0.05;
const EVIDENCE_WEIGHT = 0.15;
const TESTED_WEIGHT = 0.15;
const SCOPE_WEIGHT = 0.05;
/** A small nudge for low-risk changes; risk is shown separately and never sinks a well-reviewed pull. */
const LOW_RISK_WEIGHT = 0.05;
/** Jev's blocker odds sit around 0.2–0.45 on clean pulls, so only confident answers cost points. */
const BLOCKER_THRESHOLD = 0.5;
const BLOCKER_SLOPE = 0.5;

const clamp = (value: number): number => Math.min(1, Math.max(0, value));

function reviewPoints(pull: PullRequest): number {
  return REVIEW_WEIGHT[pull.reviewDecision ?? 'NONE'];
}

function checkPoints(pull: PullRequest): number {
  if (isFailing(pull)) return 0;
  if (pull.checkState === 'SUCCESS' || (pull.failingRequired != null && pull.checkState !== 'PENDING' && pull.checkState !== 'EXPECTED')) return CHECKS_WEIGHT;
  return CHECKS_WEIGHT / 2;
}

function mergePoints(pull: PullRequest): number {
  if (isConflicted(pull)) return 0;
  if (pull.mergeStateStatus === 'CLEAN' || pull.mergeStateStatus === 'HAS_HOOKS' || pull.mergeStateStatus === 'BLOCKED') return MERGEABLE_WEIGHT;
  return MERGEABLE_WEIGHT / 2;
}

/** Hard ceilings: a pull GitHub would refuse to merge can't look ready however good the review is. */
function capFor(pull: PullRequest): { cap: number; reason: string } | null {
  if (pull.reviewDecision === 'CHANGES_REQUESTED') return { cap: 0.45, reason: 'changes requested' };
  if (pull.isDraft) return { cap: 0.5, reason: 'draft' };
  if (isFailing(pull)) return { cap: 0.5, reason: 'required checks failing' };
  if (isConflicted(pull)) return { cap: 0.55, reason: 'merge conflicts' };
  return null;
}

export function readinessBreakdown(pull: PullRequest, signals: ReadinessSignals): ReadinessBreakdown {
  const facts = reviewPoints(pull) + checkPoints(pull) + mergePoints(pull) + ((pull.openThreads ?? 0) === 0 ? THREADS_WEIGHT : 0);
  const judgement = EVIDENCE_WEIGHT * clamp(signals.evidence) + TESTED_WEIGHT * clamp(signals.tested) + SCOPE_WEIGHT * clamp(signals.scope) + LOW_RISK_WEIGHT * (1 - clamp(signals.risk));
  const blockerPenalty = Math.max(0, clamp(signals.blocker) - BLOCKER_THRESHOLD) * BLOCKER_SLOPE;
  const cap = capFor(pull);
  const raw = clamp(facts + judgement - blockerPenalty);
  return { score: cap == null ? raw : Math.min(raw, cap.cap), facts, judgement, blockerPenalty, cap: cap?.cap ?? null, capReason: cap?.reason ?? null };
}

export function readinessScoreOf(pull: PullRequest, signals: ReadinessSignals): number {
  return readinessBreakdown(pull, signals).score;
}
