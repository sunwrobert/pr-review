# Getting the Rust PR-review app onto Android with zero performance loss

Options only. No code here; nothing in this document changes the existing app.
The app today is a Tauri v2 shell on macOS: a Rust core (`src-tauri/src/lib.rs`)
holding the GitHub client (pooled HTTP/2 `reqwest`, caching, diff assembly) and
driving a vanilla TypeScript + Vite frontend (`src/`, `@pierre/diffs` for the
virtualized diff rendering) inside a WKWebView.

"Zero performance loss" means: cold start, scroll frame times, interaction
latency, memory footprint, and diff rendering throughput on Android match the
macOS app's numbers in `BENCH.md`, for the same fixture PRs including the huge
diff. Two honest ways to get there, with the tradeoffs.

## Option A — Native Rust UI build

Drop the webview entirely. Rewrite the presentation layer as a native Android
UI driven directly from Rust: the Rust core keeps the GitHub client and diff
model exactly as they are, and the screen is rendered by a Rust UI toolkit
(e.g. a slime/egui-style immediate-mode renderer, or a custom Skia/impeller
surface) compiled into the app as native code. No JavaScript, no webview, no
Kotlin UI layer.

**Upside**

- One language end to end; the diff parser, cache, and list model are the same
  code that ships today, so behavior parity is free and stays free.
- No webview tax: no WKWebView-equivalent (Android System WebView) startup
  cost, no JS engine warmup, no IPC bridge serialization. Cold start is a
  process spawn plus a measure/layout pass.
- Memory floor is lowest of the two options; predictable under the huge diff
  because layout/virtualization memory is native and explicitly owned.
- The existing benchmark discipline (`bench/`) transfers: the measurement
  harness can target the same scenarios natively.

**Downside**

- The entire frontend must be reimplemented. Every screen, keyboard shortcut,
  text layout edge case, theme, and accessibility behavior in `src/` today is
  new Rust code. This is the bulk of the cost and it is a rewrite, not a port.
- Rust UI ecosystems on Android are immature compared to Compose: text
  shaping, IME/input handling, accessibility (TalkBack), clipboard, drag, and
  per-device behavior differences are largely build-it-yourself. The risk is
  not raw speed — it is the long tail of platform correctness.
- `@pierre/diffs` does not exist in Rust. Diff rendering with equivalent
  virtualization quality and syntax highlighting must be rebuilt; syntax
  highlighting in particular is a large, easy-to-underestimate component.
- Team velocity: every future UI change is a Rust change, with Rust compile
  times in the loop.

## Option B — Rust core + thin Kotlin/Compose shell

Keep Rust where it is strongest and write the shell in the platform's own UI
toolkit. `src-tauri`'s logic minus Tauri becomes a Rust library compiled as a
CDylib for `aarch64-linux-android` (and `x86_64` for emulators); the Android
app is a small Kotlin/Compose app that owns rendering and input and calls the
Rust core over JNI or uniffi-generated bindings. There is no webview: Compose
renders the PR list, the markdown body, and the diff rows natively.

**Upside**

- Compose is the native, first-party UI stack: text, input, accessibility,
  theming, windowing, and edge cases (foldables, predictive back, per-device
  WebView-free behavior) come from the platform. Least platform-correctness
  risk of the two options.
- Performance parity is achievable because the heavy work stays in Rust:
  parsing 2 MB patches, caching, and list modeling never touch the JVM.
  Compose `LazyColumn` is a competent virtualized list; with stable keys and
  precomputed row models handed over from Rust, scroll frame times can match
  the desktop app's.
- The Kotlin shell is small and cheap to iterate on; the expensive logic stays
  shared with the macOS app verbatim, so both platforms improve together.
- JNI bridge cost is per-call and tiny relative to the payloads (a handful of
  structured objects per screen), provided the interface is coarse-grained:
  "give me the shaped diff window for file N", not per-line calls.

**Downside**

- Two languages, two build systems (Cargo + Gradle), and a binding layer to
  maintain (uniffi or hand-written JNI). Type drift between Rust structs and
  Kotlin models is a permanent small tax.
- The frontend logic in `src/` (state machines, keyboard map, grouping) must
  be ported to Kotlin. It is a port, not a rewrite — but it is real work and
  it must be kept in sync thereafter, or factored so the shared logic moves
  into the Rust core.
- Rust-in-APK packaging details matter: per-ABI `.so` size, 16 KB page-size
  alignment for the native libraries, NDK version pinning, and deterministic
  release signing all belong to the shell's build.
- Cross-language debugging is slower: a janky frame may live in either world.

## What both options share

- The Rust GitHub core is reused unchanged in both; neither option risks the
  network/cache layer's performance.
- The webview is gone in both. Keeping a webview (Tauri-on-Android style) is
  the only approach that avoids a UI rewrite, but Android System WebView
  startup plus a full JS engine under a 60/120 Hz scroll budget is precisely
  where the performance loss would come from, so it is excluded by the
  premise.
- Diff virtualization quality is the deciding engineering risk in both: in A
  it must be built in Rust; in B it must be built in Compose. Either way,
  measuring against the huge-diff fixture (`BENCH.md`) is the acceptance test.

## Summary

| | A: native Rust UI | B: Rust core + Compose shell |
|---|---|---|
| Frontend rewrite | full, in Rust | partial port, in Kotlin |
| Platform correctness risk | high (IME, a11y, text by hand) | low (first-party toolkit) |
| Cold start / memory floor | best possible | near-best; small JNI + Compose cost |
| Long-term maintenance | one language, Rust-only UI ecosystem risk | two languages, mainstream tooling |
| Syntax highlighting | rebuild in Rust | rebuild in Kotlin (or reuse a Java highlighter) |
| Shared GitHub/diff core | unchanged | unchanged |

Option B is the lower-risk path to zero performance loss: it spends the
rewrite budget only on the UI layer, keeps the platform's correctness
guarantees, and preserves the benchmarked Rust core byte-for-byte. Option A is
the purist path: it can edge out B on cold start and memory, at the price of
rebuilding large amounts of platform behavior that Compose already ships.
