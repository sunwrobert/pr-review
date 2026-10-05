import { DEMO_CONFLICTS, DEMO_PULLS, demoBody, demoConversation, demoDiff } from '../demo';
import { generateBody, generateDiff, generatePulls, type FixturePull } from '../fixtures';

const COUNT = Number(new URLSearchParams(location.search).get('pulls') ?? 120);
const LATENCY_MS = Number(new URLSearchParams(location.search).get('latency') ?? 0);
const IS_DEMO = new URLSearchParams(location.search).has('demo');
const pulls = IS_DEMO ? DEMO_PULLS : generatePulls(COUNT);
const byId = new Map(pulls.map((pull) => [pull.id, pull]));
const byNumber = new Map(pulls.map((pull) => [pull.number, pull]));
const calls: Record<string, number> = {};

Object.assign(window, { __shimCalls: calls });

const resolvedThreads = new Set<string>();
const THREAD_BODIES = ['Can we keep the old behaviour behind a flag until the migration lands?', 'Nit: this name reads as a boolean; maybe <code>shouldAbort</code>?', 'Does this need a test for the empty-query case?'];
function threadsOf(pull: FixturePull): { id: string; isResolved: boolean; isOutdated: boolean; path: string; line: number; originalLine: number; viewerCanResolve: boolean; comments: { totalCount: number; nodes: unknown[] } }[] {
  const count = IS_DEMO ? (pull.title.startsWith('perf(search)') ? 3 : pull.number % 4 === 0 ? 1 : 0) : pull.number % 3;
  return Array.from({ length: count }, (_, index) => {
    const id = `T_${pull.number}_${index}`;
    return {
      id,
      isResolved: resolvedThreads.has(id) || (IS_DEMO && index === 2),
      isOutdated: false,
      path: IS_DEMO && pull.title.startsWith('perf(search)') ? 'src/search/semantic.ts' : `src/module-0/file-${pull.number}-0.ts`,
      line: 9 + index,
      originalLine: 9 + index,
      viewerCanResolve: true,
      comments: { totalCount: 2, nodes: [
        { id: `${id}_a`, bodyHTML: `<p>${THREAD_BODIES[index % THREAD_BODIES.length]}</p>`, createdAt: '2026-09-26T10:00:00Z', url: `https://github.com/x/pull/${pull.number}#r1`, author: { login: 'jordan-lee', avatarUrl: '', __typename: 'User' } },
        { id: `${id}_b`, bodyHTML: '<p>Good call, updating.</p>', createdAt: '2026-09-26T11:00:00Z', url: `https://github.com/x/pull/${pull.number}#r2`, author: { login: 'sam-rivera', avatarUrl: '', __typename: 'User' } },
      ] },
    };
  });
}

function mergeStateOf(pull: FixturePull): { id: string; mergeable: string; mergeStateStatus: string; reviewThreads: { nodes: { isResolved: boolean; isOutdated: boolean }[] } } {
  const conflicted = IS_DEMO ? DEMO_CONFLICTS.has(pull.id) : pull.number % 13 === 0;
  const failing = pull.commits.nodes[0]?.commit.statusCheckRollup?.state === 'FAILURE';
  const status = conflicted ? 'DIRTY' : pull.isDraft ? 'DRAFT' : failing ? 'UNSTABLE' : pull.reviewDecision === 'APPROVED' ? 'CLEAN' : 'BLOCKED';
  return { id: pull.id, mergeable: conflicted ? 'CONFLICTING' : 'MERGEABLE', mergeStateStatus: status, reviewThreads: { nodes: threadsOf(pull).map(({ isResolved, isOutdated }) => ({ isResolved, isOutdated })) } };
}

const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {
  queue: () => JSON.stringify([{ data: { search: { nodes: pulls } } }]),
  merge_states: (args) => JSON.stringify({ data: { nodes: (args.ids as string[]).map((id) => byId.get(id)).filter((pull) => pull != null).map((pull) => mergeStateOf(pull as FixturePull)) } }),
  body: (args) => { const pull = byNumber.get(args.number as number) ?? pulls[0]!; return IS_DEMO ? demoBody(pull) : generateBody(pull); },
  diff: (args) => { const pull = byNumber.get(args.number as number) ?? pulls[0]!; return (IS_DEMO ? demoDiff(pull) : null) ?? generateDiff(pull); },
  conversation: (args) => IS_DEMO ? JSON.stringify(demoConversation(byNumber.get(args.number as number) ?? pulls[0]!)) : JSON.stringify({ data: { repository: { pullRequest: { comments: { totalCount: 2, nodes: [
    { id: 'c1', bodyHTML: `<p>Long review note.</p>${'<p>Line of detail that goes on for a while to make this comment tall.</p>'.repeat(30)}`, createdAt: '2026-09-26T10:00:00Z', url: 'https://github.com/o/web/pull/1#c1', author: { login: 'reviewer', avatarUrl: '', __typename: 'User' } },
    { id: 'c3', bodyHTML: '<h3>🚀 Web Preview Deployed</h3><p><a href="https://pr-47520.preview.openrouter.ai">https://pr-47520.preview.openrouter.ai</a></p>', createdAt: '2026-09-26T11:30:00Z', url: 'https://github.com/o/web/pull/1#c3', author: { login: 'github-actions', avatarUrl: '', __typename: 'Bot' } },
    { id: 'c2', bodyHTML: '<p>Link to Devin session: <a href="https://openrouter.devinenterprise.com/sessions/38cc6d851fef40258406d2df3132a5c1">session</a></p>', createdAt: '2026-09-26T11:00:00Z', url: 'https://github.com/o/web/pull/1#c2', author: { login: 'devin-ai-integration', avatarUrl: '', __typename: 'Bot' } },
  ] }, reviews: { totalCount: 0, nodes: [] } } } } }),
  viewer: () => (IS_DEMO ? 'jordan-lee' : 'someone-else'),
  comment: (args) => `https://github.com/${String(args.repo)}/pull/${String(args.number)}#issuecomment-1`,
  threads: (args) => JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: threadsOf(byNumber.get(args.number as number) ?? pulls[0]!) } } } } }),
  set_thread_resolved: (args) => {
    if (args.resolved === true) resolvedThreads.add(String(args.threadId));
    else resolvedThreads.delete(String(args.threadId));
    return JSON.stringify({ data: {} });
  },
  reply_to_thread: () => JSON.stringify({ data: {} }),
  merge_queue: () => JSON.stringify({ data: { repository: { mergeQueue: null } } }),
  readiness_available: () => false,
  review_context: () => { throw new Error('offline harness'); },
  readiness: () => { throw new Error('offline harness'); },
  approve: () => 'ok',
  merge: async (args) => {
    await new Promise((resolve) => setTimeout(resolve, Number(new URLSearchParams(location.search).get('mergeMs') ?? 0)));
    const failing = (new URLSearchParams(location.search).get('failMerge') ?? '').split(',').filter(Boolean).map(Number);
    if (failing.includes(Number(args.number))) throw new Error('Pull request is not mergeable: required status check "ci" is failing');
    return 'ok';
  },
  open_in_browser: (args) => { (window as unknown as { __opened: string[] }).__opened = [...((window as unknown as { __opened?: string[] }).__opened ?? []), String(args.url)]; return undefined; },
};

export async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  calls[command] = (calls[command] ?? 0) + 1;
  const handler = handlers[command];
  if (handler == null) throw new Error(`harness: unhandled command ${command}`);
  if (LATENCY_MS > 0) await new Promise((resolve) => setTimeout(resolve, LATENCY_MS));
  return (await handler(args)) as T;
}

export class Resource {
  constructor(readonly rid: number) {}
  async close(): Promise<void> {}
}

export class Channel<T> {
  onmessage: (message: T) => void = () => undefined;
}
