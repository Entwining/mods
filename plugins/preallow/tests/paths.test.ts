import { describe, expect, test } from 'claude-code/testing';

import { gatherFacts } from '../hooks/facts.ts';
import { BEFORE, host } from './host.ts';

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

  test('a missing path, one outside any work tree, and a home path without HOME', async () => {
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
    expect(answers[0]).toMatchObject({ files: 1000, walkStoppedAfterEntries: 1000 });
    expect(answers[1]).toMatchObject({ files: 999, walkStoppedAfterEntries: 1000 });
    expect(listed).toEqual(['/big', '/full']);
  });
});
