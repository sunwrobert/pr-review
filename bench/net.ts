import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { cpus } from 'node:os';

interface BenchPr {
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
  headRefOid: string;
  baseRefName: string;
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  author: { login: string; avatarUrl: string };
  repository: { nameWithOwner: string };
  checkState: 'SUCCESS' | 'FAILURE' | 'PENDING';
  mergeQueueEntry: { position: number; state: string } | null;
  stackEntry: { position: number } | null;
  stack: { baseRefName: string; entries: { nodes: { position: number; pullRequest: { state: string } }[] } } | null;
  mergeable: 'MERGEABLE' | 'CONFLICTING';
  mergeStateStatus: string;
}

interface StageServerStats {
  requests: number;
  notModified304: number;
  bytesOut: number;
  maxInFlight: number;
  serverErrors: number;
}

interface ClientScenario {
  name: string;
  wallMs: number;
  ok: boolean;
  error: string | null;
  work: Record<string, unknown>;
}

interface NetScenarioResult {
  name: string;
  wallMs: number;
  requests: number;
  notModified304: number;
  kbOut: number;
  maxInFlight: number;
  errors: number;
}

const ROOT = join(import.meta.dir, '..');
const TAURI_DIR = join(ROOT, 'src-tauri');
const BASE_TAURI = join(import.meta.dir, '.base-tauri');
const args = new Set(process.argv.slice(2));

const RUNS = Number(process.env.BENCH_RUNS ?? 5);
/** Scales calibrated GitHub latencies (0.1 = 10x faster wall time, identical ratios; set 1.0 for real-time seconds). */
const SCALE = Number(process.env.BENCH_NET_SCALE ?? 0.1);
const WEIGHTS = { wallMs: 0.55, requests: 0.30, kbOut: 0.15 } as const;

const sleep = (ms: number): Promise<void> => (ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms)));

function makePrs(): BenchPr[] {
  const baseTime = Date.parse('2026-11-20T12:00:00Z');
  return Array.from({ length: 300 }, (_, index) => {
    const number = 1001 + index;
    const repo = index % 5 === 0 ? 'o/api' : 'o/web';
    const isStacked = index < 30;
    const stackPos = (index % 3) + 1;
    const checkState = index % 5 === 0 ? 'FAILURE' : index % 17 === 0 ? 'PENDING' : 'SUCCESS';
    const conflicted = index % 19 === 0;
    const updatedAt = new Date(baseTime - index * 600_000).toISOString();
    return {
      id: `PR_bench_${number}`,
      number,
      title: `feat(module-${index % 12}): change ${number}`,
      url: `https://github.com/${repo}/pull/${number}`,
      isDraft: index % 23 === 0,
      createdAt: new Date(baseTime - (index + 50) * 600_000).toISOString(),
      updatedAt,
      additions: 40 + (index * 17) % 900,
      deletions: 10 + (index * 13) % 400,
      changedFiles: 2 + (index % 18),
      headRefName: `feat/branch-${number}`,
      headRefOid: `${(0x10000000 + number).toString(16).padStart(40, 'a')}`,
      baseRefName: isStacked && stackPos > 1 ? `feat/branch-${number - 1}` : 'main',
      reviewDecision: index % 3 === 0 ? 'APPROVED' : index % 7 === 0 ? 'CHANGES_REQUESTED' : 'REVIEW_REQUIRED',
      author: { login: index % 2 === 0 ? 'sunwrobert' : 'teammate', avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4' },
      repository: { nameWithOwner: repo },
      checkState,
      mergeQueueEntry: index % 29 === 0 ? { position: index % 4, state: 'AWAITING_CHECKS' } : null,
      stackEntry: isStacked ? { position: stackPos } : null,
      stack: isStacked
        ? { baseRefName: 'main', entries: { nodes: [{ position: 1, pullRequest: { state: 'OPEN' } }, { position: 2, pullRequest: { state: 'OPEN' } }, { position: 3, pullRequest: { state: 'OPEN' } }] } }
        : null,
      mergeable: conflicted ? 'CONFLICTING' : 'MERGEABLE',
      mergeStateStatus: conflicted ? 'DIRTY' : checkState === 'FAILURE' ? 'UNSTABLE' : 'CLEAN',
    };
  });
}

function makeRawDiff(): string {
  return Array.from({ length: 18 }, (_, index) => {
    const file = `src/module-${index}/index.ts`;
    const body = Array.from({ length: 24 }, (_, line) => `+  const v${line} = compute(${index}, ${line});`).join('\n');
    return `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,3 +1,27 @@\n export function run() {\n${body}\n }\n`;
  }).join('');
}

const RAW_DIFF_1001 = makeRawDiff();
const HUGE_FILES = Array.from({ length: 750 }, (_, index) => {
  const padded = String(index).padStart(3, '0');
  return {
    filename: `src/file-${padded}.ts`,
    previous_filename: null,
    status: 'modified',
    patch: `@@ -1,2 +1,3 @@\n export const n = ${index};\n+export const updated = true;`,
  };
});

function startMockServer(): { url: string; stats: Map<string, StageServerStats>; reset(): void; stop(): void } {
  let prs = makePrs();
  let byId = new Map(prs.map((pr) => [pr.id, pr]));
  const stats = new Map<string, StageServerStats>();
  let stage = 'init';
  let inFlight = 0;

  const ensureStage = (name: string): StageServerStats => {
    let entry = stats.get(name);
    if (entry == null) {
      entry = { requests: 0, notModified304: 0, bytesOut: 0, maxInFlight: 0, serverErrors: 0 };
      stats.set(name, entry);
    }
    return entry;
  };

  const jsonResp = (data: unknown, headers: Record<string, string> = {}, status = 200): { text: string; response: Response } => {
    const text = JSON.stringify(data);
    return { text, response: new Response(text, { status, headers: { 'Content-Type': 'application/json', ...headers } }) };
  };

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith('/__bench/')) {
        if (url.pathname === '/__bench/mutate-warm') {
          // Bump updatedAt on 5% (15 PRs) to model a realistic incremental refresh.
          prs = prs.map((pr, index) => (index < 15 ? { ...pr, updatedAt: '2026-11-20T12:30:00Z' } : pr));
          byId = new Map(prs.map((pr) => [pr.id, pr]));
          return new Response('ok');
        }
        if (url.pathname.startsWith('/__bench/stage/')) {
          stage = url.pathname.slice('/__bench/stage/'.length);
          ensureStage(stage);
          return new Response('ok');
        }
        return new Response('not found', { status: 404 });
      }

      const currentStage = ensureStage(stage);
      currentStage.requests += 1;
      inFlight += 1;
      if (inFlight > currentStage.maxInFlight) currentStage.maxInFlight = inFlight;

      try {
        // 1. GraphQL
        if (url.pathname === '/graphql' && request.method === 'POST') {
          const payload = (await request.json()) as { query?: string; variables?: Record<string, unknown> };
          const query = payload.query ?? '';
          const vars = payload.variables ?? {};

          // 1a. Search query
          if (query.includes('search(')) {
            const q = String(vars.q ?? '');
            const list = q.includes('review-requested:@me') ? prs.slice(0, 20) : q.includes('author:@me') ? prs.slice(0, 150) : prs;
            const ordered = q.includes('sort:updated-asc') ? [...list].reverse() : list;
            const offset = vars.cursor == null ? 0 : Number(vars.cursor);
            const slice = ordered.slice(offset, offset + 100);
            const nextOffset = offset + slice.length;
            const hasNextPage = nextOffset < ordered.length;
            await sleep(Math.round(SCALE * Math.max(300, 12 * slice.length)));
            const nodes = slice.map((pr) => ({
              id: pr.id,
              number: pr.number,
              title: pr.title,
              url: pr.url,
              isDraft: pr.isDraft,
              createdAt: pr.createdAt,
              updatedAt: pr.updatedAt,
              headRefName: pr.headRefName,
              headRefOid: pr.headRefOid,
              baseRefName: pr.baseRefName,
              author: pr.author,
              repository: pr.repository,
            }));
            const { text, response } = jsonResp({
              data: { search: { issueCount: ordered.length, pageInfo: { hasNextPage, endCursor: hasNextPage ? String(nextOffset) : null }, nodes } },
            });
            currentStage.bytesOut += text.length;
            return response;
          }

          // 1b. Batch nodes(ids:)
          if (query.includes('nodes(ids:')) {
            const ids = (vars.ids as string[] | undefined) ?? [];
            const matched = ids.map((id) => byId.get(id)).filter((pr): pr is BenchPr => pr != null);

            if (query.includes('mergeable')) {
              // merge_states / merge_status_poll
              await sleep(Math.round(SCALE * 90 * Math.max(1, ids.length)));
              const nodes = matched.map((pr) => ({
                id: pr.id,
                mergeable: pr.mergeable,
                mergeStateStatus: pr.mergeStateStatus,
                reviewThreads: { nodes: [{ isResolved: false }, { isResolved: true }] },
              }));
              const { text, response } = jsonResp({ data: { nodes } });
              currentStage.bytesOut += text.length;
              return response;
            }

            if (query.includes('contexts(')) {
              // failing_checks
              await sleep(Math.round(SCALE * 60 * Math.max(1, ids.length)));
              const nodes = matched.map((pr) => ({
                id: pr.id,
                commits: {
                  nodes: [{
                    commit: {
                      statusCheckRollup: {
                        contexts: {
                          pageInfo: { hasNextPage: false, endCursor: null },
                          nodes: pr.checkState === 'FAILURE'
                            ? [
                                { __typename: 'CheckRun', name: 'unit', status: 'COMPLETED', conclusion: 'FAILURE', completedAt: '2026-11-20T12:00:00Z', isRequired: true },
                                { __typename: 'CheckRun', name: 'visual', status: 'COMPLETED', conclusion: 'FAILURE', completedAt: '2026-11-20T12:00:00Z', isRequired: false },
                              ]
                            : [{ __typename: 'CheckRun', name: 'unit', status: 'IN_PROGRESS', conclusion: null, startedAt: '2026-11-20T12:00:00Z', isRequired: true }],
                        },
                      },
                    },
                  }],
                },
              }));
              const { text, response } = jsonResp({ data: { nodes } });
              currentStage.bytesOut += text.length;
              return response;
            }

            if (query.includes('additions')) {
              // Full QUEUE_DETAIL_FIELDS
              await sleep(Math.round(SCALE * 125 * Math.max(1, ids.length)));
              const nodes = matched.map((pr) => ({
                id: pr.id,
                additions: pr.additions,
                deletions: pr.deletions,
                changedFiles: pr.changedFiles,
                reviewDecision: pr.reviewDecision,
                mergeQueueEntry: pr.mergeQueueEntry,
                commits: { nodes: [{ commit: { statusCheckRollup: { state: pr.checkState } } }] },
                stackEntry: pr.stackEntry,
                stack: pr.stack,
              }));
              const { text, response } = jsonResp({ data: { nodes } });
              currentStage.bytesOut += text.length;
              return response;
            }

            // Live-only QUEUE_LIVE_FIELDS (mergeQueueEntry + statusCheckRollup.state)
            await sleep(Math.round(SCALE * 18 * Math.max(1, ids.length)));
            const nodes = matched.map((pr) => ({
              id: pr.id,
              mergeQueueEntry: pr.mergeQueueEntry,
              commits: { nodes: [{ commit: { statusCheckRollup: { state: pr.checkState } } }] },
            }));
            const { text, response } = jsonResp({ data: { nodes } });
            currentStage.bytesOut += text.length;
            return response;
          }

          // 1c. pullRequest(number:) — pull_details / body / conversation / threads
          if (query.includes('pullRequest(number:')) {
            const isCombined = query.includes('bodyHTML') && query.includes('comments(') && query.includes('reviewThreads(');
            await sleep(Math.round(SCALE * (isCombined ? 600 : 500)));
            const { text, response } = jsonResp({
              data: {
                repository: {
                  pullRequest: {
                    bodyHTML: '<p>PR description with details and testing notes.</p>',
                    comments: {
                      totalCount: 2,
                      nodes: [
                        { id: 'c1', bodyHTML: '<p>LGTM</p>', createdAt: '2026-11-20T10:00:00Z', url: 'https://github.com/o/web/pull/1001#c1', author: { login: 'reviewer', avatarUrl: '', __typename: 'User' } },
                        { id: 'c2', bodyHTML: '<p>Devin session ready</p>', createdAt: '2026-11-20T10:05:00Z', url: 'https://github.com/o/web/pull/1001#c2', author: { login: 'devin-ai-integration[bot]', avatarUrl: '', __typename: 'Bot' } },
                      ],
                    },
                    reviews: { totalCount: 1, nodes: [{ id: 'r1', state: 'APPROVED', bodyHTML: '', submittedAt: '2026-11-20T11:00:00Z', url: 'https://github.com/o/web/pull/1001#r1', author: { login: 'reviewer', avatarUrl: '', __typename: 'User' }, comments: { totalCount: 0 } }] },
                    reviewThreads: {
                      nodes: [
                        {
                          id: 't1',
                          isResolved: false,
                          isOutdated: false,
                          path: 'src/module-0/index.ts',
                          line: 12,
                          originalLine: 12,
                          viewerCanResolve: true,
                          comments: { totalCount: 1, nodes: [{ id: 'tc1', bodyHTML: '<p>Consider renaming</p>', createdAt: '2026-11-20T10:10:00Z', url: 'https://github.com/o/web/pull/1001#tc1', author: { login: 'reviewer', avatarUrl: '', __typename: 'User' } }] },
                        },
                      ],
                    },
                  },
                },
              },
            });
            currentStage.bytesOut += text.length;
            return response;
          }
        }

        // 2. Branch rulesets (used by failing_checks)
        if (url.pathname.includes('/rules/branches/')) {
          const etag = '"rules-v1"';
          if (request.headers.get('if-none-match') === etag) {
            await sleep(Math.round(SCALE * 100));
            currentStage.notModified304 += 1;
            return new Response(null, { status: 304, headers: { ETag: etag } });
          }
          await sleep(Math.round(SCALE * 200));
          const { text, response } = jsonResp([{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'unit' }, { context: 'typecheck' }] } }], { ETag: etag });
          currentStage.bytesOut += text.length;
          return response;
        }

        // 3. Raw diff
        if (/^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/.test(url.pathname) && request.headers.get('accept')?.includes('diff')) {
          const number = Number(url.pathname.split('/').at(-1));
          if (number === 9999) {
            await sleep(Math.round(SCALE * 200));
            const { text, response } = jsonResp({ message: 'Sorry, the diff exceeded the maximum number of files.', errors: [{ code: 'too_large' }] }, {}, 406);
            currentStage.bytesOut += text.length;
            return response;
          }
          const etag = `"diff-${number}-v1"`;
          if (request.headers.get('if-none-match') === etag) {
            await sleep(Math.round(SCALE * 120));
            currentStage.notModified304 += 1;
            return new Response(null, { status: 304, headers: { ETag: etag } });
          }
          await sleep(Math.round(SCALE * 500));
          currentStage.bytesOut += RAW_DIFF_1001.length;
          return new Response(RAW_DIFF_1001, { status: 200, headers: { 'Content-Type': 'text/plain', ETag: etag } });
        }

        // 4. Paginated /files fallback for huge PR 9999
        if (url.pathname === '/repos/o/web/pulls/9999/files') {
          const page = Math.max(1, Number(url.searchParams.get('page') ?? 1));
          const perPage = Math.max(1, Number(url.searchParams.get('per_page') ?? 100));
          const slice = HUGE_FILES.slice((page - 1) * perPage, page * perPage);
          const lastPage = Math.ceil(HUGE_FILES.length / perPage);
          const headers: Record<string, string> = {};
          if (page === 1 && lastPage > 1) {
            headers.Link = `<http://127.0.0.1:${server.port}${url.pathname}?per_page=${perPage}&page=2>; rel="next", <http://127.0.0.1:${server.port}${url.pathname}?per_page=${perPage}&page=${lastPage}>; rel="last"`;
          }
          await sleep(Math.round(SCALE * 400));
          const { text, response } = jsonResp(slice, headers);
          currentStage.bytesOut += text.length;
          return response;
        }

        currentStage.serverErrors += 1;
        return new Response(`Unhandled mock route: ${request.method} ${url.pathname}`, { status: 404 });
      } finally {
        inFlight -= 1;
      }
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    stats,
    reset() {
      prs = makePrs();
      byId = new Map(prs.map((pr) => [pr.id, pr]));
      stats.clear();
      stage = 'init';
    },
    stop: () => server.stop(true),
  };
}

async function buildBinary(dir: string): Promise<string> {
  const proc = Bun.spawn(['cargo', 'build', '--release', '--bin', 'net_bench'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
  const exit = await proc.exited;
  if (exit !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`cargo build failed in ${dir}:\n${stderr.slice(-1500)}`);
  }
  return join(dir, 'target/release/net_bench');
}

async function buildRefBinary(ref: string): Promise<string> {
  const hasBin = (await Bun.$`git cat-file -e ${ref}:src-tauri/src/bin/net_bench.rs`.quiet().nothrow()).exitCode === 0;
  if (!hasBin) {
    throw new Error(`${ref} does not contain src-tauri/src/bin/net_bench.rs yet — commit the harness first, or run with --self-test`);
  }
  // Keep target/ across runs so baseline rebuilds only recompile pr-review (~3s).
  await Bun.$`mkdir -p ${BASE_TAURI}`.quiet();
  await Bun.$`rm -rf ${join(BASE_TAURI, 'src')} ${join(BASE_TAURI, 'Cargo.toml')} ${join(BASE_TAURI, 'Cargo.lock')} ${join(BASE_TAURI, 'build.rs')} ${join(BASE_TAURI, 'tauri.conf.json')} ${join(BASE_TAURI, 'capabilities')} ${join(BASE_TAURI, 'icons')}`.quiet();
  await Bun.$`git archive ${ref} src-tauri | tar -x --strip-components=1 -C ${BASE_TAURI}`.quiet();
  return buildBinary(BASE_TAURI);
}

async function runBinaryOnce(binary: string, mock: ReturnType<typeof startMockServer>, failures: string[]): Promise<NetScenarioResult[]> {
  mock.reset();
  const proc = Bun.spawn([binary], {
    env: { ...process.env, PR_REVIEW_GITHUB_API: mock.url, PR_REVIEW_GITHUB_TOKEN: 'bench-token' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (exit !== 0) {
    failures.push(`net_bench exited ${exit}: ${stderr.trim().slice(0, 200)}`);
    throw new Error(`net_bench failed (${exit}): ${stderr}`);
  }
  const clientReports = JSON.parse(stdout) as ClientScenario[];
  return clientReports.map((report) => {
    const srv = mock.stats.get(report.name) ?? { requests: 0, notModified304: 0, bytesOut: 0, maxInFlight: 0, serverErrors: 0 };
    if (!report.ok) failures.push(`${report.name}: ${report.error ?? 'failed'}`);
    if (srv.serverErrors > 0) failures.push(`${report.name}: ${srv.serverErrors} mock server error(s)`);
    if (srv.requests === 0) failures.push(`${report.name}: 0 requests reached server (did work happen?)`);
    return {
      name: report.name,
      wallMs: report.wallMs,
      requests: srv.requests,
      notModified304: srv.notModified304,
      kbOut: srv.bytesOut / 1024,
      maxInFlight: srv.maxInFlight,
      errors: (report.ok ? 0 : 1) + srv.serverErrors,
    };
  });
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function combine(runs: NetScenarioResult[][]): NetScenarioResult[] {
  return runs[0]!.map((first, index) => {
    const pick = (key: keyof Omit<NetScenarioResult, 'name'>): number => median(runs.map((run) => run[index]![key]));
    return {
      name: first.name,
      wallMs: pick('wallMs'),
      requests: pick('requests'),
      notModified304: pick('notModified304'),
      kbOut: pick('kbOut'),
      maxInFlight: pick('maxInFlight'),
      errors: runs.reduce((sum, run) => sum + run[index]!.errors, 0),
    };
  });
}

function score(candidate: NetScenarioResult[], baseline: NetScenarioResult[]): number {
  const ratios = candidate.flatMap((scenario) => {
    const base = baseline.find((item) => item.name === scenario.name);
    if (base == null) return [];
    return (Object.keys(WEIGHTS) as (keyof typeof WEIGHTS)[]).map((key) => WEIGHTS[key] * Math.log((base[key] + 1) / (scenario[key] + 1)));
  });
  const total = ratios.reduce((sum, value) => sum + value, 0) / Math.max(1, candidate.length);
  return Number(Math.exp(total).toFixed(4));
}

function printTable(rows: NetScenarioResult[]): void {
  console.table(
    rows.map((row) => ({
      name: row.name,
      wallMs: Math.round(row.wallMs),
      requests: row.requests,
      '304s': row.notModified304,
      kbOut: Number(row.kbOut.toFixed(1)),
      maxInFlight: row.maxInFlight,
      errors: row.errors,
    })),
  );
}

async function main(): Promise<void> {
  const ref = process.argv.find((arg, index) => process.argv[index - 1] === '--against') ?? 'HEAD';
  const isSelfTest = args.has('--self-test');
  const uptime = (await Bun.$`uptime`.quiet().text()).trim();
  console.log(`host: ${cpus().length} cores · ${uptime}`);

  const candidateBin = args.has('--no-build') && existsSync(join(TAURI_DIR, 'target/release/net_bench')) ? join(TAURI_DIR, 'target/release/net_bench') : await buildBinary(TAURI_DIR);
  const baseBin = isSelfTest ? candidateBin : await buildRefBinary(ref);
  const commit = (await Bun.$`git rev-parse --short ${ref}`.quiet().text()).trim();

  const mock = startMockServer();
  const failures: string[] = [];
  try {
    const baseRuns: NetScenarioResult[][] = [];
    const candidateRuns: NetScenarioResult[][] = [];
    for (let run = 0; run < RUNS; run += 1) {
      const started = Date.now();
      baseRuns.push(await runBinaryOnce(baseBin, mock, failures));
      candidateRuns.push(await runBinaryOnce(candidateBin, mock, failures));
      console.error(`run ${run + 1}/${RUNS} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    }
    const base = combine(baseRuns);
    const candidate = combine(candidateRuns);
    console.log(`\n${isSelfTest ? 'self-test A (same release binary)' : `baseline (${commit}, --release)`} · ${RUNS} runs × scale=${SCALE}x:`);
    printTable(base);
    console.log(`${isSelfTest ? 'self-test B (same release binary)' : 'working tree (--release)'}:`);
    printTable(candidate);
    if (args.has('--spread')) {
      console.log('SPREAD (wallMs min..max across runs):');
      for (let i = 0; i < candidate.length; i += 1) {
        const range = (runs: NetScenarioResult[][]): string => {
          const vals = runs.map((r) => Math.round(r[i]!.wallMs));
          return `${Math.min(...vals)}..${Math.max(...vals)}ms`;
        };
        console.log(`  ${candidate[i]!.name.padEnd(18)} base=${range(baseRuns).padEnd(14)} cand=${range(candidateRuns)}`);
      }
    }
    const uniqueFailures = [...new Set(failures)];
    if (uniqueFailures.length > 0) {
      console.log('WORK CHECKS FAILED:');
      uniqueFailures.forEach((f) => console.log(`  - ${f}`));
      console.log('SCORE 0');
      process.exitCode = 1;
      return;
    }
    console.log(`SCORE ${score(candidate, base)}`);
  } finally {
    mock.stop();
  }
}

await main();
