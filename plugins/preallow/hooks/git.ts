// Running git for the facts: fixed read-only queries that never reach the
// network, and ref names that cannot pose as options.

// Runs a command by argv, no shell; rejects when it cannot start or times out.
export type Run = (
  argv: readonly string[],
  init: { cwd: string; env: Record<string, string>; timeoutMs: number },
) => Promise<{ exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean }>;

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
// A ref name the judge gives may not pose as an option.
const REF_NAME = /^[^-\s][^\s]*$/;

export const isRefName = (value: unknown): value is string =>
  typeof value === 'string' && REF_NAME.test(value);

// `LC_ALL=C` keeps git's messages in English, so its own word that a
// directory lies outside any repository can be told from any other failure.
export async function git(run: Run, cwd: string, args: readonly string[]) {
  return run([...GIT, ...args], { cwd, env: { LC_ALL: 'C' }, timeoutMs: RUN_TIMEOUT_MS });
}

// A query whose failure, or output cut short, says nothing about the state
// it asks after.
export async function gitOk(run: Run, cwd: string, args: readonly string[]): Promise<string> {
  const { exitCode, stdout, isStdoutTruncated } = await git(run, cwd, args);
  if (exitCode !== 0) throw new Error(`git ${args[0]} exited ${exitCode}`);
  if (isStdoutTruncated) throw new Error(`git ${args[0]} wrote too much`);
  return stdout;
}
