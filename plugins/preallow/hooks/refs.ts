// Facts about a ref the judge names: its commit, which refs hold it, and
// what of it no other ref holds.

import type { Host } from './facts.ts';
import { git, gitOk, isRefName, type Run } from './git.ts';
import { absolute, iso, sample } from './paths.ts';

// Of the commits only one ref holds, how many have an equivalent patch, the
// same change with whitespace aside, in the branch the ref follows or in a
// remote's default branch, where a merged pull request's commits land rebased
// or cherry-picked; git's config and refs choose them, never the judge.
// Patches compare one commit at a time, so a series squashed into one commit,
// or a rebase that resolved conflicts, finds none, and merge commits are
// never compared.
async function equivalentPatches(
  run: Run,
  dir: string,
  fullName: string,
  sha: string,
  onlyHere: ReadonlySet<string>,
): Promise<Record<string, number>> {
  const named = (
    await gitOk(run, dir, [
      'for-each-ref',
      '--format=%(refname) %(symref) %(upstream)',
      ...(fullName === '' ? [] : [fullName]),
      'refs/remotes/*/HEAD',
    ])
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(' ') as [string, string, string]);
  const compared = new Set(
    named
      .map(([name, target, upstream]) => (name === fullName ? upstream : target))
      .filter((name) => name !== '' && name !== fullName),
  );
  if (compared.size === 0) return {};

  // A branch's upstream stays configured after its remote branch is gone,
  // and `git cherry` fails on a ref that does not exist.
  const existing = (await gitOk(run, dir, ['for-each-ref', '--format=%(refname)', ...compared]))
    .split('\n')
    .filter((name) => compared.has(name));
  const counts = await Promise.all(
    existing.map(async (name) => {
      const lines = (await gitOk(run, dir, ['cherry', name, sha])).split('\n');
      // `-` marks a commit whose patch the compared ref has.
      const equivalent = lines.filter(
        (line) => line.startsWith('- ') && onlyHere.has(line.slice(2)),
      );
      return [name, equivalent.length];
    }),
  );
  return Object.fromEntries(counts);
}

export async function refFacts(host: Host, repo: string, ref: string) {
  const dir = absolute(host, repo);
  if (!isRefName(ref)) throw new Error('not a ref name');

  const commit = await git(host.run, dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  // 1 is a missing ref; anything else, such as 128 outside a repository,
  // says nothing about it.
  if (commit.exitCode === 1) return { repo: dir, ref, exists: false };
  if (commit.exitCode !== 0) throw new Error(`git rev-parse exited ${commit.exitCode}`);

  const sha = commit.stdout.trim();
  const fullName = (await gitOk(host.run, dir, ['rev-parse', '--symbolic-full-name', ref])).trim();
  // A symbolic ref such as a remote's HEAD is another name for the ref it
  // points at, not another copy of its commits.
  const holders = (
    await gitOk(host.run, dir, ['for-each-ref', '--contains', sha, '--format=%(refname) %(symref)'])
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(' ') as [string, string]);
  const aliases = holders.filter(([, target]) => target !== '' && target === fullName);
  const containing = holders
    .filter(([name, target]) => target === '' && name !== fullName)
    .map(([name]) => name);

  const onlyHere = await gitOk(host.run, dir, [
    'rev-list',
    sha,
    '--not',
    ...[fullName, ...aliases.map(([name]) => name)]
      .filter(Boolean)
      .map((name) => `--exclude=${name}`),
    // Every ref but not HEAD, which would count the current branch's commits
    // as held elsewhere.
    '--glob=refs/*',
  ]);
  const unique = new Set(onlyHere.split('\n').filter(Boolean));
  const [patches, remoteRefsAsOfLastFetch] = await Promise.all([
    unique.size === 0 ? undefined : equivalentPatches(host.run, dir, fullName, sha, unique),
    fullName.startsWith('refs/remotes/') ? lastFetch(host, dir) : undefined,
  ]);
  return {
    repo: dir,
    ref,
    exists: true,
    fullName: fullName || undefined,
    commit: sha,
    commitsReachableOnlyFromThisRef: unique.size,
    ...(patches === undefined ? {} : { ofThoseWithAnEquivalentPatchIn: patches }),
    otherRefsContainingIt: sample(containing),
    ...(remoteRefsAsOfLastFetch === undefined ? {} : { remoteRefsAsOfLastFetch }),
  };
}

// A fetch updates the remote refs every worktree shares but writes FETCH_HEAD
// in the worktree it ran in, so the refs are as fresh as the newest FETCH_HEAD
// among the main worktree and the linked ones.
async function lastFetch(host: Host, dir: string): Promise<string> {
  const common = (
    await gitOk(host.run, dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  ).trim();
  const linked = (await host.exists(`${common}/worktrees`))
    ? (await host.list(`${common}/worktrees`)).map(({ name }) => `${common}/worktrees/${name}`)
    : [];
  const fetched = await Promise.all(
    [common, ...linked].map(async (gitDir) => {
      const fetchHead = `${gitDir}/FETCH_HEAD`;
      return (await host.exists(fetchHead)) ? (await host.stat(fetchHead)).mtimeMs : undefined;
    }),
  );
  const times = fetched.filter((time) => time !== undefined);
  return times.length === 0 ? 'no fetch recorded' : iso(Math.max(...times));
}
