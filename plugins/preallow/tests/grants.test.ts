import { describe, expect, test } from 'claude-code/testing';
import type { Grant } from '../types';
import { covers, parseGrants } from '../hooks/grants.ts';
import { repoFromUrl } from '../hooks/resolve.ts';

const base: Grant = {
  id: '1.0',
  class: 'push',
  repo: 'github.com/o/r',
  isBranchUserNamed: false,
  isOneShot: true,
  namedBy: 'user',
  quote: 'push',
  prompt: 1,
};

describe('covers', () => {
  const cases: Array<[string, Partial<Grant>, Parameters<typeof covers>[1], boolean]> = [
    ['push grant, same repo', {}, { class: 'push', repo: 'github.com/o/r', branch: 'x' }, true],
    [
      'push grant, other repo',
      {},
      { class: 'push', repo: 'github.com/o/other', branch: 'x' },
      false,
    ],
    ['push grant, unresolved repo', {}, { class: 'push', branch: 'x' }, false],
    [
      'push grant does not cover force push',
      {},
      { class: 'force_push', repo: 'github.com/o/r', branch: 'x', isDefaultBranch: false },
      false,
    ],
    [
      'force grant covers push',
      { class: 'force_push' },
      { class: 'push', repo: 'github.com/o/r', branch: 'x' },
      true,
    ],
    [
      'force grant, feature branch',
      { class: 'force_push' },
      { class: 'force_push', repo: 'github.com/o/r', branch: 'x', isDefaultBranch: false },
      true,
    ],
    [
      'force grant, default branch unnamed',
      { class: 'force_push' },
      { class: 'force_push', repo: 'github.com/o/r', branch: 'main', isDefaultBranch: true },
      false,
    ],
    [
      'force grant, default branch named by the user',
      { class: 'force_push', branch: 'main', isBranchUserNamed: true },
      { class: 'force_push', repo: 'github.com/o/r', branch: 'main', isDefaultBranch: true },
      true,
    ],
    [
      'force grant, default branch filled in from the proposal',
      { class: 'force_push', branch: 'main' },
      { class: 'force_push', repo: 'github.com/o/r', branch: 'main', isDefaultBranch: true },
      false,
    ],
    [
      'force grant, default branch named only by a plan',
      { class: 'force_push', branch: 'main', namedBy: 'plan' },
      { class: 'force_push', repo: 'github.com/o/r', branch: 'main', isDefaultBranch: true },
      false,
    ],
    [
      'force grant, default branch unknown, branch named by the user',
      { class: 'force_push', branch: 'x', isBranchUserNamed: true },
      { class: 'force_push', repo: 'github.com/o/r', branch: 'x' },
      true,
    ],
    [
      'force grant, branch unknown and unnamed',
      { class: 'force_push' },
      { class: 'force_push', repo: 'github.com/o/r', branch: 'x' },
      false,
    ],
    [
      'push grant, same path on another host',
      {},
      { class: 'push', repo: 'mirror.example.com/o/r', branch: 'x' },
      false,
    ],
    [
      'delete grant, default branch unnamed',
      { class: 'remote_branch_delete' },
      {
        class: 'remote_branch_delete',
        repo: 'github.com/o/r',
        branch: 'main',
        isDefaultBranch: true,
      },
      false,
    ],
    [
      'delete grant, default branch named by the user',
      { class: 'remote_branch_delete', branch: 'main', isBranchUserNamed: true },
      {
        class: 'remote_branch_delete',
        repo: 'github.com/o/r',
        branch: 'main',
        isDefaultBranch: true,
      },
      true,
    ],
    [
      'merge grant, other number',
      { class: 'pr_merge', number: 12 },
      { class: 'pr_merge', repo: 'github.com/o/r', number: 13 },
      false,
    ],
  ];
  for (const [name, grant, action, expected] of cases) {
    test(name, () => {
      expect(covers({ ...base, ...grant }, action)).toBe(expected);
    });
  }
});

describe('parseGrants', () => {
  const reply = (grant: Record<string, unknown>) =>
    `note {"grants":[${JSON.stringify({ class: 'push', oneShot: true, namedBy: 'user', ...grant })}]}`;

  test('a plan grant quotes the previous answer, not the message', () => {
    expect(
      parseGrants(
        reply({ namedBy: 'plan', quote: 'push the branch' }),
        'ok',
        'I will push the branch',
        'github.com/o/r',
        2,
      ).length,
    ).toBe(1);
    expect(
      parseGrants(
        reply({ namedBy: 'plan', quote: 'push the branch' }),
        'push the branch',
        'I will test it',
        'github.com/o/r',
        2,
      ).length,
    ).toBe(0);
  });

  test('an unknown class or malformed reply grants nothing', () => {
    expect(
      parseGrants(reply({ class: 'deploy', quote: 'deploy' }), 'deploy', '', 'github.com/o/r', 1),
    ).toEqual([]);
    expect(parseGrants('{"grants": [', 'push', '', 'github.com/o/r', 1)).toEqual([]);
  });

  test('no repo falls back to the session repo; a named one takes its host', () => {
    expect(
      parseGrants(reply({ quote: 'push', repo: null }), 'push', '', 'github.com/O/R', 1)[0]!.repo,
    ).toBe('github.com/o/r');
    expect(
      parseGrants(reply({ quote: 'push', repo: 'o/other' }), 'push', '', 'github.com/o/r', 1)[0]!
        .repo,
    ).toBe('github.com/o/other');
  });

  test('without a session repository no grant is scoped, so none is kept', () => {
    expect(parseGrants(reply({ quote: 'push' }), 'push', '', undefined, 1)).toEqual([]);
  });

  test('a malformed target drops the grant instead of opening it', () => {
    expect(
      parseGrants(reply({ quote: 'push', branch: 'x' }), 'push', '', 'github.com/o/r', 1).length,
    ).toBe(1);
    for (const target of [
      { repo: '../x' },
      { branch: '' },
      { branch: 'a b' },
      { number: '12' },
      { number: 0 },
      { tag: '' },
    ]) {
      expect(
        parseGrants(reply({ quote: 'push', ...target }), 'push', '', 'github.com/o/r', 1),
      ).toEqual([]);
    }
  });

  test('a standing merge grant needs a number', () => {
    const grant = (number: number | null) =>
      parseGrants(
        reply({ class: 'pr_merge', number, oneShot: false, quote: 'merge them' }),
        'merge them as they pass',
        '',
        'github.com/o/r',
        1,
      )[0]!.isOneShot;
    expect(grant(12)).toBe(false);
    expect(grant(null)).toBe(true);
  });

  test('the quote must name the action', () => {
    expect(
      parseGrants(
        reply({ class: 'force_push', quote: 'go' }),
        'ok go ahead',
        '',
        'github.com/o/r',
        1,
      ),
    ).toEqual([]);
  });

  test('a branch counts as named by the user only in the quote of their own words', () => {
    const grant = (message: string, quote: string, namedBy = 'user') =>
      parseGrants(
        reply({ class: 'force_push', branch: 'main', quote, namedBy }),
        message,
        'I will force push main',
        'github.com/o/r',
        1,
      )[0]!.isBranchUserNamed;
    expect(grant('force push main', 'force push main')).toBe(true);
    expect(grant('ok, force push', 'force push')).toBe(false);
    expect(grant('force push, then maintain the docs', 'force push')).toBe(false);
    expect(grant('force push; the main concern is speed', 'force push')).toBe(false);
    expect(grant('ok', 'force push main', 'plan')).toBe(false);
  });

  test('words the user pastes from elsewhere grant nothing', () => {
    const quoted = reply({ class: 'force_push', branch: 'main', quote: 'force push to main' });
    expect(parseGrants(quoted, 'force push to main', '', 'github.com/o/r', 1).length).toBe(1);
    expect(
      parseGrants(quoted, 'what does this mean?\n> force push to main', '', 'github.com/o/r', 1),
    ).toEqual([]);
    expect(
      parseGrants(quoted, 'see the log:\n```\nforce push to main\n```', '', 'github.com/o/r', 1),
    ).toEqual([]);
  });
});

describe('repoFromUrl', () => {
  for (const [url, expected] of [
    ['git@github.com:Owner/Repo.git', 'github.com/owner/repo'],
    ['https://github.com/owner/repo', 'github.com/owner/repo'],
    ['https://user@gitlab.example.com/group/sub/repo.git/', 'gitlab.example.com/group/sub/repo'],
    ['ssh://git@gitlab.example.com:2222/group/repo.git', 'gitlab.example.com/group/repo'],
    ['/local/path/repo', undefined],
  ] as const) {
    test(url, () => {
      expect(repoFromUrl(url)).toBe(expected);
    });
  }
});
