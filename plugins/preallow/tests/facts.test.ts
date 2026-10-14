import { describe, expect, test } from 'claude-code/testing';
import { gatherFacts, type Host } from '../hooks/facts.ts';

const STARTED = Date.parse('2026-01-02T00:00:00Z');
const BEFORE = STARTED - 86_400_000;
const AFTER = STARTED + 60_000;
const PREFIX = [
  'git',
  '--literal-pathspecs',
  '--no-optional-locks',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'protocol.allow=never',
];
const READ_ONLY = new Set(['rev-parse', 'status', 'ls-files', 'rev-list', 'for-each-ref']);

const NOT_A_REPOSITORY = 'fatal: not a git repository (or any of the parent directories): .git\n';

type Run = { argv: readonly string[]; cwd: string; env: Record<string, string>; timeoutMs: number };

// A work tree at /w with a remote-tracking ref and a linked worktree that
// fetched later, a scratch folder outside any repository, and links to it
// from both. `git` answers by the arguments after the fixed prefix, in the
// directory a link points at, as the system would run it.
function host(
  git: Record<
    string,
    { exitCode?: number; stdout: string; stderr?: string; isStdoutTruncated?: boolean }
  > = {},
) {
  const runs: Run[] = [];
  const listed: string[] = [];
  const dirs: Record<string, Array<{ name: string; kind: string; mtimeMs: number }>> = {
    '/w/build': [
      { name: 'out.o', kind: 'file', mtimeMs: AFTER },
      { name: 'cache', kind: 'dir', mtimeMs: 0 },
    ],
    '/w/build/cache': [{ name: 'notes.txt', kind: 'file', mtimeMs: BEFORE }],
    '/s': [{ name: 'a', kind: 'file', mtimeMs: AFTER }],
    // Subfolders first, then files: more entries than the walk reads.
    '/big': Array.from({ length: 1500 }, (_, i) => ({
      name: `${i}`,
      kind: i < 10 ? 'dir' : 'file',
      mtimeMs: AFTER,
    })),
    // Exactly as many entries as the walk reads, with a folder left unread.
    '/full': Array.from({ length: 1000 }, (_, i) => ({
      name: `${i}`,
      kind: i === 0 ? 'dir' : 'file',
      mtimeMs: AFTER,
    })),
    '/full/0': [{ name: 'old.txt', kind: 'file', mtimeMs: BEFORE }],
    '/w/.git/worktrees': [{ name: 'wt1', kind: 'dir', mtimeMs: BEFORE }],
  };
  const links: Record<string, string> = { '/link': '/s', '/w/link': '/s' };
  const fetched: Record<string, number> = {
    '/w/.git/FETCH_HEAD': BEFORE,
    '/w/.git/worktrees/wt1/FETCH_HEAD': AFTER,
  };
  const files = new Set([
    '/w/build',
    '/w/a.txt',
    '/s',
    '/big',
    '/full',
    '/link',
    '/w/link',
    '/w/.git/FETCH_HEAD',
    '/w/.git/worktrees',
    '/w/.git/worktrees/wt1/FETCH_HEAD',
    '/w/--output=/w/x',
  ]);
  const h: Host = {
    run: async (argv, init) => {
      runs.push({ argv, ...init });
      const key = argv.slice(PREFIX.length).join(' ');
      const answer = git[key];
      if (answer !== undefined)
        return { isStdoutTruncated: false, exitCode: 0, stderr: '', ...answer };
      if (key === 'rev-parse --show-toplevel')
        return (links[init.cwd] ?? init.cwd).startsWith('/w')
          ? { exitCode: 0, stdout: '/w\n', stderr: '', isStdoutTruncated: false }
          : { exitCode: 128, stdout: '', stderr: NOT_A_REPOSITORY, isStdoutTruncated: false };
      return { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false };
    },
    exists: async (path) => files.has(path),
    stat: async (path) => ({
      kind: (links[path] ?? path) in dirs ? 'dir' : 'file',
      mtimeMs: fetched[path] ?? BEFORE,
      isLink: path in links,
    }),
    list: async (path) => {
      listed.push(path);
      return dirs[path] ?? [];
    },
    cwd: '/w',
    home: '/home/u',
    startedAt: STARTED,
  };
  return { h, runs, listed, files };
}

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

  test('only fixed read-only git queries run, offline, each with a time limit', async () => {
    const { h, runs } = host({
      'rev-parse --verify --quiet main^{commit}': { stdout: 'c0ffee\n' },
      'rev-list --count c0ffee --not --glob=refs/*': { stdout: '3\n' },
    });
    await gatherFacts(h, [
      { path: '--output=/w/x' },
      { path: '/w/a.txt' },
      { repo: '/w', ref: 'main' },
    ]);
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
