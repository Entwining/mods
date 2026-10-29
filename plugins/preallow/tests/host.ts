// A machine for the facts: a work tree at /w with a remote-tracking ref and a
// linked worktree that fetched later, a scratch folder outside any
// repository, and links to it from both.

import type { Host } from '../hooks/facts.ts';

export const STARTED = Date.parse('2026-01-02T00:00:00Z');
export const BEFORE = STARTED - 86_400_000;
export const AFTER = STARTED + 60_000;
export const PREFIX = [
  'git',
  '--literal-pathspecs',
  '--no-optional-locks',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'protocol.allow=never',
];
const NOT_A_REPOSITORY = 'fatal: not a git repository (or any of the parent directories): .git\n';

type Run = { argv: readonly string[]; cwd: string; env: Record<string, string>; timeoutMs: number };

// `git` answers by the arguments after the fixed prefix, in the
// directory a link points at, as the system would run it.
export function host(
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
    // Only files, more than the walk reads, so no folder is left unread.
    '/big': Array.from({ length: 1500 }, (_, i) => ({
      name: `${i}`,
      kind: 'file',
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
