import { describe, expect, test } from 'claude-code/testing';

import { gatherFacts } from '../hooks/facts.ts';
import { host, PREFIX } from './host.ts';

const READ_ONLY = new Set([
  'rev-parse',
  'status',
  'ls-files',
  'rev-list',
  'for-each-ref',
  'cherry',
]);

describe('git', () => {
  test('only fixed read-only git queries run, offline, each with a time limit', async () => {
    const { h, runs } = host({
      'rev-parse --verify --quiet main^{commit}': { stdout: 'c0ffee\n' },
      'rev-list c0ffee --not --glob=refs/*': { stdout: 'c0ffee\nc0de\n5eed\n' },
      'for-each-ref --format=%(refname) %(symref) %(upstream) refs/remotes/*/HEAD': {
        stdout: 'refs/remotes/origin/HEAD refs/remotes/origin/main \n',
      },
      'for-each-ref --format=%(refname) refs/remotes/origin/main': {
        stdout: 'refs/remotes/origin/main\n',
      },
      'cherry refs/remotes/origin/main c0ffee': { stdout: '- c0de\n' },
    });
    const { answers } = await gatherFacts(h, [
      { path: '--output=/w/x' },
      { path: '/w/a.txt' },
      { repo: '/w', ref: 'main' },
    ]);
    expect(answers[2]).toMatchObject({
      commit: 'c0ffee',
      commitsReachableOnlyFromThisRef: 3,
      ofThoseWithAnEquivalentPatchIn: { 'refs/remotes/origin/main': 1 },
    });
    expect(runs.some(({ argv }) => argv.includes('/w/--output=/w/x'))).toBe(true);
    await expect(gatherFacts(h, [{ repo: '/w', ref: '--output=/w/x' }])).rejects.toThrow(
      'not a ref name',
    );
    for (const { argv, env, timeoutMs } of runs) {
      expect(argv.slice(0, PREFIX.length)).toEqual(PREFIX);
      expect(READ_ONLY.has(argv[PREFIX.length]!)).toBe(true);
      // Git's own words for "not a repository" are matched in English.
      expect(env.LC_ALL).toBe('C');
      expect(timeoutMs).toBeGreaterThan(0);
      // What the judge named never reaches git as an option.
      for (const arg of argv.filter((arg) => arg.includes('output')))
        expect(arg.startsWith('-')).toBe(false);
    }
  });

  test('a query that cannot run or fails rejects the whole answer', async () => {
    const { h } = host({
      'status --porcelain=v1 -z --untracked-files=all --ignored=matching -- /w/a.txt': {
        exitCode: 128,
        stdout: '',
      },
    });
    await expect(gatherFacts(h, [{ path: '/w/a.txt' }])).rejects.toThrow('exited 128');
    // Only git's own word puts a path outside any work tree.
    const refused = host({
      'rev-parse --show-toplevel': {
        exitCode: 128,
        stdout: '',
        stderr: "fatal: detected dubious ownership in repository at '/w'\n",
      },
    });
    await expect(gatherFacts(refused.h, [{ path: '/w/a.txt' }])).rejects.toThrow('exited 128');
    // Outside a repository a ref is unknown, not missing.
    const outside = host({
      'rev-parse --verify --quiet main^{commit}': { exitCode: 128, stdout: '' },
    });
    await expect(gatherFacts(outside.h, [{ repo: '/s', ref: 'main' }])).rejects.toThrow(
      'exited 128',
    );
    const cut = host({
      'ls-files -z -- /w/a.txt': { stdout: 'a.txt\0', isStdoutTruncated: true },
    });
    await expect(gatherFacts(cut.h, [{ path: '/w/a.txt' }])).rejects.toThrow('too much');
    const timedOut = host().h;
    timedOut.run = async () => {
      throw new Error('timed out');
    };
    await expect(gatherFacts(timedOut, [{ repo: '/w', ref: 'main' }])).rejects.toThrow('timed out');
  });
});
