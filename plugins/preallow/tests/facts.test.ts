import { describe, expect, test } from 'claude-code/testing';

import { gatherFacts } from '../hooks/facts.ts';
import { AFTER, BEFORE, host } from './host.ts';
import { auto, bash, check, promptOf, say } from './session.ts';
import { world } from './world.ts';

describe('gatherFacts', () => {
  test('a directory: its files’ age and its git status', async () => {
    const { h } = host({
      'status --porcelain=v1 -z --untracked-files=all --ignored=matching -- /w/build': {
        stdout: 'R  build/new.c\0build/old.c\0 M build/main.c\0?? build/out.o\0!! build/cache/\0',
      },
      'ls-files -z -- /w/build': { stdout: 'build/main.c\0build/new.c\0' },
    });
    const { sessionStartedAt, answers } = await gatherFacts(h, [{ path: 'build' }]);
    expect(sessionStartedAt).toBe('2026-01-02T00:00:00.000Z');
    expect(answers[0]).toEqual({
      path: '/w/build',
      exists: true,
      kind: 'dir',
      lastChange: new Date(BEFORE).toISOString(),
      files: 2,
      filesChangedBeforeSessionStart: 1,
      oldestFileChange: new Date(BEFORE).toISOString(),
      git: {
        workTree: '/w',
        trackedFiles: 2,
        uncommittedChanges: { count: 2, first: ['build/new.c', 'build/main.c'] },
        untracked: { count: 1, first: ['build/out.o'] },
        ignored: { count: 1, first: ['build/cache/'] },
      },
    });
  });

  test('a missing path, and one outside any work tree', async () => {
    const { h } = host();
    const { answers } = await gatherFacts(h, [{ path: '~/gone' }, { path: '/s' }]);
    expect(answers[0]).toEqual({ path: '/home/u/gone', exists: false });
    expect(answers[1]).toMatchObject({ files: 1, git: 'not inside a git work tree' });
    const homeless = host().h;
    homeless.home = undefined;
    await expect(gatherFacts(homeless, [{ path: '~/gone' }])).rejects.toThrow('HOME');
  });

  test('a link to a directory is not followed: it belongs to the work tree it sits in', async () => {
    const { h, listed } = host();
    const { answers } = await gatherFacts(h, [{ path: '/w/link' }, { path: '/link' }]);
    expect(answers[0]).toMatchObject({
      kind: 'dir',
      isSymbolicLink: true,
      git: { workTree: '/w' },
    });
    expect(answers[0]).not.toHaveProperty('files');
    expect(answers[1]).toMatchObject({ isSymbolicLink: true, git: 'not inside a git work tree' });
    expect(listed).toEqual([]);
  });

  test('a large directory is walked only up to a bound', async () => {
    const { h, listed } = host();
    const { answers } = await gatherFacts(h, [{ path: '/big' }, { path: '/full' }]);
    expect(answers[0]).toMatchObject({ files: 990, walkStoppedAfterEntries: 1000 });
    expect(answers[1]).toMatchObject({ files: 999, walkStoppedAfterEntries: 1000 });
    expect(listed).toEqual(['/big', '/full']);
  });

  test('a ref: its commit, what only it holds, and what else holds it', async () => {
    const { h, files } = host({
      'rev-parse --verify --quiet origin/topic^{commit}': { stdout: 'c0ffee\n' },
      'rev-parse --symbolic-full-name origin/topic': { stdout: 'refs/remotes/origin/topic\n' },
      // A remote's HEAD naming the ref holds nothing of its own.
      'for-each-ref --contains c0ffee --format=%(refname) %(symref)': {
        stdout:
          'refs/heads/main \nrefs/remotes/origin/HEAD refs/remotes/origin/topic\nrefs/remotes/origin/topic \n',
      },
      'rev-list --count c0ffee --not --exclude=refs/remotes/origin/topic --exclude=refs/remotes/origin/HEAD --glob=refs/*':
        { stdout: '2\n' },
      'rev-parse --path-format=absolute --git-common-dir': { stdout: '/w/.git\n' },
      'rev-parse --verify --quiet gone^{commit}': { exitCode: 1, stdout: '' },
    });
    const { answers } = await gatherFacts(h, [
      { repo: '/w', ref: 'origin/topic' },
      { repo: '/w', ref: 'gone' },
    ]);
    expect(answers).toEqual([
      {
        repo: '/w',
        ref: 'origin/topic',
        exists: true,
        fullName: 'refs/remotes/origin/topic',
        commit: 'c0ffee',
        commitsReachableOnlyFromThisRef: 2,
        otherRefsContainingIt: { count: 1, first: ['refs/heads/main'] },
        remoteRefsAsOfLastFetch: new Date(AFTER).toISOString(),
      },
      { repo: '/w', ref: 'gone', exists: false },
    ]);
    const lastFetch = async () =>
      (
        (await gatherFacts(h, [{ repo: '/w', ref: 'origin/topic' }])).answers[0] as Record<
          string,
          unknown
        >
      ).remoteRefsAsOfLastFetch;
    files.delete('/w/.git/FETCH_HEAD');
    expect(await lastFetch()).toBe(new Date(AFTER).toISOString());
    files.delete('/w/.git/worktrees/wt1/FETCH_HEAD');
    expect(await lastFetch()).toBe('no fetch recorded');
  });
});

describe('facts through the judge', () => {
  const CHECK = JSON.stringify({
    reason: 'whether the reset discards uncommitted work',
    verdict: 'check',
    check: [{ path: '/w' }, { repo: '/w', ref: 'origin/topic' }],
  });

  test('the judge decides again with what the checks found', async ($, on) => {
    const w = world(on, {
      replies: [CHECK],
      git: {
        'rev-parse --show-toplevel': { exitCode: 0, stdout: '/w\n' },
        'status --porcelain=v1 -z --untracked-files=all --ignored=matching -- /w': {
          exitCode: 0,
          stdout: ' M src/a.ts\0',
        },
        'rev-parse --verify --quiet origin/topic^{commit}': { exitCode: 1, stdout: '' },
      },
      files: new Map([['/w', '']]),
    });
    await auto($);
    await say($, 'start over from main');
    expect((await check($, 'Bash', bash('git reset --hard origin/main'))).decision).toBe('allow');
    expect(w.modelCalls).toHaveLength(2);
    expect(promptOf(w, 0).facts).toBeUndefined();
    expect(promptOf(w, 1).facts!.answers).toMatchObject([
      { path: '/w', exists: true, git: { uncommittedChanges: { count: 1, first: ['src/a.ts'] } } },
      { repo: '/w', ref: 'origin/topic', exists: false },
    ]);
    const [line] = await w.logged(1);
    expect(line!.checks).toEqual([{ path: '/w' }, { repo: '/w', ref: 'origin/topic' }]);
    expect(line!.facts).toEqual(promptOf(w, 1).facts);
  });
});
