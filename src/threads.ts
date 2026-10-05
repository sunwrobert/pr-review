import { invoke } from '@tauri-apps/api/core';
import type { PullRequest } from './github';

export interface ThreadComment {
  id: string;
  author: string;
  avatarUrl: string | null;
  isBot: boolean;
  html: string;
  at: string;
  url: string;
}

export interface ReviewThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  canResolve: boolean;
  comments: ThreadComment[];
  totalComments: number;
}

interface RawAuthor {
  login: string;
  avatarUrl: string;
  __typename: string;
}

interface ThreadsResponse {
  data?: {
    repository: {
      pullRequest: {
        reviewThreads: {
          nodes: {
            id: string;
            isResolved: boolean;
            isOutdated: boolean;
            path: string;
            line: number | null;
            originalLine: number | null;
            viewerCanResolve: boolean;
            comments: { totalCount: number; nodes: { id: string; bodyHTML: string; createdAt: string; url: string; author: RawAuthor | null }[] };
          }[];
        };
      } | null;
    } | null;
  };
  errors?: { message: string }[];
}

const cache = new Map<string, Promise<ReviewThread[]>>();

function isBot(author: RawAuthor | null): boolean {
  return author != null && (author.__typename === 'Bot' || author.login.endsWith('[bot]'));
}

async function fetchThreads(pull: PullRequest): Promise<ReviewThread[]> {
  const response: ThreadsResponse = JSON.parse(await invoke<string>('threads', { repo: pull.repository.nameWithOwner, number: pull.number }));
  const pr = response.data?.repository?.pullRequest;
  if (pr == null) throw new Error(response.errors?.[0]?.message ?? 'Review threads unavailable');
  return pr.reviewThreads.nodes.map((node) => ({
    id: node.id,
    isResolved: node.isResolved,
    isOutdated: node.isOutdated,
    path: node.path,
    line: node.line ?? node.originalLine,
    canResolve: node.viewerCanResolve,
    totalComments: node.comments.totalCount,
    comments: node.comments.nodes.map((comment) => ({
      id: comment.id,
      author: comment.author?.login ?? 'ghost',
      avatarUrl: comment.author?.avatarUrl ?? null,
      isBot: isBot(comment.author),
      html: comment.bodyHTML,
      at: comment.createdAt,
      url: comment.url,
    })),
  }));
}

export function loadThreads(pull: PullRequest, isFresh = false): Promise<ReviewThread[]> {
  const key = pull.id;
  if (isFresh) cache.delete(key);
  const cached = cache.get(key);
  if (cached != null) return cached;
  const pending = fetchThreads(pull);
  pending.catch(() => cache.delete(key));
  cache.set(key, pending);
  return pending;
}

export async function setThreadResolved(threadId: string, resolved: boolean): Promise<void> {
  await invoke<string>('set_thread_resolved', { threadId, resolved });
}

export async function replyToThread(threadId: string, body: string): Promise<void> {
  await invoke<string>('reply_to_thread', { threadId, body });
}

export function forgetThreads(pull: PullRequest): void {
  cache.delete(pull.id);
}
