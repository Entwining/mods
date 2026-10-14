// Facts the judge asks for when a call's recoverability turns on the state
// of files or git refs: a fixed set of read-only queries. The judge's
// strings reach git only as absolute paths or as checked ref names, so it
// chooses what to look at, never what runs.

export type FactRequest = { path: string } | { repo: string; ref: string };

export type Host = {
  // Runs a command by argv, no shell; rejects when it cannot start or times out.
  run: (
    argv: readonly string[],
    init: { cwd: string; env: Record<string, string>; timeoutMs: number },
  ) => Promise<{ exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean }>;
  exists: (path: string) => Promise<boolean>;
  stat: (path: string) => Promise<{ kind: string; mtimeMs: number; isLink: boolean }>;
  list: (path: string) => Promise<Array<{ name: string; kind: string; mtimeMs: number }>>;
  // The directory relative paths resolve from, and `~`.
  cwd: string;
  home: string | undefined;
  // When the session began: a file changed before then predates the task.
  startedAt: number;
};

export const MAX_REQUESTS = 4;
const RUN_TIMEOUT_MS = 5000;
// Paths taken as written, not as globs; optional locks off, so `status`
// does not rewrite the index; no fsmonitor process; no transport, so nothing
// reaches the network, lazy fetches of a partial clone included.
const GIT = [
  'git',
  '--literal-pathspecs',
  '--no-optional-locks',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'protocol.allow=never',
] as const;
const WALK_ENTRIES = 1000;
const SAMPLE = 10;
// A ref name the judge gives may not pose as an option.
const REF_NAME = /^[^-\s][^\s]*$/;

export const isRefName = (value: unknown): value is string =>
  typeof value === 'string' && REF_NAME.test(value);

// `LC_ALL=C` keeps git's messages in English, so its own word that a
// directory lies outside any repository can be told from any other failure.
async function git(host: Host, cwd: string, args: readonly string[]) {
  return host.run([...GIT, ...args], { cwd, env: { LC_ALL: 'C' }, timeoutMs: RUN_TIMEOUT_MS });
}

// A query whose failure, or output cut short, says nothing about the state
// it asks after.
async function gitOk(host: Host, cwd: string, args: readonly string[]): Promise<string> {
  const { exitCode, stdout, isStdoutTruncated } = await git(host, cwd, args);
  if (exitCode !== 0) throw new Error(`git ${args[0]} exited ${exitCode}`);
  if (isStdoutTruncated) throw new Error(`git ${args[0]} wrote too much`);
  return stdout;
}

function absolute(host: Host, path: string): string {
  if (path === '~' || path.startsWith('~/')) {
    if (host.home === undefined) throw new Error('HOME is not set');
    return `${host.home}${path.slice(1)}`;
  }
  return path.startsWith('/') ? path : `${host.cwd}/${path}`;
}

const parent = (path: string) => path.replace(/\/[^/]*\/?$/, '') || '/';
const iso = (ms: number) => new Date(ms).toISOString();
const sample = (items: string[]) => ({ count: items.length, first: items.slice(0, SAMPLE) });

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

async function pathFacts(host: Host, path: string) {
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
  const top = await git(host, dir, ['rev-parse', '--show-toplevel']);
  if (top.exitCode !== 0) {
    if (top.stderr.includes('not a git repository'))
      return { ...facts, git: 'not inside a git work tree' };
    throw new Error(`git rev-parse exited ${top.exitCode}`);
  }
  const changed: string[] = [];
  const untracked: string[] = [];
  const ignored: string[] = [];
  const [status, trackedFiles] = await Promise.all([
    gitOk(host, dir, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--ignored=matching',
      '--',
      abs,
    ]),
    gitOk(host, dir, ['ls-files', '-z', '--', abs]),
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

async function refFacts(host: Host, repo: string, ref: string) {
  const dir = absolute(host, repo);
  if (!isRefName(ref)) throw new Error('not a ref name');
  const commit = await git(host, dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  // 1 is a missing ref; anything else, such as 128 outside a repository,
  // says nothing about it.
  if (commit.exitCode === 1) return { repo: dir, ref, exists: false };
  if (commit.exitCode !== 0) throw new Error(`git rev-parse exited ${commit.exitCode}`);
  const sha = commit.stdout.trim();
  const fullName = (await gitOk(host, dir, ['rev-parse', '--symbolic-full-name', ref])).trim();
  // A symbolic ref such as a remote's HEAD is another name for the ref it
  // points at, not another copy of its commits.
  const holders = (
    await gitOk(host, dir, ['for-each-ref', '--contains', sha, '--format=%(refname) %(symref)'])
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(' ') as [string, string]);
  const aliases = holders.filter(([, target]) => target !== '' && target === fullName);
  const containing = holders
    .filter(([name, target]) => target === '' && name !== fullName)
    .map(([name]) => name);
  const onlyHere = await gitOk(host, dir, [
    'rev-list',
    '--count',
    sha,
    '--not',
    ...[fullName, ...aliases.map(([name]) => name)]
      .filter(Boolean)
      .map((name) => `--exclude=${name}`),
    // Every ref but not HEAD, which would count the current branch's commits
    // as held elsewhere.
    '--glob=refs/*',
  ]);
  const facts: Record<string, unknown> = {
    repo: dir,
    ref,
    exists: true,
    fullName: fullName || undefined,
    commit: sha,
    commitsReachableOnlyFromThisRef: Number(onlyHere.trim()),
    otherRefsContainingIt: sample(containing),
  };
  if (fullName.startsWith('refs/remotes/')) {
    // A fetch updates the remote refs every worktree shares but writes
    // FETCH_HEAD in the worktree it ran in, so the refs are as fresh as the
    // newest FETCH_HEAD among the main worktree and the linked ones.
    const common = (
      await gitOk(host, dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
    ).trim();
    const linked = (await host.exists(`${common}/worktrees`))
      ? (await host.list(`${common}/worktrees`)).map(({ name }) => `${common}/worktrees/${name}`)
      : [];
    let newest: number | undefined;
    for (const gitDir of [common, ...linked]) {
      const fetchHead = `${gitDir}/FETCH_HEAD`;
      if (!(await host.exists(fetchHead))) continue;
      newest = Math.max(newest ?? 0, (await host.stat(fetchHead)).mtimeMs);
    }
    facts.remoteRefsAsOfLastFetch = newest === undefined ? 'no fetch recorded' : iso(newest);
  }
  return facts;
}

// Rejects when any query cannot run, so the judge never decides on half the
// facts it asked for.
export async function gatherFacts(host: Host, requests: readonly FactRequest[]) {
  return {
    sessionStartedAt: iso(host.startedAt),
    answers: await Promise.all(
      requests.map((request) =>
        'path' in request
          ? pathFacts(host, request.path)
          : refFacts(host, request.repo, request.ref),
      ),
    ),
  };
}
