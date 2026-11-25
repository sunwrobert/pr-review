// Shared benchmark fixtures: the single source of truth for both harnesses.
//
// generatePulls / generateDiff / FIXTURE_NOW are verbatim TypeScript ports of
// bench/fixtures.ts in the repository root (the Rust app's own benchmark
// fixtures), so the queue and the ordinary diffs are byte-identical across
// both apps. The huge-diff fixture (HUGE_PR_NUMBER) is layered on top by both
// harnesses: the Exact app's data module and the benchmark's copy of the Rust
// app's tauri shim both return hugePatch() for that one pull.

export interface FixturePull {
  id: string;
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  headRefName: string;
  baseRefName: string;
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  mergeQueueEntry: { position: number; state: string } | null;
  author: { login: string; avatarUrl: string };
  repository: { nameWithOwner: string };
  commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
}

export const FIXTURE_NOW = Date.parse('2026-09-26T12:00:00Z');

function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(value ^ (value >>> 15), 1 | value);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const WORDS = ['refactor', 'feat', 'fix', 'perf', 'test', 'chore', 'share', 'router', 'filter', 'accordion', 'cache', 'billing', 'models', 'sidebar', 'trust-score', 'merge', 'queue', 'i18n', 'dialog', 'icons'];

export function generatePulls(count: number, seed = 42): FixturePull[] {
  const random = mulberry32(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  return Array.from({ length: count }, (_, index) => {
    const number = 40_000 + index;
    const repo = pick(['o/web', 'o/web', 'o/web', 'o/api', 'o/plugins']);
    const title = `${pick(WORDS)}(${pick(WORDS)}): ${Array.from({ length: 4 + Math.floor(random() * 6) }, () => pick(WORDS)).join(' ')}`;
    return {
      id: `PR_${seed}_${index}`,
      number,
      title,
      url: `https://github.com/${repo}/pull/${number}`,
      isDraft: random() < 0.05,
      createdAt: new Date(FIXTURE_NOW - Math.floor(random() * 30 * 86_400_000)).toISOString(),
      updatedAt: new Date(FIXTURE_NOW - Math.floor(random() * 5 * 86_400_000)).toISOString(),
      additions: Math.floor(random() ** 3 * 3_000),
      deletions: Math.floor(random() ** 3 * 800),
      changedFiles: 1 + Math.floor(random() * 30),
      headRefName: `branch-${number}`,
      baseRefName: 'main',
      reviewDecision: pick(['APPROVED', 'APPROVED', 'REVIEW_REQUIRED', 'CHANGES_REQUESTED', null] as const),
      mergeQueueEntry: random() < 0.08 ? { position: Math.floor(random() * 6), state: 'QUEUED' } : null,
      author: { login: 'author', avatarUrl: '' },
      repository: { nameWithOwner: repo },
      commits: { nodes: [{ commit: { statusCheckRollup: { state: pick(['SUCCESS', 'SUCCESS', 'SUCCESS', 'FAILURE', 'PENDING']) } } }] },
    };
  });
}

export function generateDiff(pull: FixturePull, seed = 7): string {
  const random = mulberry32(seed + pull.number);
  const files = Math.max(1, Math.min(pull.changedFiles, 24));
  return Array.from({ length: files }, (_, fileIndex) => {
    const path = `src/module-${fileIndex}/file-${pull.number}-${fileIndex}.ts`;
    const lines = 10 + Math.floor(random() * 120);
    const body = Array.from({ length: lines }, (_, line) => {
      const roll = random();
      const code = `  const value${line} = compute(${line}, '${WORDS[line % WORDS.length]}');`;
      return roll < 0.2 ? `+${code}` : roll < 0.3 ? `-${code}` : ` ${code}`;
    });
    const added = body.filter((line) => line.startsWith('+')).length;
    const removed = body.filter((line) => line.startsWith('-')).length;
    const context = body.length - added - removed;
    return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,${context + removed} +1,${context + added} @@\n${body.join('\n')}\n`;
  }).join('');
}

export function generateBodyMarkdown(pull: FixturePull): string {
  const paragraph = `${pull.title}. `.repeat(8);
  return [
    `## Summary\n\n${paragraph}`,
    `## What changed?\n\n${Array.from({ length: 6 }, (_, index) => `- \`src/file-${index}.ts\` ${paragraph}`).join('\n')}`,
    `## How to test\n\n${paragraph}`,
    `\`\`\`\n${'bun run test\n'.repeat(6)}\`\`\``,
  ].join('\n\n');
}

// The huge-diff fixture. One pull in every queue (HUGE_PR_NUMBER) carries a
// patch far bigger than the ordinary generated ones: a shape real large PRs
// have — many small files, a few big hand-written ones, a generated lockfile
// and a snapshot. Both harnesses serve byte-identical text for it.
export const HUGE_PR_NUMBER = 40_010;

function hugeFileLines(random: () => number, count: number, prefix: string): string[] {
  return Array.from({ length: count }, (_, line) => {
    const roll = random();
    const code = `  const ${prefix}${line} = compute(${line}, '${WORDS[line % WORDS.length]}');`;
    return roll < 0.45 ? `+${code}` : roll < 0.55 ? `-${code}` : ` ${code}`;
  });
}

function patchFile(path: string, body: string[], renameFrom?: string): string {
  const added = body.filter((line) => line.startsWith('+')).length;
  const removed = body.filter((line) => line.startsWith('-')).length;
  const context = body.length - added - removed;
  // One file, one hunk for simplicity of generation; parsers treat it as a
  // normal unified patch. Large real files have many hunks, which only makes
  // parsing cheaper per line, so this is the conservative shape.
  const rename = renameFrom == null ? '' : `rename from ${renameFrom}\nrename to ${path}\n`;
  return `diff --git a/${renameFrom ?? path} b/${path}\n${rename}--- a/${renameFrom ?? path}\n+++ b/${path}\n@@ -1,${context + removed} +1,${context + added} @@\n${body.join('\n')}\n`;
}

export function hugePatch(seed = 11): string {
  const random = mulberry32(seed);
  const parts: string[] = [];
  // 140 ordinary small files, like the bulk of a large refactor.
  for (let index = 0; index < 140; index += 1) {
    const lines = 20 + Math.floor(random() * 120);
    parts.push(patchFile(`src/huge/module-${index % 12}/part-${index}.ts`, hugeFileLines(random, lines, `small${index}_`)));
  }
  // 6 large hand-written files, 1,800–5,500 lines each.
  for (let index = 0; index < 6; index += 1) {
    const lines = 1_800 + Math.floor(random() * 3_700);
    parts.push(patchFile(`src/huge/core/big-${index}.ts`, hugeFileLines(random, lines, `big${index}_`)));
  }
  // A generated lockfile and a snapshot: the files an honest reviewer collapses.
  parts.push(patchFile('bun.lock', hugeFileLines(random, 8_000, 'lock')));
  parts.push(patchFile('src/huge/__snapshots__/big.snap', hugeFileLines(random, 3_000, 'snap')));
  // One renamed file.
  parts.push(patchFile('src/huge/renamed-new.ts', hugeFileLines(random, 90, 'ren'), 'src/huge/renamed-old.ts'));
  return parts.join('');
}

/** The patch one fixture pull carries: the huge patch for HUGE_PR_NUMBER, the ordinary generated one otherwise. */
export function fixtureDiff(pull: FixturePull): string {
  return pull.number === HUGE_PR_NUMBER ? hugePatch() : generateDiff(pull);
}
