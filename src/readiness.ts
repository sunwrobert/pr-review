import { invoke } from '@tauri-apps/api/core';
import type { PullRequest } from './github';
import { readinessScoreOf, type ReadinessSignals } from './readiness-score';

/** Jev's signals for one pull; the score is derived from them plus live GitHub facts (see readiness-score.ts). */
export interface ReadinessResult extends ReadinessSignals {
  reason: string;
}

interface Author {
  login: string;
  __typename: 'User' | 'Bot' | 'Mannequin' | 'EnterpriseUserAccount' | 'Organization';
}

export interface ReviewContext {
  body: string;
  files: { totalCount: number; nodes: { path: string; additions: number; deletions: number }[] };
  reviews: { nodes: { state: string; bodyText: string; submittedAt: string | null; author: Author | null }[] };
  comments: { nodes: { bodyText: string; createdAt: string; author: Author | null }[] };
  reviewThreads: { nodes: { isResolved: boolean; isOutdated: boolean }[] };
}

interface ContextResponse {
  data?: { repository: { pullRequest: ReviewContext | null } | null };
  errors?: { message: string }[];
}

interface ScoreAnswer {
  type: 'score';
  score: number;
  confidence: number;
}

interface NoulAnswer {
  type: 'noul';
  noul: number;
}

export interface SystemOneResponse {
  answers?: Record<string, ScoreAnswer | NoulAnswer>;
  error?: { message?: string };
}

const MAX_TEXT_CHARS = 1_500;
const MAX_BODY_CHARS = 4_000;
const MAX_TIMELINE_ITEMS = 20;
/** Bot boilerplate that reads like a concern but never is one (agent status lines, mutation and lint reports). */
const NOISE_PATTERNS: readonly RegExp[] = [/^I'll fix CI failures/i, /We planted \d+ small deliberate bugs/i, /^@devin triage the surviving mutants/i, /Fallow audit report/i, /This comment will be updated automatically/i];

const QUESTIONS = {
  merge_evidence: {
    type: 'score',
    instructions:
      'Across the `pull_request.body` and `timeline`, how strong is the explicit evidence that this pull request has been reviewed, verified and is ready to merge? Count concrete signals such as approving reviews that engage with the change, statements that feedback was addressed, reported test or end-to-end verification results, passing checks, and sign-off language. Automated reviewers and bots count when they state a concrete verdict.',
    criteria: [
      'No evidence of review or verification',
      'Weak or generic signals only, such as a bare approval or an unverified claim',
      'Some concrete evidence: a substantive review or reported test results',
      'Strong evidence: a substantive approval plus reported verification, with feedback addressed',
      'Overwhelming evidence: multiple independent substantive approvals or verifications, all feedback resolved, explicit ready-to-merge sign-off',
    ],
  },
  outstanding_blockers: {
    type: 'noul',
    instructions:
      'Read `timeline` in order (oldest first) together with `pull_request.body`. Is there a request for changes, an open question, a reported failing test, or a statement that the pull request is not ready (work in progress, do not merge, waiting on another change) that NO later entry resolves? A later approval, a reviewer saying the suggestion was taken or addressed, a newer report from the same automated reviewer, or the author saying it was fixed all resolve earlier concerns. Optional suggestions, nits and "worth a decision" notes that the reviewer says are not blockers do not count. Automated "potential issue" findings only count if they are in the latest entry from that reviewer and nothing later addresses them. `review_threads.unresolved` is the count of unresolved inline threads.',
    criteria: {
      true: 'At least one blocker or open concern is still outstanding',
      false: 'No outstanding blockers; any concerns raised were resolved',
    },
  },
  change_risk: {
    type: 'score',
    instructions:
      'Given the `files` list and the `pull_request.body`, how risky is merging this change? Consider what the changed paths touch (for example authentication, payments, data migrations, security boundaries, infrastructure, shared core libraries) versus low-risk areas (tests, documentation, styling, isolated leaf components), and how much behavior changes.',
    criteria: [
      'Trivial: documentation, comments, tests only, or cosmetic changes',
      'Low: small isolated change with clear, limited behavior impact',
      'Moderate: meaningful behavior change in a contained area',
      'High: touches shared core code, data handling, or user-facing flows broadly',
      'Critical: security, authentication, payments, migrations, or infrastructure with wide blast radius',
    ],
  },
  verified_testing: {
    type: 'score',
    instructions:
      'Across the `pull_request.body` and `timeline`, how strong is the evidence that this change was actually exercised end to end, not just unit tested? Count concrete reports of running the real app, service or API and observing the result: end-to-end or integration test runs with results, manual QA steps with outcomes, screenshots, recordings, before/after measurements, or a reviewer or bot stating they ran it. A test plan that was never run, or only unit tests, is weak evidence.',
    criteria: [
      'No testing mentioned',
      'Only claims, an unrun test plan, or unit tests only',
      'Some real verification reported, such as an integration test run or manual check without detail',
      'Clear end-to-end verification with concrete results, commands or screenshots',
      'Thorough end-to-end proof: recorded runs or screenshots plus independent confirmation by a reviewer or bot',
    ],
  },
  scope_clarity: {
    type: 'score',
    instructions: 'How focused and clearly explained is this pull request, judging by the `pull_request.body` and whether the `files` match the stated purpose?',
    criteria: [
      'No description, or files unrelated to any stated purpose',
      'Vague description or scattered changes',
      'Reasonable description; files mostly match the purpose',
      'Clear description with rationale; files match the purpose',
      'Precise, well-scoped description with testing notes; every file clearly serves the purpose',
    ],
  },
} as const;

function clip(text: string, limit: number): string {
  const trimmed = text.replace(/\n{3,}/g, '\n\n').trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

function isAutomated(author: Author | null): boolean {
  return author != null && (author.__typename === 'Bot' || author.login.endsWith('[bot]') || /(?:^|-)(?:bot|ai-integration|pr-reviewer|pr-maintainer)(?:$|-)/i.test(author.login));
}

interface TimelineEntry {
  at: string;
  from: string;
  automated: boolean;
  kind: string;
  text: string;
}

/** Reviews and comments merged oldest first. Only the latest entry per automated author survives, since bots re-post updated reports. */
function buildTimeline(context: ReviewContext): TimelineEntry[] {
  const reviews = context.reviews.nodes
    .filter((review) => review.bodyText.trim() !== '' || review.state === 'APPROVED' || review.state === 'CHANGES_REQUESTED')
    .map((review) => ({ at: review.submittedAt ?? '', author: review.author, kind: `review: ${review.state.toLowerCase()}`, text: review.bodyText }));
  const comments = context.comments.nodes.filter((comment) => comment.bodyText.trim() !== '').map((comment) => ({ at: comment.createdAt, author: comment.author, kind: 'comment', text: comment.bodyText }));
  const entries = [...reviews, ...comments]
    .filter((entry) => !NOISE_PATTERNS.some((pattern) => pattern.test(entry.text.trim())))
    .sort((left, right) => left.at.localeCompare(right.at));
  const latestBotIndex = new Map(entries.flatMap((entry, index) => (isAutomated(entry.author) ? [[`${entry.author?.login}:${entry.kind === 'comment' ? 'comment' : 'review'}`, index] as const] : [])));
  return entries
    .filter((entry, index) => !isAutomated(entry.author) || entry.kind.endsWith('approved') || entry.kind.endsWith('changes_requested') || latestBotIndex.get(`${entry.author?.login}:${entry.kind === 'comment' ? 'comment' : 'review'}`) === index)
    .slice(-MAX_TIMELINE_ITEMS)
    .map((entry) => ({ at: entry.at.slice(0, 16), from: entry.author?.login ?? 'unknown', automated: isAutomated(entry.author), kind: entry.kind, text: clip(entry.text, MAX_TEXT_CHARS) }));
}

function buildState(pull: PullRequest, context: ReviewContext): Record<string, unknown> {
  const threads = context.reviewThreads.nodes;
  return {
    pull_request: {
      title: pull.title,
      body: clip(context.body, MAX_BODY_CHARS),
      is_draft: pull.isDraft,
      lines_added: pull.additions,
      lines_deleted: pull.deletions,
      files_changed: pull.changedFiles,
      checks: pull.checkState ?? 'none',
      github_review_decision: pull.reviewDecision ?? 'none',
      hours_since_update: Math.round((Date.now() - Date.parse(pull.updatedAt)) / 3_600_000),
    },
    files: context.files.nodes.slice(0, 60).map((file) => `${file.path} (+${file.additions} -${file.deletions})`),
    review_threads: { total: threads.length, unresolved: threads.filter((thread) => !thread.isResolved && !thread.isOutdated).length },
    timeline: buildTimeline(context),
  };
}

function scoreOf(answers: Record<string, ScoreAnswer | NoulAnswer>, key: string): number {
  const answer = answers[key];
  return answer?.type === 'score' ? answer.score / 4 : 0;
}

function noulOf(answers: Record<string, ScoreAnswer | NoulAnswer>, key: string): number {
  const answer = answers[key];
  return answer?.type === 'noul' ? answer.noul : 0;
}

function describe(signals: ReadinessSignals): string {
  const parts = [
    signals.evidence >= 0.75 ? 'strong sign-off' : signals.evidence >= 0.5 ? 'reviewed' : 'little review evidence',
    signals.blocker >= 0.5 ? 'open concerns' : null,
    signals.tested >= 0.75 ? 'e2e tested' : null,
    signals.risk >= 0.75 ? 'high-risk area' : signals.risk <= 0.25 ? 'low risk' : null,
  ];
  return parts.filter((part) => part != null).join(' · ');
}

/** Combined 0–1 readiness: live GitHub facts first, Jev's judgement on top. */
export function readinessScore(pull: PullRequest, result: ReadinessSignals): number {
  return readinessScoreOf(pull, result);
}

export function isReadinessAvailable(): Promise<boolean> {
  return invoke<boolean>('readiness_available').catch(() => false);
}

export async function assessReadiness(pull: PullRequest): Promise<ReadinessResult> {
  const contextResponse: ContextResponse = JSON.parse(await invoke<string>('review_context', { repo: pull.repository.nameWithOwner, number: pull.number }));
  const context = contextResponse.data?.repository?.pullRequest;
  if (context == null) throw new Error(contextResponse.errors?.[0]?.message ?? 'Pull request context unavailable');
  const response: SystemOneResponse = JSON.parse(await invoke<string>('readiness', { request: buildReadinessRequest(pull, context) }));
  return toReadinessResult(response);
}

export function buildReadinessRequest(pull: PullRequest, context: ReviewContext): string {
  return JSON.stringify({ model: 'jev-latest', state: buildState(pull, context), questions: QUESTIONS });
}

export function toReadinessResult(response: SystemOneResponse): ReadinessResult {
  const answers = response.answers;
  if (answers == null) throw new Error(response.error?.message ?? 'No answers returned');
  const evidence = scoreOf(answers, 'merge_evidence');
  const blocker = noulOf(answers, 'outstanding_blockers');
  const risk = scoreOf(answers, 'change_risk');
  const scope = scoreOf(answers, 'scope_clarity');
  const tested = scoreOf(answers, 'verified_testing');
  const signals = { evidence, risk, blocker, scope, tested };
  return { ...signals, reason: describe(signals) };
}
