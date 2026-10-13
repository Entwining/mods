import { parse, type Segment, type Word } from './shell.ts';

// What one shell segment does, as far as its text shows.
//
// `read` covers commands whose every documented effect is reading local or
// remote state (a fetch only updates remote-tracking refs). `effect` covers
// the outward actions a user grant can cover. Everything else is `unknown`,
// which leaves the call to the classifier, including comments, PR and issue
// bodies, and release notes: a grant cannot bind the text the user previews.
export type Effect =
  | {
      kind: 'push';
      cwd?: string;
      remote?: string;
      refspecs: string[];
      isForce: boolean;
      isDelete: boolean;
      isTags: boolean;
    }
  | {
      kind: 'pr_merge';
      tool: 'gh' | 'glab';
      repo?: string;
      number?: number;
      isBranchDeleted: boolean;
    };

export type Classified =
  | { kind: 'read' }
  | { kind: 'cd' }
  | { kind: 'assignment' }
  | { kind: 'effect'; effect: Effect }
  | { kind: 'unknown'; reason: string };

// Variables that change no program's behaviour in a way that matters here.
const INERT_ASSIGNMENTS = new Set([
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'NO_COLOR',
  'TZ',
  'COLUMNS',
  'GIT_PAGER',
  'PAGER',
]);

// Shell variables whose value redirects later commands or which are usually
// exported, so assigning them changes what child processes do.
const STEERING_VARIABLE =
  /^(PATH|IFS|ENV|BASH_ENV|CDPATH|HOME|TMPDIR|SHELL|SHELLOPTS|BASHOPTS|PROMPT_COMMAND|PS4|ZDOTDIR|EDITOR|VISUAL|PAGER|(GIT|GH|GLAB|SSH|LD|DYLD|XDG|CLAUDE|ANTHROPIC)_.*)$/;

// Every argument form of these only reads (`mktemp` only creates a new, empty
// file or directory), so their arguments may be dynamic. The other programs
// stay read-only through option checks that need every argument written out.
const PLAIN_READERS = new Set([
  'basename',
  'cat',
  'cmp',
  'column',
  'comm',
  'cut',
  'date',
  'df',
  'diff',
  'dirname',
  'du',
  'echo',
  'false',
  'grep',
  'egrep',
  'fgrep',
  'head',
  'hexdump',
  'id',
  'jq',
  'ls',
  'md5',
  'nl',
  'od',
  'pwd',
  'readlink',
  'realpath',
  'shasum',
  'sha256sum',
  'stat',
  'sw_vers',
  'tail',
  'test',
  '[',
  'tr',
  'true',
  'type',
  'uname',
  'wc',
  'which',
  'whoami',
  'sleep',
  'mktemp',
]);

const GIT_READ_SUBCOMMANDS = new Set([
  'blame',
  'cat-file',
  'check-ignore',
  'count-objects',
  'describe',
  'diff',
  'for-each-ref',
  'grep',
  'log',
  'ls-files',
  'ls-tree',
  'merge-base',
  'name-rev',
  'rev-list',
  'rev-parse',
  'shortlog',
  'show',
  'show-ref',
  'status',
]);

// Git options that write files, run a program named in the argument, or read
// files outside the repository; git may run outside the sandbox. Git accepts
// any unambiguous abbreviation of a long option.
const GIT_RUNNING_OPTIONS = [
  '--output',
  '--upload-pack',
  '--exec',
  '--open-files-in-pager',
  '--no-index',
  '--ext-diff',
  '--textconv',
  '--filters',
  '--contents',
  '--ignore-revs-file',
  '--exclude-from',
  '--pathspec-from-file',
  '--file',
];

const GIT_CONFIG_READ_OPTIONS = new Set([
  '--get',
  '--get-all',
  '--get-regexp',
  '--get-urlmatch',
  '--list',
  '-l',
  '--global',
  '--system',
  '--local',
  '--worktree',
  '--show-origin',
  '--show-scope',
  '--name-only',
  '-z',
  '--null',
  '--includes',
  '--no-includes',
  '--bool',
  '--int',
  '--path',
  '--all',
  '--regexp',
]);

const GH_READ = new Map<string, Set<string>>([
  ['pr', new Set(['view', 'list', 'diff', 'checks', 'status'])],
  ['issue', new Set(['view', 'list', 'status'])],
  ['run', new Set(['view', 'list', 'watch'])],
  ['repo', new Set(['view', 'list'])],
  ['release', new Set(['view', 'list'])],
  ['workflow', new Set(['view', 'list'])],
  ['label', new Set(['list'])],
  ['search', new Set(['code', 'commits', 'issues', 'prs', 'repos'])],
]);

const GLAB_READ = new Map<string, Set<string>>([
  ['mr', new Set(['view', 'list', 'diff'])],
  ['issue', new Set(['view', 'list'])],
  ['repo', new Set(['view', 'list'])],
  ['release', new Set(['view', 'list'])],
  ['ci', new Set(['list', 'get'])],
]);

// Merge options that change nothing beyond the merge and, for gh, the branch
// deletion it resolves. Subject and body options publish text, `--admin`
// overrides branch rules, and glab's source-branch removal is not resolved,
// so those and any other option are unknown.
const MERGE_OPTIONS = {
  gh: {
    flags: new Set([
      '--auto',
      '--disable-auto',
      '-m',
      '--merge',
      '-r',
      '--rebase',
      '-s',
      '--squash',
    ]),
    values: new Set(['--match-head-commit']),
    deletes: new Set(['-d', '--delete-branch']),
  },
  glab: {
    flags: new Set([
      '--auto-merge',
      '-r',
      '--rebase',
      '-s',
      '--squash',
      '-y',
      '--yes',
      '--when-pipeline-succeeds',
    ]),
    values: new Set(['--sha']),
    deletes: new Set<string>(),
  },
};

const API_FIELD_OPTIONS = new Set(['-f', '-F', '--field', '--raw-field']);
const API_VALUE_OPTIONS = new Set([
  '-X',
  '--method',
  '-H',
  '--header',
  '-q',
  '--jq',
  '-t',
  '--template',
  '-p',
  '--preview',
  '--cache',
  '--hostname',
]);
const API_FLAGS = new Set(['-i', '--include', '--paginate', '--slurp', '--silent', '--verbose']);

function texts(words: Word[]): string[] {
  return words.map((word) => word.text);
}

function hasDynamic(words: Word[]): boolean {
  return words.some((word) => word.isDynamic);
}

// Output may go to /dev/null or another descriptor; input may come from a file.
function redirectsAreReadOnly(segment: Segment): boolean {
  return segment.redirects.every((redirect) => {
    if (redirect.target === undefined) return true;
    // Bash opens a socket for these paths.
    if (redirect.op.endsWith('<'))
      return !redirect.target.isDynamic && !/^\/dev\/(tcp|udp)\//.test(redirect.target.text);
    return redirect.target.text === '/dev/null' && !redirect.target.isDynamic;
  });
}

// The last value given for an option, as Go flag parsers apply it.
function optionValue(args: string[], names: string[]): string | undefined {
  let value: string | undefined;
  for (let k = 0; k < args.length; k += 1) {
    const arg = args[k]!;
    for (const name of names) {
      if (arg === name) value = args[k + 1];
      else if (name.startsWith('--') && arg.startsWith(`${name}=`))
        value = arg.slice(name.length + 1);
      else if (!name.startsWith('--') && arg.startsWith(name) && arg.length > name.length)
        value = arg.slice(name.length);
    }
  }
  return value;
}

function positionals(args: string[], valueOptions: Set<string>): string[] {
  const found: string[] = [];
  for (let k = 0; k < args.length; k += 1) {
    const arg = args[k]!;
    if (arg === '--') {
      found.push(...args.slice(k + 1));
      break;
    }
    if (arg.startsWith('-')) {
      if (valueOptions.has(arg)) k += 1;
      continue;
    }
    found.push(arg);
  }
  return found;
}

function parseNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match =
    /^#?(\d+)$/.exec(value) ?? /\/(?:pull|merge_requests|issues)\/(\d+)(?:[/?#].*)?$/.exec(value);
  return match === null ? undefined : Number(match[1]);
}

function classifyFind(args: string[]): Classified {
  const writing = [
    '-exec',
    '-execdir',
    '-ok',
    '-okdir',
    '-delete',
    '-fprint',
    '-fprint0',
    '-fprintf',
    '-fls',
  ];
  const hit = args.find((arg) => writing.includes(arg));
  return hit === undefined ? { kind: 'read' } : { kind: 'unknown', reason: `find ${hit}` };
}

function classifySed(args: string[]): Classified {
  // Only line printing: `sed -n '10,20p' file`. Scripts can write files or run commands.
  let hasPrintOnly = false;
  for (const arg of args) {
    if (arg === '-n' || arg === '-E' || arg === '-r') {
      if (arg === '-n') hasPrintOnly = true;
      continue;
    }
    if (arg.startsWith('-')) return { kind: 'unknown', reason: `sed ${arg}` };
  }
  const script = args.find((arg) => !arg.startsWith('-'));
  if (!hasPrintOnly || script === undefined || !/^(\d+|\$)(,(\d+|\$))?p$/.test(script)) {
    return { kind: 'unknown', reason: 'sed script' };
  }
  return { kind: 'read' };
}

function isGitRunningOption(arg: string): boolean {
  if (arg.startsWith('-O')) return true;
  if (!arg.startsWith('--') || arg === '--') return false;
  const name = arg.split('=')[0]!;
  return GIT_RUNNING_OPTIONS.some((option) => option.startsWith(name) || name.startsWith(option));
}

function classifyGitConfig(rest: string[]): Classified {
  // `git config list` and `git config get NAME` are the newer spellings.
  const isSubcommand = rest[0] === 'list' || rest[0] === 'get';
  let isReading = isSubcommand;
  const options = isSubcommand ? rest.slice(1) : rest;
  for (let k = 0; k < options.length; k += 1) {
    const arg = options[k]!;
    if (!arg.startsWith('-')) continue;
    if (arg === '--type' || arg === '--default') {
      k += 1;
      continue;
    }
    if (/^--(type|default|value|url)=/.test(arg)) continue;
    if (!GIT_CONFIG_READ_OPTIONS.has(arg)) return { kind: 'unknown', reason: `git config ${arg}` };
    if (arg.startsWith('--get') || arg === '--list' || arg === '-l') isReading = true;
  }
  return isReading ? { kind: 'read' } : { kind: 'unknown', reason: 'git config change' };
}

function classifyGit(args: string[]): Classified {
  let cwd: string | undefined;
  let k = 0;
  while (k < args.length && args[k]!.startsWith('-')) {
    const option = args[k]!;
    if (option === '-C') {
      cwd = args[k + 1];
      k += 2;
      continue;
    }
    if (option === '--no-pager' || option === '-P') {
      k += 1;
      continue;
    }
    return { kind: 'unknown', reason: `git ${option}` };
  }
  const subcommand = args[k];
  const rest = args.slice(k + 1);
  if (subcommand === undefined) return { kind: 'unknown', reason: 'git without subcommand' };
  if (rest.some(isGitRunningOption))
    return { kind: 'unknown', reason: 'git option runs, writes, or reads outside the repository' };
  if (subcommand === 'grep' && rest.includes('-f'))
    return { kind: 'unknown', reason: 'git grep -f' };

  if (GIT_READ_SUBCOMMANDS.has(subcommand)) return { kind: 'read' };
  switch (subcommand) {
    case 'fetch':
    case 'ls-remote': {
      // A named remote, not a URL the command would contact unsandboxed.
      const remote = positionals(
        rest,
        new Set([
          '--depth',
          '--deepen',
          '--shallow-since',
          '--shallow-exclude',
          '-j',
          '--jobs',
          '--sort',
        ]),
      )[0];
      return remote === undefined || /^[\w.-]+$/.test(remote)
        ? { kind: 'read' }
        : { kind: 'unknown', reason: `git ${subcommand} from a URL` };
    }
    case 'branch': {
      const listing = new Set([
        '-a',
        '-r',
        '-v',
        '-vv',
        '-l',
        '--list',
        '--show-current',
        '--all',
        '--remotes',
        '--verbose',
      ]);
      const valueOptions = new Set([
        '--contains',
        '--no-contains',
        '--merged',
        '--no-merged',
        '--format',
        '--sort',
        '--points-at',
      ]);
      for (let index = 0; index < rest.length; index += 1) {
        const arg = rest[index]!;
        if (listing.has(arg) || [...valueOptions].some((name) => arg.startsWith(`${name}=`)))
          continue;
        if (valueOptions.has(arg)) {
          index += 1;
          continue;
        }
        return { kind: 'unknown', reason: 'git branch change' };
      }
      return { kind: 'read' };
    }
    case 'tag': {
      const changing = [
        '-d',
        '--delete',
        '-a',
        '--annotate',
        '-s',
        '--sign',
        '-f',
        '--force',
        '-m',
        '-F',
        '-u',
      ];
      const isListing = rest.length === 0 || rest[0] === '-l' || rest[0] === '--list';
      return isListing && !rest.some((arg) => changing.includes(arg))
        ? { kind: 'read' }
        : { kind: 'unknown', reason: 'git tag change' };
    }
    case 'remote':
      return rest.length === 0 || rest[0] === '-v' || rest[0] === 'get-url' || rest[0] === 'show'
        ? { kind: 'read' }
        : { kind: 'unknown', reason: 'git remote change' };
    case 'config':
      return classifyGitConfig(rest);
    case 'stash':
    case 'worktree':
      return rest[0] === 'list' || (subcommand === 'stash' && rest[0] === 'show')
        ? { kind: 'read' }
        : { kind: 'unknown', reason: `git ${subcommand} change` };
    case 'push':
      return classifyPush(rest, cwd);
    default:
      return { kind: 'unknown', reason: `git ${subcommand}` };
  }
}

function classifyPush(args: string[], cwd: string | undefined): Classified {
  let isForce = false;
  let isDelete = false;
  let isTags = false;
  const operands: string[] = [];
  for (const arg of args) {
    if (
      arg === '-f' ||
      arg === '--force' ||
      arg.startsWith('--force-with-lease') ||
      arg === '--force-if-includes'
    ) {
      isForce = true;
      continue;
    }
    if (arg === '-d' || arg === '--delete') {
      isDelete = true;
      continue;
    }
    if (arg === '--tags' || arg === '--follow-tags') {
      isTags = true;
      continue;
    }
    if (
      arg === '-u' ||
      arg === '--set-upstream' ||
      arg === '--porcelain' ||
      arg === '-q' ||
      arg === '--quiet' ||
      arg === '-v' ||
      arg === '--verbose'
    ) {
      continue;
    }
    // Includes `--dry-run`, which still runs the pre-push hook.
    if (arg.startsWith('-')) return { kind: 'unknown', reason: `git push ${arg}` };
    operands.push(arg);
  }
  const [remote, ...refspecs] = operands;
  for (const refspec of refspecs) {
    if (refspec.startsWith('+')) isForce = true;
    if (refspec.startsWith(':')) isDelete = true;
  }
  return {
    kind: 'effect',
    effect: { kind: 'push', cwd, remote, refspecs, isForce, isDelete, isTags },
  };
}

function classifyMerge(tool: 'gh' | 'glab', repo: string | undefined, rest: string[]): Classified {
  const { flags, values, deletes } = MERGE_OPTIONS[tool];
  const targets: string[] = [];
  let isBranchDeleted = false;
  for (let k = 0; k < rest.length; k += 1) {
    const arg = rest[k]!;
    if (!arg.startsWith('-')) {
      targets.push(arg);
      continue;
    }
    if (flags.has(arg)) continue;
    if (deletes.has(arg)) {
      isBranchDeleted = true;
      continue;
    }
    if (values.has(arg)) {
      k += 1;
      continue;
    }
    if ([...values].some((name) => arg.startsWith(`${name}=`))) continue;
    return { kind: 'unknown', reason: `${tool} merge ${arg}` };
  }
  // Without a target the forge merges the current branch's request; a branch
  // name or any other target that is not a number is not resolved here.
  const number = parseNumber(targets[0]);
  if (targets.length > 1 || (targets.length === 1 && number === undefined))
    return { kind: 'unknown', reason: `${tool} merge target` };
  return { kind: 'effect', effect: { kind: 'pr_merge', tool, repo, number, isBranchDeleted } };
}

function classifyForge(tool: 'gh' | 'glab', args: string[]): Classified {
  const repo = optionValue(args, ['-R', '--repo']);
  const filtered: string[] = [];
  for (let k = 0; k < args.length; k += 1) {
    if (args[k] === '-R' || args[k] === '--repo') {
      k += 1;
      continue;
    }
    if (args[k]!.startsWith('--repo=')) continue;
    filtered.push(args[k]!);
  }
  const [group, action, ...rest] = filtered;
  if (group === undefined) return { kind: 'unknown', reason: `${tool} without command` };

  if (group === 'api') return classifyApi(tool, filtered.slice(1));
  const reads = (tool === 'gh' ? GH_READ : GLAB_READ).get(group);
  if (action !== undefined && reads?.has(action)) return { kind: 'read' };
  if (
    ((tool === 'gh' && group === 'pr') || (tool === 'glab' && group === 'mr')) &&
    action === 'merge'
  )
    return classifyMerge(tool, repo, rest);
  return { kind: 'unknown', reason: `${tool} ${group} ${action ?? ''}`.trim() };
}

// Reads options the way the Go flag parser does: the last method wins, and a
// short option may carry its value attached (`-XPOST`, `-fquery=...`).
function classifyApi(tool: 'gh' | 'glab', args: string[]): Classified {
  let method = 'GET';
  const fields: string[] = [];
  const endpoints: string[] = [];
  for (let k = 0; k < args.length; k += 1) {
    const arg = args[k]!;
    if (!arg.startsWith('-')) {
      endpoints.push(arg);
      continue;
    }
    if (API_FLAGS.has(arg)) continue;
    let name = arg;
    let value: string | undefined;
    if (API_FIELD_OPTIONS.has(arg) || API_VALUE_OPTIONS.has(arg)) {
      value = args[k + 1] ?? '';
      k += 1;
    } else if (arg.startsWith('--') && arg.includes('=')) {
      name = arg.slice(0, arg.indexOf('='));
      value = arg.slice(arg.indexOf('=') + 1);
    } else if (!arg.startsWith('--') && arg.length > 2) {
      name = arg.slice(0, 2);
      value = arg.slice(2);
    }
    if (value === undefined || !(API_FIELD_OPTIONS.has(name) || API_VALUE_OPTIONS.has(name)))
      return { kind: 'unknown', reason: `${tool} api ${arg}` };
    if (API_FIELD_OPTIONS.has(name)) fields.push(value);
    if (name === '-X' || name === '--method') method = value.toUpperCase();
    if ((name === '-H' || name === '--header') && /method-override/i.test(value))
      return { kind: 'unknown', reason: `${tool} api method override` };
  }
  if (method !== 'GET') return { kind: 'unknown', reason: `${tool} api ${method}` };
  if (fields.length === 0) return { kind: 'read' };
  // Fields turn a REST call into a write; on the GraphQL endpoint they carry a
  // query, which only reads unless it is a mutation.
  if (endpoints[0] !== 'graphql' || fields.some((field) => field.includes('=@')))
    return { kind: 'unknown', reason: `${tool} api with fields` };
  const queries = fields.filter((field) => field.startsWith('query='));
  if (queries.length === 0 || queries.some((query) => /\bmutation\b/.test(query)))
    return { kind: 'unknown', reason: `${tool} api graphql mutation` };
  return { kind: 'read' };
}

// A substitution runs whatever it holds; only reading ones keep the segment's verdict.
function substitutionsRead(segment: Segment, depth: number): boolean {
  const words = [
    ...segment.assignments,
    ...segment.argv,
    ...segment.redirects.flatMap((redirect) =>
      redirect.target === undefined ? [] : [redirect.target],
    ),
  ];
  return words.every((word) =>
    word.substitutions.every((inner) => {
      if (depth >= 3) return false;
      const parsed = parse(inner);
      return (
        parsed.isParsed &&
        parsed.segments.every((part) => {
          const verdict = classifyAt(part, depth + 1);
          return verdict.kind === 'read' || verdict.kind === 'assignment';
        })
      );
    }),
  );
}

export function classify(segment: Segment): Classified {
  return classifyAt(segment, 0);
}

function classifyAt(segment: Segment, depth: number): Classified {
  if (!substitutionsRead(segment, depth))
    return { kind: 'unknown', reason: 'substitution runs a non-reading command' };
  if (segment.argv.length === 0) {
    // A bare `NAME=value` sets a shell variable for later segments.
    const steering = segment.assignments.find((assignment) =>
      STEERING_VARIABLE.test(assignment.text.slice(0, assignment.text.indexOf('='))),
    );
    return steering === undefined && segment.redirects.length === 0
      ? { kind: 'assignment' }
      : { kind: 'unknown', reason: 'steering assignment' };
  }
  for (const assignment of segment.assignments) {
    const name = assignment.text.slice(0, assignment.text.indexOf('='));
    if (!INERT_ASSIGNMENTS.has(name)) return { kind: 'unknown', reason: `assignment ${name}` };
  }
  const head = segment.argv[0]!;
  if (head.isDynamic) return { kind: 'unknown', reason: 'dynamic program' };
  // `/bin/ls` is `ls`; any other directory may hold a different program.
  const program = { ...head, text: head.text.replace(/^\/(?:usr\/)?bin\//, '') };
  const args = texts(segment.argv.slice(1));

  if (program.text === 'cd') {
    return segment.redirects.length === 0
      ? { kind: 'cd' }
      : { kind: 'unknown', reason: 'cd with redirection' };
  }
  // Option checks read the written text, so they hold only when no word can
  // turn into an option at run time.
  if (!PLAIN_READERS.has(program.text) && segment.argv.slice(1).some((word) => !word.isOptionSafe))
    return { kind: 'unknown', reason: 'dynamic argument' };
  let result: Classified;
  if (
    PLAIN_READERS.has(program.text) ||
    (program.text === 'command' && (args[0] === '-v' || args[0] === '-V'))
  ) {
    result = { kind: 'read' };
  } else {
    switch (program.text) {
      case 'rg':
        result = args.some((arg) => arg === '--pre' || arg.startsWith('--pre='))
          ? { kind: 'unknown', reason: 'rg --pre' }
          : { kind: 'read' };
        break;
      case 'find':
        result = classifyFind(args);
        break;
      case 'fd':
        // Short options cluster, as in `-Hx`.
        result = args.some((arg) => /^-[^-]*[xX]/.test(arg) || arg.startsWith('--exec'))
          ? { kind: 'unknown', reason: 'fd --exec' }
          : { kind: 'read' };
        break;
      case 'file':
        // `-C` compiles a magic file into the working directory.
        result = args.some((arg) => /^-[^-]*C/.test(arg) || arg.startsWith('--comp'))
          ? { kind: 'unknown', reason: 'file -C' }
          : { kind: 'read' };
        break;
      case 'printf':
        // `printf -v NAME` assigns a shell variable.
        result = args.some((arg) => arg.startsWith('-v'))
          ? { kind: 'unknown', reason: 'printf -v' }
          : { kind: 'read' };
        break;
      case 'read':
        result = args.some((arg) => STEERING_VARIABLE.test(arg))
          ? { kind: 'unknown', reason: 'read into a steering variable' }
          : { kind: 'read' };
        break;
      case 'ps':
        // `-E`, and `e` in the dashless BSD form (`ps eww`), print each
        // process's environment, where credentials live.
        result = args.some((arg) => /^-[^-]*E/.test(arg) || /^[A-Za-z]*e[A-Za-z]*$/.test(arg))
          ? { kind: 'unknown', reason: 'ps environment' }
          : { kind: 'read' };
        break;
      case 'sed':
        result = classifySed(args);
        break;
      case 'sort':
        // `-o FILE`, attached or clustered (`-ro`), and any abbreviation of
        // `--output` or `--compress-program`.
        result = args.some((arg) => /^-[^-]*o/.test(arg) || /^--[oc]/.test(arg))
          ? { kind: 'unknown', reason: 'sort -o' }
          : { kind: 'read' };
        break;
      case 'uniq':
        result =
          positionals(args, new Set(['-f', '-s'])).length <= 1
            ? { kind: 'read' }
            : { kind: 'unknown', reason: 'uniq output file' };
        break;
      case 'git':
        result = classifyGit(args);
        break;
      case 'gh':
      case 'glab':
        result = classifyForge(program.text, args);
        break;
      default:
        result = { kind: 'unknown', reason: `program ${program.text}` };
    }
  }

  if ((result.kind === 'read' || result.kind === 'effect') && !redirectsAreReadOnly(segment))
    return { kind: 'unknown', reason: 'redirection' };
  // An outward action's targets are matched against grants as written.
  if (result.kind === 'effect' && hasDynamic(segment.argv))
    return { kind: 'unknown', reason: 'dynamic effect argument' };
  return result;
}
