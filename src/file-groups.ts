// File grouping for the grouped review, ported from pulls.review (MIT, https://github.com/antfu/pulls.review):
// the rule table and order from packages/core/src/analyze/adapters/rule-based/rules.ts and the LLM grouping
// principles from packages/core/src/analyze/adapters/llm/prompt.ts.

export type FileCategory = 'ui' | 'api' | 'core' | 'data' | 'cli' | 'security' | 'tests' | 'docs' | 'examples' | 'deps' | 'build' | 'scripts' | 'config' | 'i18n' | 'assets' | 'other';

export interface FileGroup {
  key: string;
  label: string;
  summary: string;
  category: FileCategory;
  /** Set only when the whole group deserves extra reviewer care. */
  isCritical: boolean;
  paths: string[];
}

export interface FileGrouping {
  source: 'rules' | 'ai';
  overallSummary: string | null;
  groups: FileGroup[];
}

/** Minimal file facts the grouping needs, independent of the diff renderer. */
export interface GroupableFile {
  path: string;
  additions: number;
  deletions: number;
  isBinary: boolean;
}

interface Rule {
  key: string;
  label: string;
  summary: string;
  category: FileCategory;
  patterns: readonly string[];
}

/** Lockfiles and build output: never worth reading line by line. */
export const GENERATED_PATTERNS = ['**/*.generated.*', '**/pnpm-lock.yaml', '**/yarn.lock', '**/package-lock.json', '**/bun.lock', '**/bun.lockb', '**/Cargo.lock', '**/go.sum', '**/dist/**', '**/*.lock', '**/drizzle/meta/**'];

/** Tests and what only exists to support them. Shared by the Tests group and the Hide tests toggle. */
export const TEST_PATTERNS = ['**/*.test.*', '**/*.spec.*', '**/*_test.*', '**/test_*.py', '**/*.stories.*', '**/*.snap', '**/__tests__/**', '**/__snapshots__/**', '**/__fixtures__/**', '**/test/**', '**/tests/**', '**/e2e/**', '**/fixtures/**'];

const CODE_RULE: Rule = { key: 'code', label: 'Code', summary: 'Source changes.', category: 'core', patterns: [] };
const OTHER_RULE: Rule = { key: 'other', label: 'Other', summary: "Changes that don't fit another group.", category: 'other', patterns: [] };

/** First match wins; the order is also the group order. Docs and tests come before the config/generated catch-alls. */
const RULES: readonly Rule[] = [
  { key: 'docs', label: 'Docs', summary: 'Documentation updates.', category: 'docs', patterns: ['**/*.md', '**/*.mdx', '**/*.mdc', '**/docs/**', '**/README*'] },
  CODE_RULE,
  { key: 'tests', label: 'Tests', summary: 'Test coverage for the change.', category: 'tests', patterns: TEST_PATTERNS },
  { key: 'config', label: 'Config', summary: 'Configuration changes.', category: 'config', patterns: ['*.config.*', '**/*.config.*', '.*rc', '.*rc.*', '.github/**', '.git*', '**/tsconfig*.json', '**/Dockerfile', '**/docker-compose*.y*ml', '**/.dockerignore', '**/Makefile'] },
  { key: 'deps', label: 'Dependencies', summary: 'Dependency version changes.', category: 'deps', patterns: ['**/package.json', '**/pnpm-workspace.yaml', '**/Cargo.toml', '**/go.mod'] },
  { key: 'generated', label: 'Generated', summary: 'Generated or build output changes.', category: 'other', patterns: GENERATED_PATTERNS },
  OTHER_RULE,
];

/** Compiles the glob subset the rules use: `**`, `*`, literal characters. A leading `** /` also matches the repo root. */
function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let index = 0; index < glob.length; index++) {
    const character = glob[index] ?? '';
    if (glob.startsWith('**/', index)) {
      source += '(?:.*/)?';
      index += 2;
    } else if (glob.startsWith('/**', index) && index + 3 === glob.length) {
      source += '/.*';
      index += 2;
    } else if (character === '*') source += '[^/]*';
    else source += character.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

const compiled = new Map<readonly string[], RegExp[]>();

export function matchesAny(path: string, patterns: readonly string[]): boolean {
  let regexps = compiled.get(patterns);
  if (regexps == null) {
    regexps = patterns.map(globToRegExp);
    compiled.set(patterns, regexps);
  }
  return regexps.some((regexp) => regexp.test(path));
}

export function isTestPath(path: string): boolean {
  return matchesAny(path, TEST_PATTERNS);
}

export function isGeneratedPath(path: string): boolean {
  return matchesAny(path, GENERATED_PATTERNS);
}

function ruleFor(file: GroupableFile): Rule {
  if (file.isBinary) return OTHER_RULE;
  return RULES.find((rule) => rule.patterns.length > 0 && matchesAny(file.path, rule.patterns)) ?? CODE_RULE;
}

/** Deterministic grouping by path, used instantly and whenever AI grouping is off or fails. */
export function groupByRules(files: readonly GroupableFile[]): FileGrouping {
  const byRule = new Map<Rule, string[]>();
  files.forEach((file) => {
    const rule = ruleFor(file);
    byRule.set(rule, [...(byRule.get(rule) ?? []), file.path]);
  });
  const groups = RULES.flatMap((rule) => {
    const paths = byRule.get(rule);
    return paths == null ? [] : [{ key: rule.key, label: rule.label, summary: rule.summary, category: rule.category, isCritical: false, paths }];
  });
  return { source: 'rules', overallSummary: null, groups };
}

/**
 * Reconciles a grouping with the files actually in the diff: unknown paths are dropped, duplicates keep their
 * first group, and anything no group names lands in a trailing "Uncategorized" group so no file is ever hidden.
 */
export function reconcileGrouping(grouping: FileGrouping, files: readonly GroupableFile[]): FileGrouping {
  const known = new Set(files.map((file) => file.path));
  const seen = new Set<string>();
  const groups = grouping.groups
    .map((group) => ({ ...group, paths: group.paths.filter((path) => known.has(path) && !seen.has(path) && seen.add(path) != null) }))
    .filter((group) => group.paths.length > 0);
  const leftover = files.map((file) => file.path).filter((path) => !seen.has(path));
  if (leftover.length > 0) groups.push({ key: 'uncategorized', label: 'Uncategorized', summary: 'Files not covered by the grouping.', category: 'other', isCritical: false, paths: leftover });
  return { ...grouping, groups };
}

const CATEGORIES: readonly FileCategory[] = ['ui', 'api', 'core', 'data', 'cli', 'security', 'tests', 'docs', 'examples', 'deps', 'build', 'scripts', 'config', 'i18n', 'assets', 'other'];

export const GROUPING_SYSTEM_PROMPT = `You organize a GitHub pull request's changed files into review groups, so a reviewer can read the PR feature by feature instead of file by file.

Grouping principles:
- Group by intent, not by directory. One feature touching several modules is ONE group.
- Use the fewest groups that still separate independent intents. A typical PR has 1-5 groups.
- Split a group that would hold most of the PR's non-test files into the parts a reviewer reads in order (for example the new helper, then the code that adopts it), unless the PR is genuinely one small change.
- Tests, stories and fixtures usually go in a group of their own, separate from the code they cover.
- Order groups by review priority: the core change first, supporting changes next, mechanical changes (lockfiles, generated files, formatting) last.
- Every path in the manifest goes into exactly one group.

Output:
- "summary" and "overallSummary" explain why over what, in 1-3 sentences of Markdown.
- "key" is short, stable kebab-case. "label" is at most 4 words.
- "critical" is only for a group that deserves extra reviewer care (security, data loss, hard to revert); most groups are not critical.
- "category" is which part of the system the group touches: ui, api, core, data, cli, security, tests, docs, examples, deps, build, scripts, config, i18n, assets or other.`;

/** JSON schema for OpenRouter structured output; mirrors pulls.review's submit_grouping tool without nesting or notes. */
export const GROUPING_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['overallSummary', 'groups'],
  properties: {
    overallSummary: { type: 'string' },
    groups: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'label', 'summary', 'category', 'critical', 'filePaths'],
        properties: {
          key: { type: 'string' },
          label: { type: 'string' },
          summary: { type: 'string' },
          category: { type: 'string', enum: CATEGORIES },
          critical: { type: 'boolean' },
          filePaths: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
} as const;

/** Hunk text per file for the prompt. Generated and binary files are listed without a body to save tokens. */
export interface PromptFile extends GroupableFile {
  patch: string;
}

const PATCH_CHAR_LIMIT = 120_000;
const FILE_PATCH_CHAR_LIMIT = 8_000;

export function buildGroupingPrompt(title: string, description: string, files: readonly PromptFile[]): string {
  const added = files.reduce((sum, file) => sum + file.additions, 0);
  const deleted = files.reduce((sum, file) => sum + file.deletions, 0);
  const manifest = files.map((file) => `${file.path}  +${file.additions}/-${file.deletions}${isGeneratedPath(file.path) ? '  [generated]' : file.isBinary ? '  [binary]' : ''}`).join('\n');
  let budget = PATCH_CHAR_LIMIT;
  const patches = files.flatMap((file) => {
    if (file.isBinary || isGeneratedPath(file.path) || budget <= 0) return [];
    const body = file.patch.length > FILE_PATCH_CHAR_LIMIT ? `${file.patch.slice(0, FILE_PATCH_CHAR_LIMIT)}\n… (truncated)` : file.patch;
    budget -= body.length;
    return [`### ${file.path}\n${body}`];
  });
  return [
    `PR title: ${title}`,
    description.trim() === '' ? '' : `---DESCRIPTION---\n${description.slice(0, 6_000)}`,
    `---MANIFEST--- (${files.length} files, +${added}/-${deleted})\n${manifest}`,
    patches.length === 0 ? '' : `---DIFFS---${budget <= 0 ? ' (partial; the rest were cut for length, group them from their paths)' : ''}\n${patches.join('\n\n')}`,
  ].filter((part) => part !== '').join('\n\n');
}

interface RawGroup {
  key?: unknown;
  label?: unknown;
  summary?: unknown;
  category?: unknown;
  critical?: unknown;
  filePaths?: unknown;
}

/** Validates the model's JSON; anything malformed is rejected so the caller falls back to rules. */
export function parseGroupingResponse(text: string): FileGrouping {
  const parsed = JSON.parse(text) as { overallSummary?: unknown; groups?: unknown };
  if (!Array.isArray(parsed.groups)) throw new Error('grouping response has no groups');
  const groups = (parsed.groups as RawGroup[]).map((group, index) => {
    if (typeof group.label !== 'string' || !Array.isArray(group.filePaths)) throw new Error(`group ${index} is malformed`);
    const category = CATEGORIES.includes(group.category as FileCategory) ? (group.category as FileCategory) : 'other';
    return {
      key: typeof group.key === 'string' && group.key !== '' ? group.key : `group-${index}`,
      label: group.label,
      summary: typeof group.summary === 'string' ? group.summary : '',
      category,
      isCritical: group.critical === true,
      paths: group.filePaths.filter((path): path is string => typeof path === 'string'),
    };
  });
  return { source: 'ai', overallSummary: typeof parsed.overallSummary === 'string' ? parsed.overallSummary : null, groups };
}
