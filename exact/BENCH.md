# Benchmark: Exact app vs Rust/Tauri app

Method, raw numbers, and harness for comparing the two implementations of the
same PR-review app. Everything here is reproducible from this directory; the
harness script is `bench/crossbench.ts`, the raw output is
`bench/results-web.json`.

## What is measured, honestly

Both apps render the same generated fixture: 400 pull requests (numbers
40000–40399, mulberry32 seed 42), where **PR #40010 carries the huge diff** —
a 1,960,068-byte unified patch, ~43,778 lines across 149 files (140 small
files, 6 files of 1,800–5,500 lines, an 8,000-line lockfile, a 3,000-line
snapshot, one rename). `fixturelib.ts` is the single source of truth for the
fixtures of both harnesses.

**Rust app.** The Tauri shell is macOS-only, and these numbers are measured on
a Linux VM, so what is measured is the Rust app's *real frontend code* — all
of `src/` unmodified — built by vite against a copy of `bench/shim/` that
answers Tauri `invoke` calls from the same fixtures. The only edit in the copy
is the huge-diff override: `diff` for PR #40010 returns `hugePatch()`. This
measures the app's UI and frontend architecture exactly, but with **zero IPC
and zero Rust backend latency**, which favors it slightly; it says nothing
about the native shell's cold start, which cannot exist on Linux. The copy
lives in `bench/shim/` next to the harness; the original `bench/` is untouched.

**Exact app.** The static web build of the Exact app (`bun exact.mjs
web-build` → `target/web-dist`), fixture mode, served as static files. No
measurement-specific code exists in the app.

**Harness** (`bench/crossbench.ts`): headless Chromium (same binary for both,
`chrome-headless-shell` 1255), CDP `Performance.getMetrics`, 4× CPU throttle
during scenarios, viewport 1480×940, interaction latency measured per key as
keypress-to-second-`requestAnimationFrame` paint, long tasks counted with a
`PerformanceObserver`. 5 interleaved runs per app, medians reported; every
scenario ends with a work check (selection moved, filter applied, diff
scrolled, huge PR rendered) — `WORK CHECKS OK` for all results below. Scenarios
perform the same logical operations through each app's real UI: the Rust app's
`#pr-list li` rows and the Exact app's `data-testid` rows.

Scenario semantics, and one necessary asymmetry: the Rust app is a three-pane
window (list + detail always visible), the Exact app is router-based (list
route, detail route). `navigate-list` (60× `j`) and `type-filter` (`/` then
`refactor`) run on the list in both. `open-pr` clicks PR #40005. `scroll-diff`
scrolls the diff container 480px per step, 20 steps. `open-huge-pr` opens
#40010. Scroll fps is not directly measurable in headless Chromium; scroll
jank is reported as long tasks and per-step paint latency instead.

## Results (medians of 5 interleaved runs, 4× CPU throttle)

Cold start and first render (before throttling, fresh browser per run):

| | goto | first rows visible | heap after boot | boot script | boot task |
|---|---|---|---|---|---|
| rust | 142 ms | 180 ms | 7.8 MB | 27 ms | 199 ms |
| exact | 88 ms | 146 ms | 5.1 MB | 57 ms | 154 ms |

Scenarios (p95 key/paint latency, task ms, long tasks, layout count, heap):

| scenario | metric | rust | exact |
|---|---|---|---|
| navigate-list | p95 latency | 273 ms | 81 ms |
| | task ms / long tasks | 11710 / 118 | 2053 / 1 |
| type-filter | p95 latency | 101 ms | 282 ms |
| | task ms / long tasks | 561 / 4 | 1234 / 14 |
| open-pr | paint latency | 325 ms | 507 ms |
| | task ms / long tasks | 333 / 2 | 996 / 7 |
| scroll-diff | p95 step latency | 73 ms | 348 ms |
| | task ms / long tasks | 160 / 1 | 5264 / 79 |
| open-huge-pr | paint latency | 325 ms | 628 ms |
| | task ms / long tasks | 306 / 2 | 601 / 5 |
| end-state heap | | 49.2 MB | 14.8 MB |

Entry-point bytes (script + style referenced by `index.html`; the Rust build
also emits ~10 MB of lazily-loaded syntax-highlighting language chunks):

| | entry bytes |
|---|---|
| rust | 945 KB (864 KB js + 82 KB css) |
| exact | 481 KB js |

Rendered queue rows in the DOM after boot: rust 47, exact 56 (both virtualize;
the Exact list keeps fewer rows in the detail route, 37).

## What the numbers say

- **Cold start and memory favor Exact.** First rows 146 ms vs 180 ms, entry
  bytes roughly half, and heap stays under 15 MB end-to-end where the Rust
  frontend drifts to ~49 MB. Some of the heap difference is the diff
  implementations' row models; both apps cap and lazily expand large files.
- **List navigation is far cheaper in Exact** (1 long task vs 118 across 60
  presses). The Rust frontend re-renders row state expensively at 4× throttle;
  the Exact list's virtualized keyed rows barely work.
- **Detail-route work is slower in Exact.** `open-pr` +507 ms paint vs +325 ms
  for the Rust frontend, and diff scrolling is the Exact app's worst surface:
  p95 348 ms per 480px step with 79 long tasks, versus 73 ms/1 long task for
  `@pierre/diffs` in the Rust app. The Exact app flattens the entire diff into
  one virtualized list of per-line rows; each scroll window re-materializes
  many small row elements, and lines render without the syntax highlighting
  the Rust app ships (a rendering-quality difference in Exact's favor cost-wise,
  noted for honesty). `type-filter` shows the same shape: per-key filtering of
  400 rows costs more through Exact's resource/derive pipeline than the Rust
  app's direct DOM updates.
- **The huge diff opens in both apps without breaking.** Exact: 628 ms to
  paint, file headers collapsed/lazy per the caps in `app.ts`
  (`INLINE_FILE_ROWS` 1500, `INLINE_TOTAL_ROWS` 12000, files over 1500 lines
  load rows only when expanded, patches over 3000 files are dropped with a
  visible count). Rust frontend: 325 ms — again noting it pays no IPC cost for
  the 2 MB patch string in this harness, where the real Tauri shell must
  serialize it across the bridge.

## Reproduce

```bash
# rust frontend build + exact web build + 5 interleaved runs, results to stdout
bun exact.mjs web-build                 # in exact/, once (or after app edits)
BENCH_RUNS=5 bun exact/bench/crossbench.ts   # from the repo root
```

`BENCH_CHROME` selects the Chromium binary (default: playwright's). Raw output
of the run above is committed as `bench/results-web.json`.

## Not measured

- The Rust app's native macOS shell cold start and memory (no macOS host in
  this environment; the shell is what most users would call "the app's"
  startup).
- Android runtime performance of the Exact app (the APK builds; benchmark
  numbers above are web-only, as labeled).
- Real GitHub network behavior; both harnesses are offline by design.
