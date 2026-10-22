import { DEMO_CONFLICTS, DEMO_PULLS, demoBody, demoConversation, demoDiff } from '../demo';
import { generateBody, generateDiff, generatePulls, type FixturePull } from '../fixtures';

const COUNT = Number(new URLSearchParams(location.search).get('pulls') ?? 120);
const LATENCY_MS = Number(new URLSearchParams(location.search).get('latency') ?? 0);
const IS_DEMO = new URLSearchParams(location.search).has('demo');
/** `?mixedFiles` appends a test, a doc and a lockfile to every diff so grouped review and Hide tests have something to split. */
const MIXED_FILES = new URLSearchParams(location.search).has('mixedFiles');

function mixedFiles(number: number): string {
  const file = (path: string, lines: string[]): string => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,${lines.length + 1} @@\n ${number}\n${lines.map((line) => `+${line}`).join('\n')}\n`;
  return [file(`src/feature-${number}.test.ts`, ["test('works', () => {", '  expect(1).toBe(1);', '});']), file('README.md', ['## Usage', 'Run it.']), file('bun.lock', ['"x": 1'])].join('');
}
const WITH_IMAGES = new URLSearchParams(location.search).has('images');
const IMAGE_HTML = (seed: number): string => `<p><img src="https://camo.githubusercontent.com/test-${seed}" alt="shot ${seed}" width="600" height="300" /></p>`;
const pulls = (IS_DEMO ? DEMO_PULLS : generatePulls(COUNT)).map((pull) => (WITH_IMAGES ? { ...pull, author: { ...pull.author, avatarUrl: `https://avatars.githubusercontent.com/u/${pull.number % 7}?v=4` } } : pull));
const outside: (typeof pulls)[number][] = [];
/** `?stacks` chains a few same-repo pulls (spread out in the list) into a 3-PR and a 2-PR stack. */
if (new URLSearchParams(location.search).has('stacks')) {
  const repo = pulls[0]!.repository.nameWithOwner;
  const same = pulls.filter((pull) => pull.repository.nameWithOwner === repo);
  const chain = (members: (typeof pulls)[number][]): void => members.forEach((pull, index) => index > 0 && (pull.baseRefName = members[index - 1]!.headRefName));
  chain([same[6], same[1], same[3]].filter((pull) => pull != null));
  chain([same[2], same[8]].filter((pull) => pull != null));
  const top = same[3];
  if (top != null) outside.push({ ...top, id: 'DEMO_OUTSIDE', number: 9001, title: 'feat(stack): top PR that is not in this view', headRefName: 'stack-outside', baseRefName: top.headRefName });
}
const byId = new Map(pulls.map((pull) => [pull.id, pull]));
const byNumber = new Map(pulls.map((pull) => [pull.number, pull]));
const calls: Record<string, number> = {};
const AI_GROUPING_MS = new URLSearchParams(location.search).has('aiGroupingMs') ? Number(new URLSearchParams(location.search).get('aiGroupingMs')) : null;

Object.assign(window, { __shimCalls: calls });

const resolvedThreads = new Set<string>();
const CONFLICT_ON_MERGE = (new URLSearchParams(location.search).get('conflictOnMerge') ?? '').split(',').filter(Boolean).map(Number);
const lateConflicts = new Set<number>();
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

function mergeStateOf(pull: FixturePull): Record<string, unknown> {
  const conflicted = lateConflicts.has(pull.number) || (IS_DEMO ? DEMO_CONFLICTS.has(pull.id) : pull.number % 13 === 0);
  const failing = pull.commits.nodes[0]?.commit.statusCheckRollup?.state === 'FAILURE';
  const status = conflicted ? 'DIRTY' : pull.isDraft ? 'DRAFT' : failing ? 'UNSTABLE' : pull.reviewDecision === 'APPROVED' ? 'CLEAN' : 'BLOCKED';
  const rollup = pull.commits.nodes[0]?.commit.statusCheckRollup?.state;
  const checks = rollup === 'FAILURE' ? [{ __typename: 'CheckRun', name: 'unit', conclusion: 'FAILURE', isRequired: pull.number % 2 === 0 }, { __typename: 'CheckRun', name: 'preview-deploy', conclusion: 'CANCELLED', isRequired: false }] : [{ __typename: 'CheckRun', name: 'unit', conclusion: rollup === 'PENDING' ? null : 'SUCCESS', isRequired: true }];
  return { id: pull.id, mergeable: conflicted ? 'CONFLICTING' : 'MERGEABLE', mergeStateStatus: status, commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: checks } } } }] }, reviewThreads: { nodes: threadsOf(pull).map(({ isResolved, isOutdated }) => ({ isResolved, isOutdated })) } };
}

const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {
  queue: () => JSON.stringify([{ data: { search: { nodes: pulls } } }]),
  merge_states: (args) => JSON.stringify({ data: Object.fromEntries((args.ids as string[]).map((id, index) => [`p${index}`, byId.has(id) ? mergeStateOf(byId.get(id) as FixturePull) : null])) }),
  body: (args) => { const pull = byNumber.get(args.number as number) ?? pulls[0]!; const html = IS_DEMO ? demoBody(pull) : generateBody(pull); return WITH_IMAGES ? `${IMAGE_HTML(pull.number)}${html}${IMAGE_HTML(pull.number + 1)}` : html; },
  diff: (args) => { const pull = byNumber.get(args.number as number) ?? pulls[0]!; const base = (IS_DEMO ? demoDiff(pull) : null) ?? generateDiff(pull); return MIXED_FILES ? `${base}${mixedFiles(pull.number)}` : base; },
  conversation: (args) => IS_DEMO ? JSON.stringify(demoConversation(byNumber.get(args.number as number) ?? pulls[0]!)) : JSON.stringify({ data: { repository: { pullRequest: { comments: { totalCount: 2, nodes: [
    { id: 'c1', bodyHTML: `<p>Long review note.</p>${'<p>Line of detail that goes on for a while to make this comment tall.</p>'.repeat(30)}`, createdAt: '2026-09-26T10:00:00Z', url: 'https://github.com/o/web/pull/1#c1', author: { login: 'reviewer', avatarUrl: '', __typename: 'User' } },
    { id: 'c3', bodyHTML: '<h3>🚀 Web Preview Deployed</h3><p><a href="https://pr-47520.preview.openrouter.ai">https://pr-47520.preview.openrouter.ai</a></p>', createdAt: '2026-09-26T11:30:00Z', url: 'https://github.com/o/web/pull/1#c3', author: { login: 'github-actions', avatarUrl: '', __typename: 'Bot' } },
    { id: 'c2', bodyHTML: '<p>Link to Devin session: <a href="https://openrouter.devinenterprise.com/sessions/38cc6d851fef40258406d2df3132a5c1">session</a></p>', createdAt: '2026-09-26T11:00:00Z', url: 'https://github.com/o/web/pull/1#c2', author: { login: 'devin-ai-integration', avatarUrl: '', __typename: 'Bot' } },
  ] }, reviews: { totalCount: 0, nodes: [] } } } } }),
  message_devin: async (args) => { await new Promise((resolve) => setTimeout(resolve, 300)); ((globalThis as unknown as { devinSends?: unknown[] }).devinSends ??= []).push({ sessionId: args.sessionId, message: args.message }); return 'delivered'; },
  viewer: () => (IS_DEMO ? 'jordan-lee' : 'someone-else'),
  comment: (args) => `https://github.com/${String(args.repo)}/pull/${String(args.number)}#issuecomment-1`,
  threads: (args) => JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: threadsOf(byNumber.get(args.number as number) ?? pulls[0]!) } } } } }),
  set_thread_resolved: (args) => {
    if (args.resolved === true) resolvedThreads.add(String(args.threadId));
    else resolvedThreads.delete(String(args.threadId));
    return JSON.stringify({ data: {} });
  },
  reply_to_thread: () => JSON.stringify({ data: {} }),
  pull: (args) => { const pull = [...pulls, ...outside].find((candidate) => candidate.number === args.number); return JSON.stringify({ data: { repository: { pullRequest: pull == null ? null : { ...pull, state: 'OPEN' } } } }); },
  stack_neighbors: (args) => { const all = [...pulls, ...outside].filter((pull) => pull.repository.nameWithOwner === args.repo); return JSON.stringify({ data: { repository: { above: { nodes: all.filter((pull) => pull.baseRefName === args.head) }, below: { nodes: all.filter((pull) => pull.headRefName === args.base) } } } }); },
  /** `?queue` gives every branch a merge queue. */
  merge_queue: () => JSON.stringify({ data: { repository: { mergeQueue: new URLSearchParams(location.search).has('queue') ? { url: '' } : null } } }),
  readiness_available: () => AI_GROUPING_MS != null,
  /** `?aiGroupingMs=N` turns the AI paths on and answers grouping after N ms with one group per top-level folder. */
  group_files: async (args) => {
    await new Promise((resolve) => setTimeout(resolve, AI_GROUPING_MS ?? 0));
    const request = JSON.parse(String(args.request)) as { messages: { content: string }[] };
    const manifest = /---MANIFEST---[^\n]*\n([\s\S]*?)(?:\n\n---|$)/.exec(request.messages[1]?.content ?? '')?.[1] ?? '';
    const paths = manifest.split('\n').map((line) => line.split('  ')[0] ?? '').filter(Boolean);
    const byFolder = new Map<string, string[]>();
    paths.forEach((path) => byFolder.set(path.includes('/') ? path.split('/')[0]! : 'root', [...(byFolder.get(path.includes('/') ? path.split('/')[0]! : 'root') ?? []), path]));
    const groups = [...byFolder].map(([folder, filePaths]) => ({ key: folder, label: `AI ${folder}`, summary: `Changes under ${folder}.`, category: 'core', critical: false, filePaths }));
    return JSON.stringify({ choices: [{ message: { content: JSON.stringify({ overallSummary: 'Fake AI summary.', groups }) } }] });
  },
  review_context: () => { throw new Error('offline harness'); },
  readiness: () => { throw new Error('offline harness'); },
  approve: () => 'ok',
  close: (args) => {
    const failing = (new URLSearchParams(location.search).get('failClose') ?? '').split(',').filter(Boolean).map(Number);
    if (failing.includes(Number(args.number))) throw new Error('GraphQL: Resource not accessible by integration (closePullRequest)');
    return '';
  },
  merge: async (args) => {
    await new Promise((resolve) => setTimeout(resolve, Number(new URLSearchParams(location.search).get('mergeMs') ?? 0)));
    const failing = (new URLSearchParams(location.search).get('failMerge') ?? '').split(',').filter(Boolean).map(Number);
    if (failing.includes(Number(args.number))) throw new Error('Pull request is not mergeable: required status check "ci" is failing');
    if (CONFLICT_ON_MERGE.includes(Number(args.number))) {
      lateConflicts.add(Number(args.number));
      throw new Error('GraphQL: Pull Request is not mergeable (mergePullRequest)');
    }
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
