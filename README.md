# PR Review

A fast, keyboard-first macOS app for reviewing and merging GitHub pull requests. It shows a PR's description, diff and checks, and lets you merge, with nothing else in the way.

![PR Review showing a pull request with its description, conversation and diff](docs/screenshot.png)

<sub>Dummy data. Regenerate with <code>bun run screenshot</code> (<code>--theme=catppuccin-mocha</code>, <code>--width=</code>, <code>--height=</code>, <code>--out=</code>).</sub>

## Features

- **Queue:** review requested, involved, and created by me, with counts.
- **Smart filters:** Ready (green, mergeable, no changes requested), Small (≤150 lines), Recent (48h). The Smart sort ranks by readiness.
- **Jev readiness (optional):** with `OPENROUTER_API_KEY` set, each PR is scored by [Jev](https://openrouter.ai) on review evidence, open concerns, change risk and scope, taken from its description, reviews and comments. Without a key, it falls back to the built-in rules.
- **Diffs:** [`@pierre/diffs`](https://www.npmjs.com/package/@pierre/diffs), virtualized and syntax-highlighted in web workers. Collapsible files and sticky headers.
- **Preview:** `P` opens the preview deployment found in bot comments or the body (for example `pr-123.preview.example.com`, Vercel, Netlify, Cloudflare Pages); the header button is disabled when there is none.
- **Devin:** `D` opens the Devin session linked in the PR body or comments; the header button is disabled when there is none.
- **Paste an order:** copy any text that mentions PRs (a ranked report, a Slack message, a list of `#123` or `/pull/123` links) and press `⌘V` anywhere outside a text box. The list re-sorts to your order, grouped under the headings from your text, with everything else after. A **Pasted** chip shows how many matched; `⌥⌫` or its × goes back to normal.
- **Comments:** long comments are capped with a Show more toggle, so scrolling never gets stuck inside one. `C` opens a comment box on the current PR (drafts are kept per PR); `⌘↵` posts it through `gh`.
- **Layout:** description on the left, diff on the right. Panes resize and hide, and `1`–`3` apply preset proportions.
- **Smart search (Jev):** typing a topic like `frontend` or `billing` also finds PRs that don't contain the word, tagged **Jev** in the list. Literal matches still appear instantly.
- **Smart groups (Jev):** `T` groups related PRs into efforts, such as a run of lib extractions or UI refactors. Groups are ordered by average readiness and each can be collapsed or selected as a whole for bulk merge.
- **Conversation:** PR comments and reviews appear under the description, humans and bots alike (Devin, Perry, GitHub Actions…), with review verdicts highlighted. `⇧B` hides bot comments.
- **Merge queue:** PRs already in a queue show a yellow marker with their position, and queued merges skip the confirmation.
- **Themes:** press `T` for a live-preview picker with 45 themes grouped into Dark (29) and Light (16), or follow macOS. Includes Catppuccin, Tokyo Night, Dracula, One Dark/Light, GitHub (dark, dimmed, light, high contrast), VS Code Dark+/Light+, Nord, Gruvbox, Rosé Pine (main, Moon, Dawn), Solarized, Ayu, Everforest, Kanagawa, Material, Night Owl, Monokai, Poimandres, Synthwave '84, Vitesse, Min and Vesper. Diff syntax colours use the matching editor theme.
- **Bulk actions:** select with `E` / `⇧J` / `⇧R`, then approve or merge in sequence with per-PR error reporting.
- **Keyboard:** Linear-style single keys, VS Code chords, and vim motions. `?` lists every shortcut.

## How it talks to GitHub

All GitHub access goes through your existing [GitHub CLI](https://cli.github.com) login (`gh auth login`). The app never sees or stores a token. The Rust backend exposes a small set of commands that run `gh` with validated arguments.

## Install

```bash
gh repo clone sunwrobert/pr-review /tmp/pr-review-src -- -q && bash /tmp/pr-review-src/scripts/install.sh
```

This downloads the latest signed release into `/Applications`. From then on the app updates itself: it checks GitHub Releases at launch, when focused and every 30 minutes, downloads and installs in the background, and shows an **Update** pill (or `⌘⇧U`) to restart into the new version. Use `--from-source` to build locally instead.

## Releases

Every push to `main` runs `.github/workflows/release.yml` on macOS: typecheck and tests, bump the patch version from the latest `v*` tag (`scripts/release-version.ts`), build a universal (Apple Silicon + Intel) app, sign the update with the updater key, and publish a GitHub Release with `latest.json`. Bump the major or minor in `src-tauri/tauri.conf.json` to start a new line.

One-time setup: add the updater private key as repo secrets `TAURI_SIGNING_PRIVATE_KEY` (contents of `~/.tauri/pr-review.key`) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (empty). The matching public key is in `tauri.conf.json`, so the app only installs updates signed with it. The app is not Apple-notarized; the installer strips the quarantine flag.

## Install from source

One step: builds from source and installs to `/Applications` (re-run to update):

```bash
gh repo clone sunwrobert/pr-review /tmp/pr-review-src -- -q && bash /tmp/pr-review-src/scripts/install.sh
```

From a checkout, `bun run install:app` does the same.

## Requirements

- macOS, [Bun](https://bun.sh), Rust (stable), and Xcode Command Line Tools.
- `gh` authenticated.
- Optional: `OPENROUTER_API_KEY` in your environment or login shell for AI readiness scoring, grouping and the Tested filter.

## Develop

```bash
bun install
bun run tauri dev
```

## Build

```bash
bun run app
open "src-tauri/target/release/bundle/macos/PR Review.app"
```

## Screenshot

```bash
bun run screenshot                     # docs/screenshot.png, dark theme, 2x
bun run screenshot --theme=github-light --out=docs/light.png
```

It builds the frontend against the offline fixture layer in `bench/`, loads a curated demo queue (`bench/demo.ts`), opens the featured PR and captures the window in headless Chromium. No GitHub or Jev calls.

## Test

```bash
bun run test
bun run typecheck
```

## Keys (highlights)

Vim motions work the same in every pane; the modifier picks the pane.

| Motion | List `⌃` | Middle pane `⌥` | Right pane `⌘` |
| --- | --- | --- | --- |
| Half page down / up | `⌃D` / `⌃U` | `⌥D` / `⌥U` | `⌘D` / `⌘U` |
| Page down / up | `⌃F` / `⌃B` | `⌥F` / `⌥B` | — (use `⌘D` / `⌘U`) |
| Line down / up | `⌃E` / `⌃Y` (or `⌃N` / `⌃P`) | `⌥E` / `⌥Y` (or `⌥J` / `⌥K`) | `⌘E` / `⌘Y` |
| Top / bottom | `⌃G` / `⌃⇧G` | `⌥G` / `⌥⇧G` | `⌘G` / `⌘⇧G` |

`⌘J` / `⌘K` scroll the diff; `/` focuses the filter. The middle pane is the description and the right pane is the diff.

| Area | Keys |
| --- | --- |
| Queue | `J`/`K` next/prev · `gg`/`G` first/last · `Space`/`⇧Space` page the middle pane |
| Files | `N` or `]c`/`[c` next/prev file · `X` collapse · `S` split/unified |
| Filters | `⇧T` group related work · `⌥1` Ready · `⌥4` Unready · `⌥0` All (Small `⌥2`, Recent `⌥3`, Tested `⌥5`) · `⇧S` sort · `⇧X` fix with agent · `⇧U` select unready · `⇧R` select ready |
| Select | `⇧V` visual mode (then `J`/`K`) · `E` toggle · `⇧J`/`⇧K` extend · `⇧R` all ready · `⇧U` all unready · `⌘A` all · `⌫` or `Esc` clear |
| Act | `⇧X` copy an agent prompt to fix every PR with conflicts or failing checks (or just the selected ones) · `O` open on GitHub (in Chrome) · `A` approve · `⌘↵` merge (all selected when several are checked) · `⇧A` bulk approve · `⌘↵` bulk merge |
| Layout | `T` theme picker · `⌘B` PR list · `1` review · `2` diff focus · `3` read description · `⌘.` focus |
| Lightbox | `I` open first media · `H`/`L` or `J`/`K` or `←`/`→` cycle · `gg`/`G` first/last · `⌃D`/`⌃U` skip half · `Z` zoom · `O` open · `Q`/`Esc` close |
| General | `/` filter PRs · `⌘F` find in this PR (`↵`/`⇧↵` next/prev) · `?` shortcuts · `R` refresh |

## Credits

UI icons are [Lucide](https://lucide.dev) (ISC), vendored in `src/icons.ts` so nothing is fetched at runtime. The Devin mark is traced from its GitHub app avatar.

## License

MIT
