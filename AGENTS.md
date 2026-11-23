# PR Review Agent Guide

Native macOS PR review desktop app built with **Tauri v2** (Rust backend in `src-tauri/src/lib.rs` talking directly to `api.github.com` over pooled HTTP/2 `reqwest`) and a **vanilla TypeScript + Vite** frontend (`src/`, `index.html`, `@pierre/diffs`).

## Verification

Before every push:

```bash
bun run check                                      # tsc, unit + property tests, 40-run Playwright model test
cargo test --manifest-path src-tauri/Cargo.toml    # Rust unit tests
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```

## Performance hill-climbing

All performance work follows `.agents/skills/hill-climb/SKILL.md` and `bench/AGENTS.md`:

- **Frontend UI & IPC:** `bun run climb` (`bun run bench`, `bun run bench:noise`)
- **Rust / GitHub network:** `bun run climb:net` (`bun run bench:net`, `bun run bench:net:noise`)
- **Both surfaces:** `bun run climb:all`

Do not edit `bench/`, `src-tauri/examples/net_bench.rs`, or `src/**/*.test.ts` while climbing.

## Releases

Pushing to `main` triggers `.github/workflows/release.yml` on `macos-15`, which bumps the patch version, signs/builds the app, and publishes a GitHub Release picked up by the in-app updater.
