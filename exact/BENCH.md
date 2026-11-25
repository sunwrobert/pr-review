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

## Root causes of the three slow paths (profiled, then fixed)

Profiling used CDP CPU profiles (`bench/profile.ts`) plus the harness's
layout/style-recalc counters. The guesses in the previous writeup were only
half right:

**scroll-diff was not slow because re-materializing rows is expensive.** Row
construction was ~10% of samples. The cost was the web runtime's virtualized
list measurement loop forcing repeated synchronous layouts. Every scroll event
runs the collection glue's `flush()`: `geometry()` reads the port's
`scrollHeight`/`clientHeight` (in the scroll clamp `scrollOffset()`), which
forces a full synchronous layout whenever the DOM is dirty — and mid-scroll
the DOM is always dirty, because realizing newly visible rows mutates it. Each
pass through the loop realizes rows, measures them (`getBoundingClientRect`
per row), and writes positions; corrected sizes start another pass, up to four
per frame. Every pass re-reads the layout-forcing values. In the profile the
clamp leaf alone held ~60% of all samples; the harness counted 241 forced
layouts across 20 scroll steps where the Rust frontend needed 3. What made it
worse: one list row per diff line meant ~99 mounted rows and ~34 rows entering
the window per 480px step, each needing measurement, and per-line heights that
never matched the list's size estimate — so every measurement produced a
correction and another pass.

The fix, all app-side:

- **Chunked rows.** 64 lines per list row (`CHUNK_LINES` in `app.ts`). A
  viewportful is now ~2 mounted rows instead of ~99, and a 480px step crosses
  a row boundary only about one step in four, so most steps never realize
  anything at all.
- **Rows whose heights are exact.** Every diff line is precisely 18px
  (line-height `1rem` = 16px + 2px padding at the default text size; rem so
  the row still grows at larger text sizes), so a full chunk is exactly
  64×18 = 1152px and `estimated-item-height` matches measurement bit for bit.
  No correction, no extra pass, no re-layout.
- **A leaner line element**: 5 DOM nodes per line instead of 8, one wrapping
  row fewer per line.

Layouts per 20 steps: 241 → 34; long tasks: 79 → 14. What remains versus the
Rust frontend (186 ms vs 81 ms p95) is the cost of the passes that do still
run on boundary-crossing steps — the clamp read is inherent to the runtime —
not row count.

**type-filter had nothing to do with the resource/derive pipeline.** No
app-side filter cost appears in the profile at all. It is the same measurement
loop on the queue list: every keystroke re-keys the visible rows, and because
rows were variable-height (wrapped titles, wrapped metadata), every measured
row disagreed with its estimate — a correction, another pass, another forced
layout: 61 forced layouts across 8 keystrokes. The fix is uniform-height rows
(fixed rem line-heights, no wrapping at the default size) and the accurate
`estimated-item-height`; layouts per keystroke fell from ~8 to ~5 and the
correction cascade no longer runs (14 long tasks → 2, on par with the Rust
frontend's 4).

**open-huge-pr was two costs stacked.** (a) App-side: `shapeDiff` eagerly
built a row object for every one of the 43,778 lines of *every* file —
including lazy files whose rows never ship — tens of thousands of objects
allocated and immediately shelved, with visible GC in the profile. (b)
Runtime-side: the first window's measurement passes over 149 file-header rows
whose measured heights disagreed with the estimate, plus deterministic fixture
generation (~25 ms). The fix for (a): `scanPatch` walks the patch once with no
per-line allocation, counting lines/additions/deletions and recording each
file's byte range; line objects are parsed only for files that ship inline,
and lazy files parse on demand when expanded (fixture patches regenerate
deterministically; live patches are kept in the cache). App-side script time
for the open fell from ~160 ms of parse+shape+GC to under 30 ms. The remaining
gap to the Rust frontend (529 ms vs 323 ms) is mostly (b).

## Results (medians of 5 interleaved runs, 4× CPU throttle)

All three columns are measured on the same VM in the same harness; "exact
before" is the pre-fix app re-measured here (the numbers committed previously
were taken on a different machine).

Cold start and first render (before throttling, fresh browser per run):

|| goto | first rows visible | heap after boot | boot script | boot task |
|---|---|---|---|---|---|
| rust | 208 ms | 252 ms | 6.0 MB | 29 ms | 255 ms |
| exact before | 76 ms | 148 ms | 6.1 MB | 47 ms | 130 ms |
| exact after | 81 ms | 142 ms | 5.1 MB | 47 ms | 129 ms |

Scenarios (p95 key/paint latency, task ms, long tasks, layout count):

| scenario | metric | rust | exact before | exact after |
|---|---|---|---|---|
| navigate-list | p95 latency | 352 ms | 97 ms | **87 ms** |
| | task ms / long tasks | 14800 / 146 | 2339 / 2 | 2149 / 2 |
| type-filter | p95 latency | 173 ms | 325 ms | **194 ms** |
| | task ms / long tasks | 662 / 4 | 1369 / 17 | 651 / 2 |
| | layouts | 23 | 61 | 42 |
| open-pr | paint latency | 343 ms | 530 ms | **423 ms** |
| | task ms / long tasks | 347 / 3 | 1088 / 8 | 496 / 3 |
| scroll-diff | p95 step latency | 87 ms | 291 ms | **186 ms** |
| | task ms / long tasks | 247 / 1 | 5399 / 78 | 1721 / 14 |
| | layouts | 3 | 241 | 34 |
| open-huge-pr | paint latency | 339 ms | 641 ms | **529 ms** |
| | task ms / long tasks | 328 / 2 | 647 / 5 | 482 / 3 |
| end-state heap | | 40.6 MB | ~15 MB | **11.4 MB** |

Entry-point bytes (script + style referenced by `index.html`; the Rust build
also emits ~10 MB of lazily-loaded syntax-highlighting language chunks):

|| entry bytes |
|---|---|
| rust | 945 KB (864 KB js + 82 KB css) |
| exact | 481 KB js |

## What the numbers say

- **Cold start, memory, and list navigation favor Exact.** First rows 142 ms
  vs 252 ms, entry bytes roughly half, heap 11.4 MB end-to-end where the Rust
  frontend drifts past 40 MB, and `navigate-list` runs at 87 ms p95 with 2
  long tasks against the Rust frontend's 352 ms with 146.
- **Diff scrolling and filtering are much closer than they were** but still
  behind: scroll-diff 186 ms vs 87 ms, type-filter 194 ms vs 173 ms. Both are
  now dominated by the runtime's per-pass scroll-clamp layout read on the
  steps that realize new content, not by anything the app can restructure away
  — further gains there are runtime work (fewer layout-forcing reads per
  pass), not app work.
- **Opening a pull is still slower** (423 ms vs 343 ms ordinary, 529 ms vs
  339 ms huge). The huge PR's remaining cost is first-window measurement over
  the file headers, not parsing — the patch scan itself is single-digit ms.
- **The huge diff opens in both apps without breaking**, with honest caps in
  `app.ts` (`INLINE_FILE_ROWS` 1500, `INLINE_TOTAL_ROWS` 12000, files over
  1500 lines load rows only when expanded, patches over 3000 files dropped
  with a visible count). Lines render without the syntax highlighting the
  Rust app ships (a rendering-quality difference in Exact's favor cost-wise,
  noted for honesty), and the Rust frontend pays no IPC cost for the 2 MB
  patch string here, where the real Tauri shell must serialize it across the
  bridge.

## Reproduce

```bash
# rust frontend build + exact web build + 5 interleaved runs, results to stdout
bun exact.mjs web-build                 # in exact/, once (or after app edits)
BENCH_RUNS=5 bun exact/bench/crossbench.ts   # from the repo root
```

`BENCH_CHROME` selects the Chromium binary (default: playwright's). Raw output
of the run above is committed as `bench/results-web.json`.

## Exact Android runtime numbers

Measured on the debug APK (`app-release.apk`) installed on a headless
emulator: Android 36 x86_64 system image, KVM-accelerated CPU, **software
rendering** (swiftshader). The driver is `bench/android-bench.sh`: adb
input/swipe/tap, `uiautomator dump` for work verification, `dumpsys gfxinfo`
for jank, `am start -W` for cold start, `dumpsys meminfo` for memory. These
numbers are not comparable to the web table column-by-column: an x86_64
emulator with software rendering is not a phone, and input injection is not a
finger. They are a documented run of the same scenarios on the same fixtures,
as far as the platform honestly allows.

| metric | android | exact web (same run as above) |
|---|---|---|
| cold start (median of 5) | 1158 ms (`am start -W` TotalTime; 1057–1223 across the five) | 142 ms first rows |
| memory after cold start | 167 MB PSS | 5.1 MB heap |
| memory after huge PR | 244 MB PSS | 11.4 MB heap |
| navigate-list scroll | 3.5% janky frames, p95 36 ms/frame | p95 paint 87 ms/key |
| open-huge-pr | 536 ms tap-to-quiescent, stats rendered ("149 files" visible) | 529 ms paint |

Cold start was re-measured on this round's APK (arm64-v8a + x86_64, signed
with the debug key): the queue rendered after launch with "#40000" visible to
uiautomator, a tap on #40005 opened the diff (file stats and hunks visible),
and the platform back control returned to the queue. The earlier run's 3313 ms
was the same measurement on the previous APK build; the improvement is mostly
the emulator image settling in this VM, not the app changes — treat both as
upper bounds under software rendering. The swipe/jank rows below are still
the previous APK's run. Memory is whole-app PSS (ART, the runtime, GPU driver
included), which is why it cannot be set against the web heap column directly.

Honest gaps in the Android run:

- **open-pr for an ordinary PR could not be measured**: the tap target
  `#40005`'s text node was absent from the uiautomator dump in two of three
  attempts (rows near the top render, but the dump intermittently missed
  individual row texts; `#40010` matched once, `#40005` never). No number is
  reported rather than an unverified one.
- **scroll-diff jank is not reported**: the open-pr tap failure meant no
  ordinary diff was open during the swipe burst, so the frames measured were
  not a diff scroll. The list-scroll number above *is* valid (the queue was
  verified visible).
- **type-filter and the keyboard scenarios are not applicable on Android**:
  the platform delivers keys only to a focused field and the emulator image
  has no hardware keyboard flow; filtering is a keyboard-first interaction
  in this app.
- tap-to-quiescent is a coarse wall metric (input injection to frames stable
  across two 200 ms polls); it does not capture async parse work that
  produces no frames, and swiftshader inflates every frame cost.
- Cold start on a real arm64 device with hardware rendering would be
  strictly faster than 1158 ms; treat that figure as an upper bound under
  hostile conditions, not a device number.

## Not measured

- The Rust app's native macOS shell cold start and memory (no macOS host in
  this environment; the shell is what most users would call "the app's"
  startup).
- Real GitHub network behavior; both harnesses are offline by design.
