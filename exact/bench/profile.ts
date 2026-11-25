// CPU profiler for the Exact app's slow scenarios: drives the same operations
// as crossbench.ts under the same 4x CPU throttle while the CDP Profiler
// samples, then prints self/total time per function, each with a source
// snippet resolved from the bundle at the sample's line:column (the build
// minifies local names; the snippet identifies them). Harness-only.
//
// Run from the repo root:  bun exact/bench/profile.ts [scenario…]
// scenarios: scroll-diff, open-huge-pr, type-filter, open-pr (default: all)
import { chromium, type CDPSession, type Page } from 'playwright-core';
import { join, basename } from 'node:path';
import { readFileSync } from 'node:fs';

const VIEWPORT = { width: 1480, height: 940 };
const CPU_THROTTLE = Number(process.env.BENCH_CPU ?? 4);
const WANTED = process.argv.slice(2);
const DIST = join(import.meta.dir, '..', 'target', 'web-dist');

interface CallFrame { functionName: string; url: string; lineNumber: number; columnNumber: number; }
interface ProfileNode { id: number; callFrame: CallFrame; hitCount?: number; children?: number[]; }
interface CpuProfile { nodes: ProfileNode[]; samples?: number[]; timeDeltas?: number[]; }

const fileCache = new Map<string, string[]>();
function snippet(frame: CallFrame): string {
  const file = basename(frame.url);
  if (!file.endsWith('.js') && !file.endsWith('.mjs')) return '';
  try {
    if (!fileCache.has(file)) fileCache.set(file, readFileSync(join(DIST, file), 'utf8').split('\n'));
    const line = fileCache.get(file)![frame.lineNumber] ?? '';
    return line.slice(Math.max(0, frame.columnNumber - 10), frame.columnNumber + 90).replace(/\s+/g, ' ').trim();
  } catch { return ''; }
}

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

function flatten(profile: CpuProfile): { rows: [string, number, number, string][]; totalMs: number } {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map<number, number>();
  const deltas = profile.timeDeltas ?? [];
  const samples = profile.samples ?? [];
  for (let i = 0; i < samples.length; i++) self.set(samples[i]!, (self.get(samples[i]!) ?? 0) + (deltas[i] ?? 0));
  const totalUs = deltas.reduce((a, b) => a + b, 0);
  const totalOf = new Map<number, number>();
  const walk = (id: number): number => {
    if (totalOf.has(id)) return totalOf.get(id)!;
    const node = byId.get(id)!;
    let t = self.get(id) ?? 0;
    for (const c of node.children ?? []) t += walk(c);
    totalOf.set(id, t);
    return t;
  };
  for (const n of profile.nodes) walk(n.id);
  const selfByName = new Map<string, number>();
  const totalByName = new Map<string, number>();
  const snippetByName = new Map<string, string>();
  for (const n of profile.nodes) {
    const name = n.callFrame.functionName || '(anonymous)';
    selfByName.set(name, (selfByName.get(name) ?? 0) + (self.get(n.id) ?? 0));
    totalByName.set(name, Math.max(totalByName.get(name) ?? 0, totalOf.get(n.id) ?? 0));
    if (!snippetByName.has(name)) snippetByName.set(name, `${basename(n.callFrame.url)}:${n.callFrame.lineNumber + 1}:${n.callFrame.columnNumber} ${snippet(n.callFrame)}`);
  }
  const rows = [...selfByName.entries()].map(([name, s]) => [name, s / 1000, (totalByName.get(name) ?? 0) / 1000, snippetByName.get(name) ?? ''] as [string, number, number, string]);
  rows.sort((a, b) => b[1] - a[1]);
  return { rows, totalMs: totalUs / 1000 };
}

async function openDetail(page: Page, number: number): Promise<void> {
  await page.locator(`[data-testid="row-${number}"]`).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid^="diffrow-"]').length > 0, undefined, { timeout: 15_000 });
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0)))));
}

async function clearFilter(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    const input = document.querySelector('[data-testid="filter"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.blur();
  });
  await settle(page);
}

async function profileScenario(page: Page, cdp: CDPSession, name: string, body: () => Promise<void>): Promise<void> {
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
  await cdp.send('Profiler.start');
  const started = await page.evaluate(() => performance.now());
  await body();
  const elapsed = await page.evaluate(() => performance.now()) - started;
  const { profile } = (await cdp.send('Profiler.stop')) as { profile: CpuProfile };
  const { writeFileSync } = await import('node:fs');
  writeFileSync(`/tmp/prof-${name}.json`, JSON.stringify(profile));
  const { rows, totalMs } = flatten(profile);
  console.log(`\n=== ${name}: wall ${elapsed.toFixed(0)} ms, sampled ${totalMs.toFixed(0)} ms ===`);
  console.log('self ms · total ms · function · snippet');
  for (const [fn, self, total, snip] of rows.slice(0, 22)) console.log(`${self.toFixed(1).padStart(8)} ${total.toFixed(1).padStart(9)}  ${fn.padEnd(28)} ${snip.slice(0, 100)}`);
}

async function main(): Promise<void> {
  const server = serve(DIST);
  const browser = await chromium.launch({ executablePath: process.env.BENCH_CHROME, headless: true, args: ['--disable-gpu-vsync', '--disable-frame-rate-limit'] });
  try {
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1, reducedMotion: 'reduce' });
    await page.goto(server.url + '/');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid^="row-"]').length > 0, undefined, { timeout: 30_000 });
    // hook row construction counters now that the runtime exists
    await page.evaluate(() => {
      const counts = { rowConstructed: 0, rowRetired: 0, list: new Map<string, number>() };
      Object.assign(window, { __rowWork: counts });
      const exact = (window as any).exact ??= {};
      exact.rowWork = (el: Element, kind: string) => {
        counts[kind as 'rowConstructed' | 'rowRetired'] = (counts[kind as 'rowConstructed' | 'rowRetired'] ?? 0) + 1;
        const id = (el as HTMLElement).id || '?';
        if (kind === 'rowConstructed') counts.list.set(id, (counts.list.get(id) ?? 0) + 1);
      };
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });
    const rowCount = () => page.evaluate(() => { const c = (window as any).__rowWork; return { rowConstructed: c.rowConstructed, rowRetired: c.rowRetired, list: Object.fromEntries(c.list) }; });

    if (WANTED.length === 0 || WANTED.includes('type-filter')) {
      await profileScenario(page, cdp, 'type-filter', async () => {
        await page.keyboard.press('/');
        for (const k of [...'refactor']) { await page.keyboard.press(k); await settle(page); }
      });
      console.log('rowWork after type-filter:', JSON.stringify(await rowCount()));
      await clearFilter(page);
    }

    if (WANTED.length === 0 || WANTED.includes('open-pr')) {
      await profileScenario(page, cdp, 'open-pr', async () => {
        await openDetail(page, 40005);
        await settle(page);
      });
      console.log('rowWork after open-pr:', JSON.stringify(await rowCount()));
    }

    if (WANTED.length === 0 || WANTED.includes('scroll-diff')) {
      if (!(await page.evaluate(() => !!document.querySelector('[data-testid="diff"]')))) await openDetail(page, 40005);
      await profileScenario(page, cdp, 'scroll-diff', async () => {
        await page.evaluate(() => { const el = document.querySelector('[data-testid="diff"]') as HTMLElement; el.scrollTop = 0; });
        for (let i = 0; i < 20; i++) {
          await page.evaluate(() => { const el = document.querySelector('[data-testid="diff"]') as HTMLElement; el.scrollTop += 480; });
          await settle(page);
        }
      });
      console.log('rowWork after scroll-diff:', JSON.stringify(await rowCount()));
      console.log('diff rows in DOM:', await page.evaluate(() => document.querySelectorAll('[data-testid^="diffrow-"]').length));
      console.log('total DOM nodes:', await page.evaluate(() => document.querySelectorAll('*').length));
    }

    if (WANTED.length === 0 || WANTED.includes('open-huge-pr')) {
      if (await page.evaluate(() => !!document.querySelector('[data-testid="detail-back"]'))) {
        await page.locator('[data-testid="detail-back"]').click();
        await page.waitForFunction(() => document.querySelectorAll('[data-testid^="row-"]').length > 0, undefined, { timeout: 10_000 });
      }
      await profileScenario(page, cdp, 'open-huge-pr', async () => {
        await openDetail(page, 40010);
        await settle(page);
      });
      console.log('rowWork after open-huge-pr:', JSON.stringify(await rowCount()));
    }
  } finally {
    await browser.close();
    server.stop();
  }
}

if (import.meta.main) await main();
