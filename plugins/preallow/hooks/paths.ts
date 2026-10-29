// Facts about a path the judge names: whether it exists, how many of its
// files changed before the session began, and its git status.

import type { Host } from './facts.ts';
import { git, gitOk } from './git.ts';

const WALK_ENTRIES = 1000;
const SAMPLE = 10;

export function absolute(host: Host, path: string): string {
  if (path === '~' || path.startsWith('~/')) {
    if (host.home === undefined) throw new Error('HOME is not set');
    return `${host.home}${path.slice(1)}`;
  }
  return path.startsWith('/') ? path : `${host.cwd}/${path}`;
}

const parent = (path: string) => path.replace(/\/[^/]*\/?$/, '') || '/';
export const iso = (ms: number) => new Date(ms).toISOString();
export const sample = (items: string[]) => ({ count: items.length, first: items.slice(0, SAMPLE) });

// How many files under a directory changed before the session began, without
// following links, up to a bound.
async function walk(host: Host, root: string) {
  let files = 0;
  let older = 0;
  let oldest: number | undefined;
  let seen = 0;

  const queue = [root];
  while (queue.length > 0 && seen < WALK_ENTRIES) {
    const dir = queue.shift()!;
    for (const entry of await host.list(dir)) {
      if (++seen > WALK_ENTRIES) break;
      if (entry.kind === 'dir') queue.push(`${dir}/${entry.name}`);
      if (entry.kind !== 'file') continue;
      files += 1;
      if (entry.mtimeMs < host.startedAt) older += 1;
      oldest = Math.min(oldest ?? entry.mtimeMs, entry.mtimeMs);
    }
  }

  return {
    files,
    filesChangedBeforeSessionStart: older,
    ...(oldest === undefined ? {} : { oldestFileChange: iso(oldest) }),
    ...(seen > WALK_ENTRIES || queue.length > 0 ? { walkStoppedAfterEntries: WALK_ENTRIES } : {}),
  };
}

export async function pathFacts(host: Host, path: string) {
  const abs = absolute(host, path);
  if (!(await host.exists(abs))) return { path: abs, exists: false };
  const stat = await host.stat(abs);
  const facts: Record<string, unknown> = {
    path: abs,
    exists: true,
    kind: stat.kind,
    ...(stat.isLink ? { isSymbolicLink: true } : {}),
    lastChange: iso(stat.mtimeMs),
  };

  const isDir = stat.kind === 'dir' && !stat.isLink;
  if (isDir) Object.assign(facts, await walk(host, abs));

  // A link's own repository is its parent's: run in the link, git would be
  // in the directory it points at.
  const dir = isDir ? abs : parent(abs);
  const top = await git(host.run, dir, ['rev-parse', '--show-toplevel']);
  if (top.exitCode !== 0) {
    if (top.stderr.includes('not a git repository'))
      return { ...facts, git: 'not inside a git work tree' };
    throw new Error(`git rev-parse exited ${top.exitCode}`);
  }

  const [changed, untracked, ignored]: [string[], string[], string[]] = [[], [], []];
  const [status, trackedFiles] = await Promise.all([
    gitOk(host.run, dir, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--ignored=matching',
      '--',
      abs,
    ]),
    gitOk(host.run, dir, ['ls-files', '-z', '--', abs]),
  ]);

  const entries = status.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.length < 4) continue;
    const [code, name] = [entry.slice(0, 2), entry.slice(3)];
    if (code === '??') untracked.push(name);
    else if (code === '!!') ignored.push(name);
    else changed.push(name);
    // A rename or copy is followed by the name it came from.
    if (code.includes('R') || code.includes('C')) i += 1;
  }

  return {
    ...facts,
    git: {
      workTree: top.stdout.trim(),
      trackedFiles: trackedFiles.split('\0').filter(Boolean).length,
      uncommittedChanges: sample(changed),
      untracked: sample(untracked),
      ignored: sample(ignored),
    },
  };
}
