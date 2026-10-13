import type { Effect } from './classify.ts';
import type { Action } from './grants.ts';

// Runs a read-only lookup and answers its trimmed stdout, or undefined on failure.
export type Run = (argv: string[], cwd: string) => Promise<string | undefined>;

// `host/owner/name` (or a GitLab group path under its host) from a remote URL.
// The host is part of the identity, so a mirror with the same path elsewhere
// is another repository; the port is not, as SSH and HTTPS URLs differ there.
export function repoFromUrl(url: string): string | undefined {
  const match =
    /^(?:[\w.-]+@)?([\w.-]+):(?!\/\/)([\w./-]+?)(?:\.git)?\/?$/.exec(url) ??
    /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([\w./-]+?)(?:\.git)?\/?$/.exec(url);
  return match === null ? undefined : `${match[1]}/${match[2]}`.toLowerCase();
}

function joinPath(base: string, path: string): string {
  if (path.startsWith('/')) return path;
  return `${base.replace(/\/$/, '')}/${path}`;
}

// The remote a push without one goes to, in git's own order.
async function pushRemote(current: string | undefined, dir: string, run: Run): Promise<string> {
  const branchConfig = (key: string) =>
    current === undefined
      ? Promise.resolve(undefined)
      : run(['git', 'config', '--get', `branch.${current}.${key}`], dir);
  return (
    (await branchConfig('pushRemote')) ??
    (await run(['git', 'config', '--get', 'remote.pushDefault'], dir)) ??
    (await branchConfig('remote')) ??
    'origin'
  );
}

// The remote branch a push without refspecs updates under `push.default`;
// undefined where it pushes several branches or none.
async function defaultTarget(
  current: string | undefined,
  dir: string,
  run: Run,
): Promise<string | undefined> {
  if (current === undefined) return undefined;
  const mode = (await run(['git', 'config', '--get', 'push.default'], dir)) ?? 'simple';
  if (mode === 'simple' || mode === 'current') return `refs/heads/${current}`;
  if (mode === 'upstream' || mode === 'tracking')
    return run(['git', 'config', '--get', `branch.${current}.merge`], dir);
  return undefined;
}

async function resolvePush(
  effect: Extract<Effect, { kind: 'push' }>,
  cwd: string,
  run: Run,
): Promise<Action[] | undefined> {
  const dir = effect.cwd === undefined ? cwd : joinPath(cwd, effect.cwd);
  const hasRef = async (ref: string) =>
    (await run(['git', 'show-ref', '--verify', '--quiet', ref], dir)) !== undefined;
  const current = await run(['git', 'symbolic-ref', '--quiet', '--short', 'HEAD'], dir);
  const localRef = async (source: string) => {
    if (source === 'HEAD') return current === undefined ? undefined : `refs/heads/${current}`;
    if (source.startsWith('refs/')) return source;
    if (await hasRef(`refs/heads/${source}`)) return `refs/heads/${source}`;
    if (await hasRef(`refs/tags/${source}`)) return `refs/tags/${source}`;
    return undefined;
  };
  const remote = effect.remote ?? (await pushRemote(current, dir, run));
  // Where the push goes: `pushurl` and `pushInsteadOf` applied, and every
  // URL when the remote has several.
  const urls = (await run(['git', 'remote', 'get-url', '--push', '--all', remote], dir))?.split(
    '\n',
  );
  if (urls === undefined || urls.length !== 1) return undefined;
  const repo = repoFromUrl(urls[0]!);
  const head = await run(
    ['git', 'symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`],
    dir,
  );
  const defaultBranch = head?.slice(remote.length + 1);
  // Configured push refspecs decide where a push without `:dst` goes.
  const hasPushConfig =
    (await run(['git', 'config', '--get-all', `remote.${remote}.push`], dir)) !== undefined;

  const actions: Action[] = effect.isTags ? [{ class: 'tag_push', repo }] : [];
  const targets: Array<{ ref: string; isDelete: boolean; isForce: boolean }> = [];
  if (effect.refspecs.length === 0 && !effect.isTags) {
    const ref = hasPushConfig ? undefined : await defaultTarget(current, dir, run);
    if (ref === undefined) return undefined;
    targets.push({ ref, isDelete: effect.isDelete, isForce: effect.isForce });
  }
  for (const raw of effect.refspecs) {
    const refspec = raw.replace(/^\+/, '');
    if (!refspec.includes(':') && hasPushConfig) return undefined;
    const [source, destination] = refspec.includes(':')
      ? (refspec.split(':', 2) as [string, string])
      : [refspec, refspec];
    const isDelete = effect.isDelete || source === '';
    const name = destination === 'HEAD' ? current : destination;
    if (name === undefined) return undefined;
    let ref = name;
    if (!name.startsWith('refs/')) {
      // A short name updates the kind of ref its source is, so `v1.0` may be
      // a tag. A deletion names the remote's ref; a remote-tracking branch of
      // that name makes it a branch.
      if (isDelete) {
        if (
          !(await hasRef(`refs/remotes/${remote}/${name}`)) ||
          (await hasRef(`refs/tags/${name}`))
        )
          return undefined;
        ref = `refs/heads/${name}`;
      } else {
        const local = await localRef(source);
        if (local === undefined) return undefined;
        ref = `${local.startsWith('refs/tags/') ? 'refs/tags/' : 'refs/heads/'}${name}`;
      }
    }
    targets.push({ ref, isDelete, isForce: effect.isForce || raw.startsWith('+') });
  }

  for (const { ref, isDelete, isForce } of targets) {
    if (ref.startsWith('refs/tags/')) {
      // No grant class covers deleting a tag.
      if (isDelete) return undefined;
      actions.push({ class: 'tag_push', repo, tag: ref.slice('refs/tags/'.length) });
      continue;
    }
    if (!ref.startsWith('refs/heads/')) return undefined;
    const branch = ref.slice('refs/heads/'.length);
    actions.push({
      class: isDelete ? 'remote_branch_delete' : isForce ? 'force_push' : 'push',
      repo,
      branch,
      // Unknown counts as default, so the stricter rule applies.
      isDefaultBranch: defaultBranch === undefined ? undefined : branch === defaultBranch,
    });
  }
  return actions;
}

async function forgeRepo(
  tool: 'gh' | 'glab',
  repo: string | undefined,
  cwd: string,
  run: Run,
): Promise<string | undefined> {
  if (tool === 'gh') {
    const url = await run(
      [
        'gh',
        'repo',
        'view',
        ...(repo === undefined ? [] : [repo]),
        '--json',
        'url',
        '--jq',
        '.url',
      ],
      cwd,
    );
    return url === undefined ? undefined : repoFromUrl(url);
  }
  // glab names a repository by path or URL; only a URL carries the host.
  if (repo !== undefined) return repoFromUrl(repo);
  const url = await run(['git', 'remote', 'get-url', 'origin'], cwd);
  return url === undefined ? undefined : repoFromUrl(url);
}

// The actions a classified effect takes, targets resolved from the working
// copy and the forge; undefined when a target cannot be established.
export async function resolveEffect(
  effect: Effect,
  cwd: string,
  run: Run,
): Promise<Action[] | undefined> {
  if (effect.kind === 'push') return resolvePush(effect, cwd, run);
  const repo = await forgeRepo(effect.tool, effect.repo, cwd, run);
  let number = effect.number;
  let head: string | undefined;
  // gh merges the current branch's pull request when none is named, and
  // `--delete-branch` deletes that request's head branch.
  if (effect.tool === 'gh' && (number === undefined || effect.isBranchDeleted)) {
    const target = number === undefined ? [] : [String(number)];
    const found = await run(
      [
        'gh',
        'pr',
        'view',
        ...target,
        ...(effect.repo === undefined ? [] : ['-R', effect.repo]),
        '--json',
        'number,headRefName',
        '--jq',
        '"\\(.number) \\(.headRefName)"',
      ],
      cwd,
    );
    const [foundNumber, foundHead] = found?.split(' ') ?? [];
    number = foundNumber === undefined ? undefined : Number(foundNumber);
    head = foundHead;
  }
  if (number === undefined || Number.isNaN(number)) return undefined;
  const actions: Action[] = [{ class: 'pr_merge', repo, number }];
  if (effect.isBranchDeleted) {
    if (head === undefined || head === '') return undefined;
    actions.push({ class: 'remote_branch_delete', repo, branch: head });
  }
  return actions;
}
