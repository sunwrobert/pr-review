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
  /** GitHub's native stack: the branch it merges into and how many open pulls one merge of this pull lands (itself and those below). */
  stack: { baseRefName: string; mergeCount: number } | null;
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

export interface MergeStateUpdate {
  id: string;
  mergeable?: MergeableState;
  mergeStateStatus?: string;
  openThreads?: number;
  failingRequired?: string[];
  failingOptional?: number;
}

interface RawMergeState {
  id: string;
  mergeable?: MergeableState;
  mergeStateStatus?: string;
  reviewThreads?: { nodes: { isResolved: boolean }[] };
}

function toCoreMergeState({ id, mergeable, mergeStateStatus, reviewThreads }: RawMergeState): MergeStateUpdate {
  const update: MergeStateUpdate = { id };
  if (mergeable != null) update.mergeable = mergeable;
  if (mergeStateStatus != null) update.mergeStateStatus = mergeStateStatus;
  if (reviewThreads != null) update.openThreads = reviewThreads.nodes.filter((thread) => !thread.isResolved).length;
  return update;
}

interface FailingCheckRow {
  id: string;
  failingRequired: string[];
  failingOptional: number;
}

interface FailingChecksResponse {
  data?: FailingCheckRow[];
  errors?: { message: string }[];
}

interface RawStack {
  baseRefName: string;
  entries: { nodes: { position: number; pullRequest: { state: string } }[] };
}

interface RawPullRequest extends Omit<PullRequest, 'checkState' | 'mergeable' | 'mergeStateStatus' | 'queueEntry' | 'stack'> {
  mergeQueueEntry: { position: number; state: string } | null;
  stackEntry?: { position: number } | null;
  stack?: RawStack | null;
  commits: { nodes: { commit: { statusCheckRollup: { state: CheckState } | null } }[] };
}

interface QueuePage {
  data?: { search: { nodes: (RawPullRequest | Record<string, never>)[] } };
  errors?: { message: string }[];
}

function isPullRequest(node: RawPullRequest | Record<string, never>): node is RawPullRequest {
  return typeof node.number === 'number';
}

function toStack(stack: RawStack | null | undefined, position: number | undefined): PullRequest['stack'] {
  if (stack == null || position == null) return null;
  const mergeCount = stack.entries.nodes.filter((entry) => entry.position <= position && entry.pullRequest.state === 'OPEN').length;
  return { baseRefName: stack.baseRefName, mergeCount };
}

function toPullRequest({ commits, mergeQueueEntry, stackEntry, stack, ...pull }: RawPullRequest): PullRequest {
  return { ...pull, queueEntry: mergeQueueEntry ?? null, stack: toStack(stack, stackEntry?.position), mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN', checkState: commits.nodes[0]?.commit.statusCheckRollup?.state ?? null };
}

/** 12 per request matches the 12-slot HTTP pool and keeps GitHub's parallel mergeable workers saturated. */
const MERGE_STATE_BATCH = 12;
const CHECK_TARGET_BATCH = 25;

interface MergeStateResponse {
  data?: { nodes?: (RawMergeState | null)[] } | Record<string, RawMergeState | null>;
  errors?: { message: string }[];
}

function extractMergeStateNodes(data: MergeStateResponse['data']): RawMergeState[] {
  if (data == null) return [];
  const raw = Array.isArray((data as { nodes?: unknown }).nodes) ? (data as { nodes: (RawMergeState | null)[] }).nodes : Object.values(data as Record<string, RawMergeState | null>);
  return raw.filter((node): node is RawMergeState => node?.id != null);
}

export async function fetchMergeStates(pulls: readonly PullRequest[], onBatch: (states: MergeStateUpdate[]) => void): Promise<void> {
  if (pulls.length === 0) return;
  const cleanCheckUpdates: MergeStateUpdate[] = [];
  const checkTargets: { id: string; repo: string; base: string }[] = [];
  for (const pull of pulls) {
    if (pull.checkState == null || pull.checkState === 'SUCCESS') {
      cleanCheckUpdates.push({ id: pull.id, failingRequired: [], failingOptional: 0 });
    } else {
      checkTargets.push({ id: pull.id, repo: pull.repository.nameWithOwner, base: pull.stack?.baseRefName ?? pull.baseRefName });
    }
  }
  if (cleanCheckUpdates.length > 0) onBatch(cleanCheckUpdates);

  const ids = pulls.map((pull) => pull.id);
  const coreBatches = Array.from({ length: Math.ceil(ids.length / MERGE_STATE_BATCH) }, (_, index) => ids.slice(index * MERGE_STATE_BATCH, (index + 1) * MERGE_STATE_BATCH));
  const checkBatches = Array.from({ length: Math.ceil(checkTargets.length / CHECK_TARGET_BATCH) }, (_, index) => checkTargets.slice(index * CHECK_TARGET_BATCH, (index + 1) * CHECK_TARGET_BATCH));

  const results = await Promise.allSettled([
    ...coreBatches.map(async (batch) => {
      const response: MergeStateResponse = JSON.parse(await invoke<string>('merge_states', { ids: batch }));
      if (response.data == null) throw new Error(response.errors?.map((error) => error.message).join('; ') ?? 'Empty response');
      onBatch(extractMergeStateNodes(response.data).map(toCoreMergeState));
    }),
    ...checkBatches.map(async (batch) => {
      const response: FailingChecksResponse = JSON.parse(await invoke<string>('failing_checks', { pulls: batch }));
      if (response.data == null) throw new Error(response.errors?.map((error) => error.message).join('; ') ?? 'Empty response');
      onBatch(response.data.map((row) => ({ id: row.id, failingRequired: row.failingRequired, failingOptional: row.failingOptional })));
    }),
  ]);
  const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failure != null) throw failure.reason instanceof Error ? failure.reason : new Error(String(failure.reason));
}

export async function pollMergeStatuses(ids: readonly string[], onBatch: (states: MergeStateUpdate[]) => void): Promise<void> {
  if (ids.length === 0) return;
  const batches = Array.from({ length: Math.ceil(ids.length / MERGE_STATE_BATCH) }, (_, index) => ids.slice(index * MERGE_STATE_BATCH, (index + 1) * MERGE_STATE_BATCH));
  const results = await Promise.allSettled(
    batches.map(async (batch) => {
      const response: MergeStateResponse = JSON.parse(await invoke<string>('merge_status_poll', { ids: batch }));
      if (response.data == null) throw new Error(response.errors?.map((error) => error.message).join('; ') ?? 'Empty response');
      onBatch(extractMergeStateNodes(response.data).map(toCoreMergeState));
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
  data?: { repository: { pullRequest: (Omit<RawStatePull, 'stack'> & { stack: { baseRefName: string; entries: { nodes: { position: number; pullRequest: RawStatePull }[] } } | null }) | null } | null };
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
  const { state, ...rest } = raw;
  const { stack } = raw;
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

export function dequeuePull(pull: PullRequest): Promise<string> {
  return invoke<string>('dequeue', { pullId: pull.id });
}

export function mergePull(pull: PullRequest, method: MergeMethod, queued: boolean): Promise<string> {
  return invoke<string>('merge', { repo: pull.repository.nameWithOwner, number: pull.number, method, queued });
}

export function openInBrowser(url: string): Promise<void> {
  return invoke<void>('open_in_browser', { url });
}
