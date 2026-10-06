# Perf lever

One loop, three commands. Everything runs offline against generated fixtures; nothing calls GitHub or Jev.

## Commands

```bash
bun run check            # gate: tsc, unit + property tests, model-based UI test. Must print CHECK OK.
bun run bench            # working tree vs HEAD, interleaved A/B in headless Chromium. Last line: SCORE <n>.
bun run climb            # check, then bench; exit 0 = keep (SCORE > 1.02), exit 1 = revert.
bun run bench:noise      # A/A self-test; SCORE should sit within ~1% of 1.0.
```

`SCORE` is the weighted geometric mean of baseline/candidate ratios across scenarios, so `> 1` is faster. Weights favour deterministic browser counters (layouts, style recalcs, rendered rows, long tasks) over timings, which drift a few percent run to run.

Each scenario also checks that its work happened (selection moved, filter holds the typed text, picker opened, diff scrolled, `r` refetched, no dialog left open, no page errors). Any failure prints under `WORK CHECKS` and forces `SCORE 0`. A run that hangs past 60s is relaunched (up to twice) and reported as `RETRIES`; a key whose frame never arrives within 5s is left out of p95 and reported as `FRAME STALLS`. Pass `--spread` to print each scenario's min–max range per side, so you can tell a real gap from run-to-run noise.

Chromium runs with `prefers-reduced-motion: reduce`, so intentional animation frames are not scored as work; set `BENCH_MOTION=1` to include them. Knobs: `BENCH_RUNS` (default 5), `BENCH_PULLS` (400), `BENCH_CPU` (4× throttle), `CLIMB_NOISE` (1.02), `CLIMB_BASE` (HEAD), `PROPERTY_RUNS` (2000), `MODEL_RUNS` (40), `MODEL_STEPS` (30), `MODEL_SEED` to replay a failure.

## Contract for agents hill-climbing on this

- Do not edit `bench/` or `src/**/*.test.ts` while climbing. They are the contract; changing them to raise the score is cheating.
- A change is kept only if `bun run climb` exits 0. Commit each kept step so the next step benches against it.
- `check` failing means SCORE 0, regardless of speed.
- If the model test fails, it prints a shrunk counterexample (a short key sequence) and a seed; reproduce with `MODEL_SEED=<seed> bun run model`.

## Layout

- `fixtures.ts`: seeded PR, diff and body generators.
- `shim/`: replaces `@tauri-apps/api` so the real frontend runs in a browser against fixtures.
- `vite.config.ts`: harness build, enables the `window.__prReview.snapshot()` hook.
- `run.ts`: scenarios and scoring. `model.ts`: fast-check model-based test driving real keystrokes.
- `src/status.property.test.ts`: fast-check invariants on status, attention, sorting and filters.
