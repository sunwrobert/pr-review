import { invoke } from '@tauri-apps/api/core';
import type { ConversationItem, AuthorKind } from './conversation';
import type { PullRequest } from './github';
import type { ReviewThread } from './threads';

export interface PullDetails {
  bodyHtml: string;
  conversation: ConversationItem[];
  threads: ReviewThread[];
}

interface RawAuthor {
  login: string;
  avatarUrl: string;
  __typename: AuthorKind;
}

interface PullDetailsResponse {
  data?: {
    repository: {
      pullRequest: {
        bodyHTML: string | null;
        comments: { totalCount: number; nodes: { id: string; bodyHTML: string; createdAt: string; url: string; author: RawAuthor | null }[] };
        reviews: { totalCount: number; nodes: { id: string; state: string; bodyHTML: string; submittedAt: string | null; url: string; author: RawAuthor | null; comments: { totalCount: number } }[] };
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

const CACHE_LIMIT = 24;
const cache = new Map<string, Promise<PullDetails>>();

function isBotAuthor(author: RawAuthor | null): boolean {
  return author != null && (author.__typename === 'Bot' || author.login.endsWith('[bot]'));
}

export function parsePullDetails(raw: string): PullDetails {
  const response: PullDetailsResponse = JSON.parse(raw);
  const pr = response.data?.repository?.pullRequest;
  if (pr == null) throw new Error(response.errors?.[0]?.message ?? 'Pull request details unavailable');
  const comments = pr.comments.nodes.map((node): ConversationItem => ({
    id: node.id,
    kind: 'comment',
    author: node.author?.login ?? 'ghost',
    avatarUrl: node.author?.avatarUrl ?? null,
    isBot: isBotAuthor(node.author),
    html: node.bodyHTML,
    at: node.createdAt,
    url: node.url,
    reviewState: null,
    inlineCount: 0,
  }));
  const reviews = pr.reviews.nodes
    .filter((node) => node.bodyHTML.trim() !== '' || node.state === 'APPROVED' || node.state === 'CHANGES_REQUESTED' || node.comments.totalCount > 0)
    .map((node): ConversationItem => ({
      id: node.id,
      kind: 'review',
      author: node.author?.login ?? 'ghost',
      avatarUrl: node.author?.avatarUrl ?? null,
      isBot: isBotAuthor(node.author),
      html: node.bodyHTML,
      at: node.submittedAt ?? '',
      url: node.url,
      reviewState: node.state,
      inlineCount: node.comments.totalCount,
    }));
  const conversation = [...comments, ...reviews].sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  const threads: ReviewThread[] = pr.reviewThreads.nodes.map((node) => ({
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
      isBot: isBotAuthor(comment.author),
      html: comment.bodyHTML,
      at: comment.createdAt,
      url: comment.url,
    })),
  }));
  return { bodyHtml: pr.bodyHTML ?? '', conversation, threads };
}

export function diffCacheKey(pull: Pick<PullRequest, 'id' | 'headRefOid' | 'baseRefName' | 'updatedAt'>): string {
  return `${pull.id}:${pull.headRefOid ?? pull.updatedAt}:${pull.baseRefName}`;
}

export function invalidatePullDetails(pull: Pick<PullRequest, 'id'>): void {
  [...cache.keys()].filter((key) => key.startsWith(`${pull.id}:`)).forEach((key) => cache.delete(key));
}

/** Loads description, conversation and review threads in one GraphQL call, shared across all three consumers. */
export function loadPullDetails(pull: PullRequest, isFresh = false): Promise<PullDetails> {
  const key = `${pull.id}:${pull.updatedAt}`;
  if (isFresh) cache.delete(key);
  const cached = cache.get(key);
  if (cached != null) return cached;
  const pending = invoke<string>('pull_details', { repo: pull.repository.nameWithOwner, number: pull.number }).then(parsePullDetails);
  pending.catch(() => cache.delete(key));
  cache.set(key, pending);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value ?? '');
  return pending;
}
