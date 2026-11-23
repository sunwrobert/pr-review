# Perf harnesses

Two offline, `benchmark-checklist`-compliant hill-climbing loops covering every surface in the app:

1. **Frontend UI & IPC (`bench/run.ts`, `bench/climb.sh`)** — headless Chromium against generated fixtures (`400` PRs, `4×` CPU throttle), measuring layouts, style recalcs, rendered rows, long tasks, task ms, p95 key latency, and backend `invoke` counts across 9 scenarios (`navigate-list`, `filter-chips`, `visual-select`, `type-filter`, `theme-preview`, `scroll-diff`, `open-pr`, `hover-open`, `refresh`).
2. **Rust / GitHub network (`bench/net.ts`, `bench/climb-net.sh`, `src-tauri/examples/net_bench.rs`)** — real `--release` Rust binary (`pr_review_lib::bench_api`) against a deterministic loopback GitHub mock calibrated to real GitHub latency curves (search, full details, live-only details, `merge_states`, `failing_checks`, `pull_details`, raw diffs with ETag `304`, and 8-page `Link: rel="last"` `/files` fallback). Zero GitHub rate-limit burn.

## Commands

```bash
# Correctness gates
bun run check                 # tsc, unit + property tests, 40-run keyboard model test
cargo test --manifest-path src-tauri/Cargo.toml

# Frontend UI surface
bun run bench                 # working tree vs HEAD, 5 interleaved A/B runs. Prints SCORE <n>.
bun run bench:noise           # A/A self-test; SCORE should sit within ~1-2% of 1.0.
bun run climb                 # check + bench; exit 0 = KEEP (SCORE > 1.02), exit 1 = REVERT.

# Rust / GitHub network surface
bun run bench:net             # working tree vs HEAD (--release), 5 interleaved A/B runs. Prints SCORE <n>.
bun run bench:net:noise       # A/A self-test; SCORE should sit within ~1% of 1.0.
bun run climb:net             # cargo test + clippy + bench:net; exit 0 = KEEP, exit 1 = REVERT.

# Both surfaces
bun run climb:all

# Live GitHub calibration sanity check (sparingly — uses real GraphQL quota)
cargo test --manifest-path src-tauri/Cargo.toml -- --ignored live_github --nocapture
```

## Scoring & benchmark-checklist guarantees

- `SCORE` is the weighted geometric mean of `baseline / candidate` ratios (`> 1` is faster).
  - UI weights: `layouts 0.25`, `styleRecalcs 0.20`, `taskMs 0.15`, `maxRenderedRows 0.10`, `longTasks 0.10`, `p95KeyMs 0.10`, `invokes 0.10`.
  - Network weights: `wallMs 0.55`, `requests 0.30`, `kbOut 0.15`.
- Both harnesses print `host: <cores> · <uptime>`, support `--spread` (min–max across runs), run interleaved A/B (`RUNS=5`), and verify that work actually happened with 0 errors (`WORK CHECKS`). Any failure forces `SCORE 0`.
- `PR_REVIEW_GITHUB_API` in `src-tauri/src/lib.rs` is strictly loopback-only (`http://127.0.0.1:` / `http://localhost:`) and uses `PR_REVIEW_GITHUB_TOKEN` when overridden so a real `gh` token is never touched during benchmarks.

## Knobs

- Shared: `BENCH_RUNS` (5), `CLIMB_NOISE` (1.02), `CLIMB_BASE` (`HEAD`).
- UI: `BENCH_PULLS` (400), `BENCH_CPU` (4), `BENCH_MOTION` (0), `PROPERTY_RUNS` (2000), `MODEL_RUNS` (40), `MODEL_STEPS` (30), `MODEL_SEED`.
- Network: `BENCH_NET_SCALE` (`0.1` = 10× compressed wall time with exact GitHub latency ratios; set `1.0` for real-time seconds).

## Contract for agents hill-climbing on this

- Do not edit `bench/`, `src-tauri/examples/net_bench.rs`, or `src/**/*.test.ts` during a climb. They are the contract; changing them to raise the score is cheating.
- Vet noise first (`bench:noise` / `bench:net:noise`) before trusting a small win.
- Keep a change only if the matching `climb` command exits `0` AND the limiter explains the gain. Commit each kept step so the next step benches against it.
- See `.agents/skills/hill-climb/SKILL.md` for the full step-by-step hill-climbing recipe.
