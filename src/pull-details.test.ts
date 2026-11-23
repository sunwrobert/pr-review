import { describe, expect, test } from 'bun:test';
import { diffCacheKey, parsePullDetails } from './pull-details';

describe('parsePullDetails', () => {
  test('parses description, sorted conversation and review threads from one response', () => {
    const raw = JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            bodyHTML: '<p>Summary</p>',
            comments: {
              totalCount: 1,
              nodes: [{ id: 'c1', bodyHTML: '<p>Late</p>', createdAt: '2026-11-20T12:00:00Z', url: 'https://github.com/o/r/pull/1#c1', author: { login: 'alice', avatarUrl: 'https://a', __typename: 'User' } }],
            },
            reviews: {
              totalCount: 2,
              nodes: [
                { id: 'r1', state: 'APPROVED', bodyHTML: '', submittedAt: '2026-11-20T10:00:00Z', url: 'https://github.com/o/r/pull/1#r1', author: { login: 'perry[bot]', avatarUrl: '', __typename: 'Bot' }, comments: { totalCount: 0 } },
                { id: 'r2', state: 'COMMENTED', bodyHTML: '   ', submittedAt: '2026-11-20T11:00:00Z', url: 'https://github.com/o/r/pull/1#r2', author: { login: 'bob', avatarUrl: '', __typename: 'User' }, comments: { totalCount: 0 } },
              ],
            },
            reviewThreads: {
              nodes: [
                {
                  id: 't1',
                  isResolved: false,
                  isOutdated: false,
                  path: 'src/a.ts',
                  line: null,
                  originalLine: 42,
                  viewerCanResolve: true,
                  comments: { totalCount: 1, nodes: [{ id: 'tc1', bodyHTML: '<p>Nit</p>', createdAt: '2026-11-20T10:30:00Z', url: 'https://github.com/o/r/pull/1#tc1', author: null }] },
                },
              ],
            },
          },
        },
      },
    });
    const details = parsePullDetails(raw);
    expect(details.bodyHtml).toBe('<p>Summary</p>');
    expect(details.conversation.map((item) => [item.id, item.isBot])).toEqual([['r1', true], ['c1', false]]);
    expect(details.threads).toHaveLength(1);
    expect(details.threads[0]?.line).toBe(42);
    expect(details.threads[0]?.comments[0]?.author).toBe('ghost');
  });
});

describe('diffCacheKey', () => {
  test('stays stable across comments/edits when headRefOid and baseRefName are unchanged', () => {
    const a = { id: 'p1', headRefOid: 'abc123', baseRefName: 'main', updatedAt: '2026-11-20T10:00:00Z' };
    const b = { ...a, updatedAt: '2026-11-20T12:00:00Z' };
    const pushed = { ...b, headRefOid: 'def456' };
    const retargeted = { ...b, baseRefName: 'dev' };
    expect(diffCacheKey(a)).toBe(diffCacheKey(b));
    expect(diffCacheKey(pushed)).not.toBe(diffCacheKey(a));
    expect(diffCacheKey(retargeted)).not.toBe(diffCacheKey(a));
  });

  test('falls back to updatedAt when headRefOid is absent', () => {
    const a = { id: 'p1', baseRefName: 'main', updatedAt: '2026-11-20T10:00:00Z' };
    const b = { ...a, updatedAt: '2026-11-20T12:00:00Z' };
    expect(diffCacheKey(a)).not.toBe(diffCacheKey(b));
  });
});
