#!/usr/bin/env bash
# One Rust/GitHub network hill-climbing step: gate on Rust + TS checks, then compare --release binaries A/B.
# Exit 0 = keep (score beat baseline by more than the noise floor), 1 = revert.
set -euo pipefail
cd "$(dirname "$0")/.."
NOISE="${CLIMB_NOISE:-1.02}"
if ! (cargo test --manifest-path src-tauri/Cargo.toml && cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings) > .bench-net-check.log 2>&1; then
  tail -25 .bench-net-check.log
  echo "SCORE 0 (rust check failed)"
  exit 1
fi
SCORE=$(bun bench/net.ts --against "${CLIMB_BASE:-HEAD}" --spread | tee /dev/stderr | awk '/^SCORE/ {print $2}')
if awk -v score="$SCORE" -v noise="$NOISE" 'BEGIN { exit !(score > noise) }'; then
  echo "KEEP score=$SCORE > $NOISE"
  exit 0
fi
echo "REVERT score=$SCORE <= $NOISE"
exit 1
