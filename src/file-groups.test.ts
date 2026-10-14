import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { buildGroupingPrompt, groupByRules, isTestPath, parseGroupingResponse, reconcileGrouping, type GroupableFile } from './file-groups';

const file = (path: string, isBinary = false): GroupableFile => ({ path, additions: 3, deletions: 1, isBinary });

describe('rule grouping (ported from pulls.review)', () => {
  test('sorts files into docs, code, tests, config, deps and generated in that order', () => {
    const grouping = groupByRules(['README.md', 'src/app.ts', 'src/app.test.ts', 'vite.config.ts', 'package.json', 'bun.lock', 'logo.png'].map((path) => file(path, path.endsWith('.png'))));
    expect(grouping.groups.map((group) => [group.key, group.paths])).toEqual([
      ['docs', ['README.md']],
      ['code', ['src/app.ts']],
      ['tests', ['src/app.test.ts']],
      ['config', ['vite.config.ts']],
      ['deps', ['package.json']],
      ['generated', ['bun.lock']],
      ['other', ['logo.png']],
    ]);
  });

  test('first match wins: a markdown file under .github is docs, a workflow is config', () => {
    const grouping = groupByRules([file('.github/CONTRIBUTING.md'), file('.github/workflows/ci.yml')]);
    expect(grouping.groups.map((group) => group.key)).toEqual(['docs', 'config']);
  });

  test('test detection covers specs, stories, snapshots, fixtures and test folders at any depth', () => {
    ['a.test.ts', 'pkg/a.spec.tsx', 'x_test.go', 'test_x.py', 'B.stories.tsx', 'a/__snapshots__/b.snap', 'tests/e2e/login.ts', 'e2e/flow.ts', 'pkg/test/util.ts', 'fixtures/one.json'].forEach((path) => expect(isTestPath(path)).toBe(true));
    ['src/testing-utils.ts', 'src/contest.ts', 'latest.ts', 'docs/testimonials.md'].forEach((path) => expect(isTestPath(path)).toBe(false));
  });
});

describe('reconcileGrouping', () => {
  test('drops unknown paths, keeps the first copy of a duplicate, and collects leftovers', () => {
    const files = [file('a.ts'), file('b.ts'), file('c.ts')];
    const grouping = reconcileGrouping({ source: 'ai', overallSummary: null, groups: [
      { key: 'one', label: 'One', summary: '', category: 'core', isCritical: false, paths: ['a.ts', 'ghost.ts'] },
      { key: 'two', label: 'Two', summary: '', category: 'core', isCritical: false, paths: ['a.ts', 'b.ts'] },
      { key: 'empty', label: 'Empty', summary: '', category: 'core', isCritical: false, paths: ['ghost.ts'] },
    ] }, files);
    expect(grouping.groups.map((group) => [group.key, group.paths])).toEqual([['one', ['a.ts']], ['two', ['b.ts']], ['uncategorized', ['c.ts']]]);
  });

  test('property: every file appears in exactly one group, whatever the model returns', () => {
    const paths = fc.uniqueArray(fc.stringMatching(/^[a-z]{1,6}(\/[a-z]{1,6}){0,2}\.(ts|md|json)$/), { minLength: 1, maxLength: 25 });
    fc.assert(fc.property(paths, fc.array(fc.array(fc.nat(30), { maxLength: 8 }), { maxLength: 6 }), (names, picks) => {
      const files = names.map((name) => file(name));
      const groups = picks.map((pick, index) => ({ key: `g${index}`, label: `G${index}`, summary: '', category: 'core' as const, isCritical: false, paths: pick.map((n) => names[n % (names.length + 3)] ?? 'nope.ts') }));
      const result = reconcileGrouping({ source: 'ai', overallSummary: null, groups }, files);
      expect(result.groups.flatMap((group) => group.paths).sort()).toEqual([...names].sort());
      expect(result.groups.every((group) => group.paths.length > 0)).toBe(true);
    }), { numRuns: 500 });
  });
});

describe('AI grouping response', () => {
  test('parses a valid structured response and maps unknown categories to other', () => {
    const grouping = parseGroupingResponse(JSON.stringify({ overallSummary: 'Adds a cache.', groups: [{ key: 'cache', label: 'Cache', summary: 'Why.', category: 'core', critical: true, filePaths: ['a.ts'] }, { key: 'x', label: 'X', summary: '', category: 'weird', critical: false, filePaths: ['b.ts', 7] }] }));
    expect(grouping).toMatchObject({ source: 'ai', overallSummary: 'Adds a cache.', groups: [{ key: 'cache', isCritical: true, paths: ['a.ts'] }, { category: 'other', paths: ['b.ts'] }] });
  });

  test('rejects responses without groups so the caller falls back to rules', () => {
    expect(() => parseGroupingResponse('{"overallSummary":"x"}')).toThrow();
    expect(() => parseGroupingResponse('{"groups":[{"filePaths":[]}]}')).toThrow();
  });

  test('the prompt lists every file, skips generated diffs and stays bounded', () => {
    const files = [{ ...file('src/a.ts'), patch: '@@ -1 +1 @@\n-a\n+b' }, { ...file('bun.lock'), patch: 'x'.repeat(50_000) }, ...Array.from({ length: 40 }, (_, index) => ({ ...file(`src/big${index}.ts`), patch: 'y'.repeat(20_000) }))];
    const prompt = buildGroupingPrompt('Title', 'Body', files);
    files.forEach((entry) => expect(prompt).toContain(entry.path));
    expect(prompt).toContain('bun.lock  +3/-1  [generated]');
    expect(prompt).not.toContain('x'.repeat(100));
    expect(prompt.length).toBeLessThan(140_000);
  });
});
