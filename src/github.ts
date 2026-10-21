import { invoke } from '@tauri-apps/api/core';

export type QueueKind = 'review' | 'mine' | 'involved';
export type MergeMethod = 'squash' | 'merge' | 'rebase';
export type MergeableState = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
export type CheckState = 'SUCCESS' | 'FAILURE' | 'ERROR' | 'PENDING' | 'EXPECTED';

export interface PullRequest {
  id: string;
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  headRefName: string;
  baseRefName: string;
  mergeable: MergeableState;
  mergeStateStatus: string;
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  author: { login: string; avatarUrl: string } | null;
  repository: { nameWithOwner: string };
  checkState: CheckState | null;
  queueEntry: { position: number; state: string } | null;
  openThreads?: number;
  /** Names of required checks that failed; undefined until merge states load. */
  failingRequired?: string[];
  failingOptional?: number;
}

export interface MergeState {
  id: string;
  mergeable: MergeableState;
  mergeStateStatus: string;
  openThreads: number;
  failingRequired: string[];
  failingOptional: number;
}

interface RawCheck {
  __typename: 'CheckRun' | 'StatusContext';
  name?: string;
  context?: string;
  conclusion?: string | null;
  state?: string;
  isRequired?: boolean;
}

interface RawMergeState {
  id: string;
  mergeable: MergeableState;
  mergeStateStatus: string;
  reviewThreads?: { nodes: { isResolved: boolean; isOutdated: boolean }[] };
  commits?: { nodes: { commit: { statusCheckRollup: { contexts: { nodes: (RawCheck | null)[] } } | null } }[] };
}

const FAILED_CHECK = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);

function toMergeState({ reviewThreads, commits, ...rest }: RawMergeState): MergeState {
  const checks = (commits?.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? []).filter((check): check is RawCheck => check != null);
  const failed = checks.filter((check) => FAILED_CHECK.has(check.conclusion ?? check.state ?? ''));
  const required = failed.filter((check) => check.isRequired === true);
  return {
    ...rest,
    openThreads: (reviewThreads?.nodes ?? []).filter((thread) => !thread.isResolved).length,
    failingRequired: required.map((check) => check.name ?? check.context ?? 'check'),
    failingOptional: failed.length - required.length,
  };
}

interface RawPullRequest extends Omit<PullRequest, 'checkState' | 'mergeable' | 'mergeStateStatus' | 'queueEntry'> {
  mergeQueueEntry: { position: number; state: string } | null;
  commits: { nodes: { commit: { statusCheckRollup: { state: CheckState } | null } }[] };
}

interface QueuePage {
  data?: { search: { nodes: (RawPullRequest | Record<string, never>)[] } };
  errors?: { message: string }[];
}

function isPullRequest(node: RawPullRequest | Record<string, never>): node is RawPullRequest {
  return typeof node.number === 'number';
}

function toPullRequest({ commits, mergeQueueEntry, ...pull }: RawPullRequest): PullRequest {
  return { ...pull, queueEntry: mergeQueueEntry ?? null, mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN', checkState: commits.nodes[0]?.commit.statusCheckRollup?.state ?? null };
}

const MERGE_STATE_BATCH = 20;

interface MergeStateResponse {
  data?: Record<string, RawMergeState | null>;
  errors?: { message: string }[];
}

export async function fetchMergeStates(ids: readonly string[], onBatch: (states: MergeState[]) => void): Promise<void> {
  const batches = Array.from({ length: Math.ceil(ids.length / MERGE_STATE_BATCH) }, (_, index) => ids.slice(index * MERGE_STATE_BATCH, (index + 1) * MERGE_STATE_BATCH));
  const results = await Promise.allSettled(
    batches.map(async (batch) => {
      const response: MergeStateResponse = JSON.parse(await invoke<string>('merge_states', { ids: batch }));
      if (response.data == null) throw new Error(response.errors?.map((error) => error.message).join('; ') ?? 'Empty response');
      onBatch(Object.values(response.data).filter((node): node is RawMergeState => node?.id != null).map(toMergeState));
    }),
  );
  const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failure != null) throw failure.reason instanceof Error ? failure.reason : new Error(String(failure.reason));
}

export async function fetchQueue(kind: QueueKind): Promise<PullRequest[]> {
  const parsed: QueuePage | QueuePage[] = JSON.parse(await invoke<string>('queue', { kind }));
  const pages = Array.isArray(parsed) ? parsed : [parsed];
  const failed = pages.find((page) => page.data == null);
  if (failed != null) throw new Error(failed.errors?.map((error) => error.message).join('; ') ?? 'Empty response');
  const seen = new Set<string>();
  return pages
    .flatMap((page) => page.data?.search.nodes ?? [])
    .filter(isPullRequest)
    .filter((node) => !seen.has(node.id) && seen.add(node.id) != null)
    .map(toPullRequest);
}

type RawStatePull = RawPullRequest & { state: string };

interface PullResponse {
  data?: { repository: { pullRequest: (RawStatePull & { stack: { baseRefName: string; entries: { nodes: { position: number; pullRequest: RawStatePull }[] } } | null }) | null } | null };
  errors?: { message: string }[];
}

/** GitHub's native stack: the branch it merges into and its open pulls, bottom first. */
export interface NativeStack {
  baseRefName: string;
  pulls: PullRequest[];
}

interface NeighborsResponse {
  data?: { repository: { above: { nodes: RawPullRequest[] }; below: { nodes: RawPullRequest[] } } | null };
  errors?: { message: string }[];
}

/** One pull by number, open or not, with its native GitHub stack when it has one. */
export async function fetchPull(repo: string, number: number): Promise<{ pull: PullRequest; isOpen: boolean; stack: NativeStack | null }> {
  const response: PullResponse = JSON.parse(await invoke<string>('pull', { repo, number }));
  const raw = response.data?.repository?.pullRequest;
  if (raw == null) throw new Error(response.errors?.map((error) => error.message).join('; ') ?? `${repo}#${number} not found`);
  const { state, stack, ...rest } = raw;
  const entries = [...(stack?.entries.nodes ?? [])].sort((left, right) => left.position - right.position);
  const pulls = entries.filter((entry) => entry.pullRequest.state === 'OPEN').map(({ pullRequest: { state: _state, ...open } }) => toPullRequest(open));
  return { pull: toPullRequest(rest), isOpen: state === 'OPEN', stack: stack == null ? null : { baseRefName: stack.baseRefName, pulls } };
}

/** Open pulls stacked on `pull` and the open pull it is stacked on. */
export async function fetchStackNeighbors(pull: PullRequest): Promise<PullRequest[]> {
  const response: NeighborsResponse = JSON.parse(await invoke<string>('stack_neighbors', { repo: pull.repository.nameWithOwner, head: pull.headRefName, base: pull.baseRefName }));
  const repository = response.data?.repository;
  if (repository == null) throw new Error(response.errors?.map((error) => error.message).join('; ') ?? 'Empty response');
  return [...repository.below.nodes, ...repository.above.nodes].map(toPullRequest);
}

export function fetchBody(pull: PullRequest): Promise<string> {
  return invoke<string>('body', { repo: pull.repository.nameWithOwner, number: pull.number });
}

export function fetchDiff(pull: PullRequest): Promise<string> {
  return invoke<string>('diff', { repo: pull.repository.nameWithOwner, number: pull.number });
}

let viewerLogin: Promise<string | null> | null = null;

export function fetchViewerLogin(): Promise<string | null> {
  viewerLogin ??= invoke<string>('viewer').then((login) => (login === '' ? null : login)).catch(() => null);
  return viewerLogin;
}

export function commentOnPull(pull: PullRequest, body: string): Promise<string> {
  return invoke<string>('comment', { repo: pull.repository.nameWithOwner, number: pull.number, body });
}

export function messageDevinSession(sessionId: string, message: string): Promise<string> {
  return invoke<string>('message_devin', { sessionId, message });
}

export function approvePull(pull: PullRequest): Promise<string> {
  return invoke<string>('approve', { repo: pull.repository.nameWithOwner, number: pull.number });
}

export function closePull(pull: PullRequest, comment: string): Promise<string> {
  return invoke<string>('close', { repo: pull.repository.nameWithOwner, number: pull.number, comment: comment === '' ? null : comment });
}

interface MergeQueueResponse {
  data?: { repository: { mergeQueue: { url: string } | null } | null };
}

const mergeQueueCache = new Map<string, Promise<boolean>>();

/** Whether `base` (the PR's own base, or its stack's base for a stacked PR) merges through a queue. */
export function usesMergeQueue(pull: PullRequest, base = pull.baseRefName): Promise<boolean> {
  const key = `${pull.repository.nameWithOwner}#${base}`;
  const cached = mergeQueueCache.get(key);
  if (cached != null) return cached;
  const pending = invoke<string>('merge_queue', { repo: pull.repository.nameWithOwner, base })
    .then((raw) => (JSON.parse(raw) as MergeQueueResponse).data?.repository?.mergeQueue != null)
    .catch(() => false);
  mergeQueueCache.set(key, pending);
  return pending;
}

export function mergePull(pull: PullRequest, method: MergeMethod, queued: boolean): Promise<string> {
  return invoke<string>('merge', { repo: pull.repository.nameWithOwner, number: pull.number, method, queued, nodeId: pull.id });
}

export function openInBrowser(url: string): Promise<void> {
  return invoke<void>('open_in_browser', { url });
}
