---
name: hill-climb
description: Hill-climb performance on PR Review across all surfaces — frontend UI rendering/interactions (`bun run climb`), Rust/GitHub fetching and caching (`bun run climb:net`), and live GitHub calibration (`live_github`) — following benchmark-checklist discipline (interleaved A/B, noise floor check, limiter identification, work and error verification, keep-or-revert per step). Use whenever asked to optimize, speed up, benchmark, or hill-climb PR Review.
---

# Hill-climbing PR Review

Follow this recipe for every performance improvement on `pr-review`. Do not guess at wins; prove each step against `HEAD` on the right surface, explain the limiter, and keep or revert atomically.

## 1. Pick the surface

| Surface | Code | Harness | Gate + A/B command | Noise check |
|---|---|---|---|---|
| **UI / rendering / IPC** | `src/`, `index.html` | `bench/run.ts` (headless Chromium, 400 PRs, 4× CPU) | `bun run climb` | `bun run bench:noise` |
| **GitHub fetching / Rust backend / caching** | `src-tauri/src/lib.rs` | `bench/net.ts` (`--release` `net_bench` vs calibrated loopback GitHub mock) | `bun run climb:net` | `bun run bench:net:noise` |
| **Cross-cutting (both)** | `src/` + `src-tauri/` | Both harnesses | `bun run climb:all` | Both noise checks |

> **Frozen contract rule:** Never edit `bench/`, `src-tauri/examples/net_bench.rs`, or `src/**/*.test.ts` in the same step you are scoring. If a harness needs a new scenario or bug fix, land and commit that first as its own commit, re-run the noise self-test, and only then climb against that frozen baseline.

## 2. Vet the baseline (before writing code)

1. Confirm a clean working tree (`git status --short`) and check host load (`uptime`, core count). Both harnesses print `host:` automatically.
2. Run the noise self-test once for the surface you are climbing:
   - UI: `bun run bench:noise -- --spread` (expect `SCORE` within `~0.98–1.02`).
   - Network: `bun run bench:net:noise -- --spread` (expect `SCORE` within `~0.99–1.01`).
   - If noise exceeds `CLIMB_NOISE` (`1.02`), check what else is hogging CPU or raise `BENCH_RUNS` (e.g. `BENCH_RUNS=7`) / `CLIMB_NOISE`.
3. Read the baseline table and **name the limiter before editing code**:
   - **UI limiters:** high `layouts` or `styleRecalcs` (forced sync layout, DOM thrashing), high `longTasks` / `taskMs` (synchronous diff parse, list filter/sort), high `maxRenderedRows` (virtualization gap), high `invokes` (duplicate fetches or missing prefetch/cache).
   - **Network limiters:** high `requests` (missing batching, missing incremental cache, uncombined GraphQL queries), low `maxInFlight` vs pool size `12` (sequential waterfall, e.g. serial pagination or awaiting an unnecessary request), high `kbOut` / `0` `304s` (missing ETag or over-fetching fields), high `wallMs` on `queue-cold-300` vs `queue-warm-300` (search round-trips vs detail batches).

## 3. One hypothesis per step (keep or revert)

1. State the hypothesis and expected ceiling from the baseline numbers (e.g. "avoiding the second search round-trip on 20-PR queues cuts `queue-small-20` requests 4→3 and wallMs ~15%").
2. Implement the smallest, cleanest change in `src/` or `src-tauri/src/lib.rs`.
3. Run the gate + interleaved A/B comparison:
   - UI: `bun run climb` (or `bun run bench -- --spread` to inspect ranges).
   - Network: `bun run climb:net` (or `bun run bench:net -- --spread`).
   - Both: `bun run climb:all`.
4. Vet the result against the benchmark checklist:
   - **Errors & work checks:** `WORK CHECKS` must be `OK` and `errors` must be `0` on every scenario.
   - **Reproducibility:** median beat baseline by more than `CLIMB_NOISE` (`1.02`) AND the `--spread` min–max ranges do not overlap trivially on the moved scenario.
   - **Sanity check limits:** the measured gain cannot exceed the share of time/work the changed piece actually took (if it does, inspect for a broken cache, skipped work, or mock mismatch).
5. **Keep or revert:**
   - **Exit 0 (`KEEP`) + verified:** commit atomically (`perf: <what changed and measured gain>`) so the next step benches against the new `HEAD`.
   - **Exit 1 (`REVERT`) or inconclusive:** `git checkout -- .` and record why the hypothesis didn't move the limiter.

## 4. Calibrating against live GitHub (end of a network climb)

The loopback mock (`bench/net.ts`) models real GitHub latencies at `0.1×` scale (`BENCH_NET_SCALE=1.0` runs real-time seconds) so you can iterate fast without burning your 5,000/hr GraphQL quota.

After finishing a network climb (or before shipping a release), run **one** live sanity check against real GitHub to confirm real-world latencies and zero errors:

```bash
cargo test --manifest-path src-tauri/Cargo.toml -- --ignored live_github --nocapture
```

If real GitHub's latency curve diverges materially from `bench/net.ts` (for example, a new field is much slower on GitHub than mocked), update the latency formula in `bench/net.ts` in a separate calibration commit before the next climb.

## 5. Reporting a win

Lead with the verdict, then give:
- Primary number + unit (`SCORE`, scenario `wallMs` / `requests` / `layouts` before → after)
- Run count and `--spread` min–max range per side
- The limiter that moved (and what the next limiter is)
- Confirmation that `WORK CHECKS` passed with `0` errors
