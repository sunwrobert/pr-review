// Cross-app benchmark: the Rust/Tauri app's real frontend (vite build against a
// copy of bench/shim with the PR #40010 huge-diff override) vs the Exact app's
// static web build (exact/target/web-dist). Same machine, same headless
// Chromium, same fixtures, same measurement machinery as bench/run.ts:
// CDP Performance.getMetrics, 4x CPU throttle, double-rAF key latencies,
// interleaved runs, medians, work checks. Method details live in BENCH.md.
//
// Run from the repo root:  bun exact/bench/crossbench.ts
// Knobs: BENCH_RUNS (5), BENCH_CPU (4), BENCH_PULLS (400), BENCH_CHROME.
import { chromium, type CDPSession, type Page, type Browser } from 'playwright-core';
import { join } from 'node:path';
import { cpus } from 'node:os';

interface Metrics { layouts: number; styleRecalcs: number; scriptMs: number; layoutMs: number; taskMs: number; heapMb: number; nodes: number; }
interface ScenarioResult { name: string; wallMs: number; p95KeyMs: number; longTasks: number; layouts: number; styleRecalcs: number; scriptMs: number; taskMs: number; heapMb: number; nodes: number; domListRows: number; }
interface ColdStart { gotoMs: number; firstRowsMs: number; heapMb: number; scriptMs: number; taskMs: number; }
interface AppReport { app: string; cold: ColdStart; scenarios: ScenarioResult[]; failures: string[]; stalls: number; }

const RUNS = Number(process.env.BENCH_RUNS ?? 5);
const CPU_THROTTLE = Number(process.env.BENCH_CPU ?? 4);
const PULLS = Number(process.env.BENCH_PULLS ?? 400);
const FRAME_TIMEOUT_MS = 5_000;
const VIEWPORT = { width: 1480, height: 940 };
const ORDINARY_INDEX = 5; // PR #40005
const HUGE_NUMBER = 40010; // PR #40010, the huge diff

const repoRoot = join(import.meta.dir, '..', '..');

function serve(dist: string): { url: string; stop(): void } {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      const file = Bun.file(join(dist, path === '/' ? 'index.html' : path));
      return file.exists().then((isFound) => (isFound ? new Response(file) : new Response(null, { status: 404 })));
    },
  });
  return { url: `http://localhost:${server.port}`, stop: () => server.stop(true) };
}

async function metrics(cdp: CDPSession): Promise<Metrics> {
  const { metrics: list } = (await cdp.send('Performance.getMetrics')) as { metrics: { name: string; value: number }[] };
  const value = (name: string): number => list.find((metric) => metric.name === name)?.value ?? 0;
  return { layouts: value('LayoutCount'), styleRecalcs: value('RecalcStyleCount'), scriptMs: value('ScriptDuration') * 1_000, layoutMs: value('LayoutDuration') * 1_000, taskMs: value('TaskDuration') * 1_000, heapMb: value('JSHeapUsedSize') / 1_048_576, nodes: value('Nodes') };
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0)))));
}

let frameStalls = 0;
async function keyLatencies(page: Page, keys: string[]): Promise<number[]> {
  const latencies: number[] = [];
  for (const key of keys) {
    const started = await page.evaluate(() => performance.now());
    await page.keyboard.press(key);
    const painted = await page.evaluate((limit) => new Promise<number>((resolve) => {
      const fallback = setTimeout(() => resolve(-1), limit);
      requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(fallback); resolve(performance.now()); }));
    }), FRAME_TIMEOUT_MS);
    if (painted < 0) { frameStalls += 1; continue; }
    latencies.push(painted - started);
  }
  return latencies;
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

// Per-app DOM knowledge. Same logical operations, each app's real UI.
interface Adapter {
  name: string;
  dist: string;
  urlQuery: string;
  initScript?: () => void;
  rowsVisible: string; // waitForFunction body: queue rows exist
  selectedRow: string; // js: id/number of the selected row or null
  clickRow: (page: Page, index: number) => Promise<void>; // click the i-th queue row
  clickHugeRow: (page: Page) => Promise<void>;
  detailReady: string; // waitForFunction body: diff content for the open PR rendered
  goHome?: (page: Page) => Promise<void>;
  diffScroller: string; // js: the scrollable diff element; null-ish if none
  diffScrollTop: string; // js: scrollTop of the diff scroller
  listRowCount: string; // js: number of queue rows in the DOM
  diffRowCount: string; // js: number of diff rows in the DOM
  hugeStatCheck: string; // js: true when the huge diff's stats/content are honestly shown
  clearFilter: (page: Page) => Promise<void>;
}

const rust: Adapter = {
  name: 'rust',
  dist: join(import.meta.dir, 'dist-rust'),
  urlQuery: `?pulls=${PULLS}`,
  initScript: () => {
    localStorage.setItem('smartFilter', 'all');
    localStorage.setItem('themeId', 'dark');
  },
  rowsVisible: `document.querySelectorAll('#pr-list li[data-id]').length > 0`,
  selectedRow: `document.querySelector('#pr-list li.selected')?.getAttribute('data-id') ?? null`,
  clickRow: async (page, index) => {
    const id = await page.evaluate((i) => [...document.querySelectorAll<HTMLElement>('#pr-list li[data-id]')][i]?.dataset.id ?? null, index);
    if (id == null) throw new Error('no row');
    await page.locator(`#pr-list li[data-id="${id}"] .t`).click();
  },
  clickHugeRow: async (page) => {
    // Same generator as the Exact app: index 10 is PR #40010 in every queue.
    const id = await page.evaluate((i) => [...document.querySelectorAll<HTMLElement>('#pr-list li[data-id]')][i]?.dataset.id ?? null, HUGE_NUMBER - 40_000);
    if (id == null) throw new Error('huge row not rendered');
    await page.locator(`#pr-list li[data-id="${id}"] .t`).click();
  },
  detailReady: `(document.querySelector('#diff-root')?.textContent?.length ?? 0) > 0`,
  diffScroller: `document.getElementById('diff-root')`,
  diffScrollTop: `document.getElementById('diff-root')?.scrollTop ?? 0`,
  listRowCount: `document.querySelectorAll('#pr-list li[data-id]').length`,
  diffRowCount: `document.querySelectorAll('#diff-root *').length`,
  hugeStatCheck: `(document.querySelector('#diff-root')?.textContent?.length ?? 0) > 0`,
  clearFilter: async (page) => {
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      const input = document.getElementById('filter') as HTMLInputElement;
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.blur();
    });
  },
};

const exact: Adapter = {
  name: 'exact',
  dist: join(import.meta.dir, '..', 'target', 'web-dist'),
  urlQuery: '',
  rowsVisible: `document.querySelectorAll('[data-testid^="row-"]').length > 0`,
  selectedRow: `document.querySelector('[data-testid^="row-"][aria-selected="true"]')?.getAttribute('data-testid') ?? null`,
  clickRow: async (page, index) => {
    const number = 40_000 + index;
    await page.locator(`[data-testid="row-${number}"]`).click();
  },
  clickHugeRow: async (page) => {
    await page.locator(`[data-testid="row-${HUGE_NUMBER}"]`).click();
  },
  detailReady: `document.querySelectorAll('[data-testid^="diffrow-"]').length > 0`,
  goHome: async (page) => {
    await page.locator('[data-testid="detail-back"]').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid^="row-"]').length > 0, undefined, { timeout: 10_000 });
  },
  diffScroller: `document.querySelector('[data-testid="diff"]')`,
  diffScrollTop: `document.querySelector('[data-testid="diff"]')?.scrollTop ?? 0`,
  listRowCount: `document.querySelectorAll('[data-testid^="row-"]').length`,
  diffRowCount: `document.querySelectorAll('[data-testid^="diffrow-"]').length`,
  hugeStatCheck: `document.querySelector('[data-testid="diff-stat-files"]')?.textContent?.trim() === '149 files'`,
  clearFilter: async (page) => {
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      const input = document.querySelector('[data-testid="filter"]') as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.blur();
    });
  },
};

type Scenario = { name: string; run(page: Page, a: Adapter): Promise<number[]>; verify(page: Page, a: Adapter): Promise<string | null> };
let lastSelected: string | null = null;

const SCENARIOS: Scenario[] = [
  {
    name: 'navigate-list',
    run: async (page, a) => {
      lastSelected = await page.evaluate(a.selectedRow) as string | null;
      return keyLatencies(page, Array.from({ length: 60 }, () => 'j'));
    },
    verify: async (page, a) => ((await page.evaluate(a.selectedRow)) === lastSelected ? 'j did not move the selection' : null),
  },
  {
    name: 'type-filter',
    run: async (page, a) => {
      await page.keyboard.press('/');
      const latencies = await keyLatencies(page, [...'refactor']);
      const value = await page.evaluate((name) => {
        const input = (name === 'rust' ? document.getElementById('filter') : document.querySelector('[data-testid="filter"]')) as HTMLInputElement;
        return input.value;
      }, a.name);
      Object.assign(globalThis, { __filterValue: value });
      await a.clearFilter(page);
      return latencies;
    },
    verify: async () => ((globalThis as unknown as { __filterValue?: string }).__filterValue === 'refactor' ? null : 'filter input did not hold "refactor"'),
  },
  {
    name: 'open-pr',
    run: async (page, a) => {
      if (a.name === 'exact') {
        // The exact list is virtualized: after 60x j the first rows are
        // unrendered. gg returns the selection (and scroll window) to the top.
        await page.keyboard.press('g');
        await page.keyboard.press('g');
        await settle(page);
      }
      const started = await page.evaluate(() => performance.now());
      await a.clickRow(page, ORDINARY_INDEX);
      await page.waitForFunction(a.detailReady, undefined, { timeout: 15_000 });
      const painted = await page.evaluate(() => performance.now());
      return [painted - started];
    },
    verify: async (page, a) => ((await page.evaluate(a.diffRowCount)) as number > 0 ? null : 'diff rendered no rows'),
  },
  {
    name: 'scroll-diff',
    run: async (page, a) => {
      await page.evaluate((sel) => { const el = document.querySelector(sel) as HTMLElement | null; if (el) el.scrollTop = 0; }, a.name === 'rust' ? '#diff-root' : '[data-testid="diff"]');
      const latencies: number[] = [];
      for (let i = 0; i < 20; i += 1) {
        const started = await page.evaluate(() => performance.now());
        await page.evaluate((sel) => { const el = document.querySelector(sel) as HTMLElement | null; if (el) el.scrollTop += 480; }, a.name === 'rust' ? '#diff-root' : '[data-testid="diff"]');
        const painted = await page.evaluate((limit) => new Promise<number>((resolve) => {
          const fallback = setTimeout(() => resolve(-1), limit);
          requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(fallback); resolve(performance.now()); }));
        }), FRAME_TIMEOUT_MS);
        if (painted >= 0) latencies.push(painted - started);
      }
      return latencies;
    },
    verify: async (page, a) => ((await page.evaluate(a.diffScrollTop)) as number > 0 ? null : 'diff did not scroll'),
  },
  {
    name: 'open-huge-pr',
    run: async (page, a) => {
      if (a.goHome && (await page.evaluate(() => !!document.querySelector('[data-testid="detail-back"]')))) await a.goHome(page);
      const started = await page.evaluate(() => performance.now());
      await a.clickHugeRow(page);
      await page.waitForFunction(a.detailReady, undefined, { timeout: 30_000 });
      await settle(page);
      const painted = await page.evaluate(() => performance.now());
      return [painted - started];
    },
    verify: async (page, a) => ((await page.evaluate(a.hugeStatCheck)) ? null : 'huge diff did not render its content/stats'),
  },
];

async function measure(a: Adapter, url: string): Promise<AppReport> {
  const failures: string[] = [];
  const browser: Browser = await chromium.launch({ executablePath: process.env.BENCH_CHROME, headless: true, args: ['--disable-gpu-vsync', '--disable-frame-rate-limit'] });
  try {
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1, reducedMotion: 'reduce' });
    page.on('pageerror', (error) => failures.push(`page error: ${error.message}`));
    await page.addInitScript((init) => {
      Object.assign(window, { __longTasks: 0 });
      new PerformanceObserver((list) => Object.assign(window, { __longTasks: (window as unknown as { __longTasks: number }).__longTasks + list.getEntries().length })).observe({ type: 'longtask', buffered: true });
      if (init) eval(init);
    }, a.initScript?.toString() ?? '');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    // Cold start + first render, before CPU throttling.
    const navStart = Date.now();
    await page.goto(`${url}/${a.urlQuery}`);
    const gotoMs = Date.now() - navStart;
    await page.waitForFunction(a.rowsVisible, undefined, { timeout: 30_000 });
    const firstRowsMs = Date.now() - navStart;
    await settle(page);
    const bootMetrics = await metrics(cdp);
    const cold: ColdStart = { gotoMs, firstRowsMs, heapMb: bootMetrics.heapMb, scriptMs: bootMetrics.scriptMs, taskMs: bootMetrics.taskMs };
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });
    const results: ScenarioResult[] = [];
    for (const scenario of SCENARIOS) {
      const before = await metrics(cdp);
      const longBefore = await page.evaluate(() => (window as unknown as { __longTasks: number }).__longTasks);
      const started = Date.now();
      const latencies = await scenario.run(page, a);
      await settle(page);
      const problem = await scenario.verify(page, a);
      if (problem != null) failures.push(`${scenario.name}: ${problem}`);
      const after = await metrics(cdp);
      const longAfter = await page.evaluate(() => (window as unknown as { __longTasks: number }).__longTasks);
      results.push({
        name: scenario.name,
        wallMs: Date.now() - started,
        p95KeyMs: percentile(latencies, 0.95),
        longTasks: longAfter - longBefore,
        layouts: after.layouts - before.layouts,
        styleRecalcs: after.styleRecalcs - before.styleRecalcs,
        scriptMs: after.scriptMs - before.scriptMs,
        taskMs: after.taskMs - before.taskMs,
        heapMb: after.heapMb,
        nodes: after.nodes,
        domListRows: await page.evaluate(a.listRowCount) as number,
      });
      // scroll-diff is the last detail-route scenario before open-huge-pr
      // (which returns home itself first); nothing else leaves the detail route.
      if (scenario.name === 'scroll-diff' && a.goHome) await a.goHome(page);
    }
    return { app: a.name, cold, scenarios: results, failures, stalls: frameStalls };
  } finally {
    await browser.close();
  }
}

function median(values: number[]): number { return percentile(values, 0.5); }
function combineRuns(runs: AppReport[]): AppReport {
  const first = runs[0]!;
  const pickCold = (key: keyof ColdStart): number => median(runs.map((run) => run.cold[key]));
  const scenarios = first.scenarios.map((s, index) => {
    const pick = (key: keyof Omit<ScenarioResult, 'name'>): number => median(runs.map((run) => run.scenarios[index]![key]));
    return { name: s.name, wallMs: pick('wallMs'), p95KeyMs: pick('p95KeyMs'), longTasks: pick('longTasks'), layouts: pick('layouts'), styleRecalcs: pick('styleRecalcs'), scriptMs: pick('scriptMs'), taskMs: pick('taskMs'), heapMb: pick('heapMb'), nodes: pick('nodes'), domListRows: pick('domListRows') };
  });
  return { app: first.app, cold: { gotoMs: pickCold('gotoMs'), firstRowsMs: pickCold('firstRowsMs'), heapMb: pickCold('heapMb'), scriptMs: pickCold('scriptMs'), taskMs: pickCold('taskMs') }, scenarios, failures: [...new Set(runs.flatMap((run) => run.failures))], stalls: runs.reduce((sum, run) => sum + run.stalls, 0) };
}

async function main(): Promise<void> {
  console.error(`host: ${cpus().length} cores · runs: ${RUNS} interleaved · cpu throttle: ${CPU_THROTTLE}x · pulls: ${PULLS}`);
  // The VM's node is too old for vite; run vite's bin under bun.
  await Bun.$`bun node_modules/vite/bin/vite.js build -c exact/bench/vite.config.ts`.cwd(repoRoot).quiet();
  const rustServer = serve(rust.dist);
  const exactServer = serve(exact.dist);
  try {
    const rustRuns: AppReport[] = [];
    const exactRuns: AppReport[] = [];
    for (let run = 0; run < RUNS; run += 1) {
      rustRuns.push(await measure(rust, rustServer.url));
      exactRuns.push(await measure(exact, exactServer.url));
      console.error(`run ${run + 1}/${RUNS} done`);
    }
    const report = { pulls: PULLS, cpuThrottle: CPU_THROTTLE, runs: RUNS, rust: combineRuns(rustRuns), exact: combineRuns(exactRuns) };
    console.log(JSON.stringify(report, null, 1));
    const allFailures = [...report.rust.failures.map((f) => `rust: ${f}`), ...report.exact.failures.map((f) => `exact: ${f}`)];
    console.error(`WORK CHECKS ${allFailures.length === 0 ? 'OK' : `FAILED (${allFailures.length})`}`);
    allFailures.forEach((failure) => console.error(`  - ${failure}`));
    if (report.rust.stalls + report.exact.stalls > 0) console.error(`FRAME STALLS ${report.rust.stalls + report.exact.stalls}`);
  } finally {
    rustServer.stop();
    exactServer.stop();
  }
}

if (import.meta.main) await main();
