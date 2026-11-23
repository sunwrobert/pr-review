import type { PullRequest } from './github';
import { invalidatePullDetails, loadPullDetails } from './pull-details';

export type AuthorKind = 'User' | 'Bot' | 'Mannequin' | 'Organization' | 'EnterpriseUserAccount';

export interface ConversationItem {
  id: string;
  kind: 'comment' | 'review';
  author: string;
  avatarUrl: string | null;
  isBot: boolean;
  html: string;
  at: string;
  url: string;
  reviewState: string | null;
  inlineCount: number;
}

export function invalidateConversation(pull: PullRequest): void {
  invalidatePullDetails(pull);
}

export function loadConversation(pull: PullRequest): Promise<ConversationItem[]> {
  return loadPullDetails(pull).then((details) => details.conversation);
}
