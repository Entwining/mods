import { atom, read, update } from 'claude-code';
import type { EngineInterface, Register, ToolCheckResult } from 'claude-code';

import type { Grant, Ledger } from '../types';
import { classify } from './classify.ts';
import {
  type Action,
  covers,
  describeGrant,
  EXTRACTION_SYSTEM,
  extractionPrompt,
  mayGrant,
  parseGrants,
  parseWithdrawal,
  withdraws,
  withoutQuotes,
} from './grants.ts';
import { repoFromUrl, resolveEffect, type Run } from './resolve.ts';
import { findSecret, SECRET_WORDS } from './secrets.ts';
import { parse, type ParseResult, type Segment } from './shell.ts';

type Options = { mode?: 'shadow' | 'reads' | 'enforce' };

type Decision =
  | { verdict: 'allow'; reason: string; grants: Grant[]; actions?: Action[] }
  | { verdict: 'pass'; reason: string; actions?: Action[] };

const EMPTY: Ledger = { grants: [], held: {}, lastAnswer: '', modes: {}, prompts: 0 };
const ledgerRef = atom({ plugin: 'preallow', key: 'ledger' } as const, EMPTY);

const ANSWER_TAIL = 8000;

// The read lane leans on the sandbox to keep reads inside the allowed paths,
// so it needs the sandbox on and every program inside it. Git is the one
// excluded program whose read forms classify.ts limits to repository data.
async function sandboxGap($: EngineInterface, programs: string[]): Promise<string | undefined> {
  const { sandbox } = (await $.settings.read()) as {
    sandbox?: { enabled?: boolean; excludedCommands?: string[] };
  };
  if (sandbox?.enabled !== true) return 'sandbox off';
  const excluded = (sandbox.excludedCommands ?? []).map(
    (pattern) => pattern.replace(/:\*$/, '').split(' ')[0],
  );
  return programs.find((program) => program !== 'git' && excluded.includes(program));
}

// Every program the command line runs, those in substitutions included.
function programsOf(segments: Segment[]): string[] {
  return segments.flatMap((segment) => {
    const words = [
      ...segment.assignments,
      ...segment.argv,
      ...segment.redirects.flatMap((redirect) =>
        redirect.target === undefined ? [] : [redirect.target],
      ),
    ];
    const inner = words
      .flatMap((word) => word.substitutions)
      .flatMap((source) => {
        const parsed = parse(source);
        return parsed.isParsed ? programsOf(parsed.segments) : [];
      });
    return [
      ...(segment.argv[0] === undefined
        ? []
        : [segment.argv[0].text.replace(/^\/(usr\/)?bin\//, '')]),
      ...inner,
    ];
  });
}

function runner($: EngineInterface): Run {
  return async (argv, cwd) => {
    try {
      const result = await $.process.run(argv, { cwd, timeoutMs: 5000 });
      return result.exitCode === 0 ? result.stdout.trim() : undefined;
    } catch {
      return undefined;
    }
  };
}

async function decide(
  $: EngineInterface,
  command: string,
  parsed: ParseResult,
  grants: Grant[],
  agentId: string | undefined,
): Promise<Decision> {
  if (!parsed.isParsed) return { verdict: 'pass', reason: `unparsed: ${parsed.reason}` };
  const gap = await sandboxGap($, programsOf(parsed.segments));
  if (gap !== undefined) return { verdict: 'pass', reason: `unsandboxed: ${gap}` };
  const verdicts = parsed.segments.map(classify);
  const unknown = verdicts.find((verdict) => verdict.kind === 'unknown');
  if (unknown?.kind === 'unknown') return { verdict: 'pass', reason: `unknown: ${unknown.reason}` };

  const effects = verdicts.flatMap((verdict) =>
    verdict.kind === 'effect' ? [verdict.effect] : [],
  );
  if (effects.length === 0) {
    if (SECRET_WORDS.test(command))
      return { verdict: 'pass', reason: 'read names secret material' };
    return { verdict: 'allow', reason: 'read-only command', grants: [] };
  }
  if (effects.length > 1) return { verdict: 'pass', reason: 'several outward actions' };
  // A subagent may work in a worktree of its own, on another branch.
  if (agentId !== undefined) return { verdict: 'pass', reason: 'outward action in a subagent' };
  // The lookups read the directory the action runs in: the one a leading
  // `cd /absolute/path &&` enters, since the action runs only once it has,
  // or else the session's, which is the shell's only when Bash returns there
  // after every call.
  const [first, second] = parsed.segments;
  const cdPath =
    first?.argv[0]?.text === 'cd' && first.argv.length === 2 && first.assignments.length === 0
      ? first.argv[1]!
      : undefined;
  let dir: string;
  if (verdicts.some((verdict) => verdict.kind === 'cd')) {
    if (
      parsed.segments.length !== 2 ||
      cdPath === undefined ||
      cdPath.isDynamic ||
      !cdPath.text.startsWith('/') ||
      second?.after !== '&&'
    ) {
      return { verdict: 'pass', reason: 'cd before an outward action' };
    }
    dir = cdPath.text;
  } else {
    if ((await $.env.get('CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR')) !== '1')
      return { verdict: 'pass', reason: 'shell directory may have moved' };
    dir = await $.session.cwd();
  }

  const actions = await resolveEffect(effects[0]!, dir, runner($));
  if (actions === undefined || actions.length === 0)
    return { verdict: 'pass', reason: 'target not resolved' };
  const used: Grant[] = [];
  for (const action of actions) {
    const grant = grants.find((candidate) => covers(candidate, action));
    if (grant === undefined)
      return { verdict: 'pass', reason: `no grant covers ${action.class}`, actions };
    if (!used.includes(grant)) used.push(grant);
  }
  return {
    verdict: 'allow',
    reason: `granted: ${used.map(describeGrant).join('; ')}`,
    grants: used,
    actions,
  };
}

// Why a read the plugin allowed must have its output withheld, if it must:
// what the model would read, including the full output a large result leaves
// in a file, holds a credential-shaped value, or the output cannot be checked.
async function withholding(
  $: EngineInterface,
  text: string,
  output: unknown,
): Promise<string | undefined> {
  const { backgroundTaskId, persistedOutputPath } = (
    typeof output === 'object' && output !== null ? output : {}
  ) as { backgroundTaskId?: unknown; persistedOutputPath?: unknown };
  if (backgroundTaskId !== undefined)
    return 'the command moved to the background, where its output cannot be checked';
  let full = text;
  if (typeof persistedOutputPath === 'string') {
    try {
      full += `\n${await $.fs.read(persistedOutputPath)}`;
    } catch {
      return 'its full output could not be read to check it';
    }
  }
  const secret = findSecret(full);
  return secret === undefined ? undefined : `it holds what looks like a ${secret}`;
}

let logTail: Promise<void> = Promise.resolve();

// `$.fs` has no append and refuses files over 4 MiB, so a session's log
// rolls over to a numbered part once a part passes this size.
const LOG_PART_BYTES = 1_000_000;

// One JSON line per decision, under ~/.claude/preallow, one file per
// session and part.
function record($: EngineInterface, entry: Record<string, unknown>): void {
  logTail = logTail
    .then(async () => {
      const home = await $.env.get('HOME');
      if (home === undefined) return;
      const base = `${home}/.claude/preallow/${await $.session.id()}`;
      let part = 0;
      let path = `${base}.jsonl`;
      while ((await $.fs.exists(path)) && (await $.fs.stat(path)).size > LOG_PART_BYTES) {
        part += 1;
        path = `${base}.${part}.jsonl`;
      }
      const previous = (await $.fs.exists(path)) ? await $.fs.read(path) : '';
      await $.fs.write(
        path,
        `${previous}${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
      );
    })
    .catch(() => {});
}

export const register: Register = (on, options: Options) => {
  const enforcement = options.mode ?? 'shadow';
  // Commands the read lane allowed, by tool_use_id, so their output is checked
  // before the model reads it (in shadow mode, only logged), and the commands
  // whose output was withheld, which the classifier judges when they run again.
  const readLaneCalls = new Map<string, { command: string; isEnforcing: boolean }>();
  const withheldCommands = new Set<string>();

  // Extraction runs while the turn goes on, so a message is not held up by
  // the model. Every change to the grants joins one queue, so extractions
  // apply in the order their messages were sent and an interrupt or clear
  // after a message applies after that message's grants; a check that needs
  // grants waits for the queue.
  let grantQueue: Promise<unknown> = Promise.resolve();
  let extracting = 0;
  const enqueue = (change: () => Promise<unknown>) => {
    grantQueue = grantQueue.then(change).catch(() => {});
    return grantQueue;
  };

  // Subagents can run under a mode of their own, and the user can switch
  // modes mid-turn, so every classic event that reports a mode updates its loop.
  on('classic.*', async ($, e, next) => {
    const { permission_mode: mode, agent_id: agentId } = e as {
      permission_mode?: string;
      agent_id?: string;
    };
    const loop = agentId ?? 'main';
    if (mode !== undefined && (await read($, ledgerRef)).modes[loop] !== mode) {
      await update($, ledgerRef, (ledger) => ({
        ...ledger,
        modes: { ...ledger.modes, [loop]: mode },
      }));
    }
    return next(e);
  }).catch(($, e, next) => next(e));

  // A prompt dropped beneath grants and withdraws nothing.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind !== 'composer' && e.origin.kind !== 'bridge') return next(e);
    const ledger = await update($, ledgerRef, (current) => ({
      ...current,
      prompts: current.prompts + 1,
    }));
    const prompt = ledger.prompts;
    // A prompt typed over a running turn answers what the user is watching,
    // not the last completed answer.
    const proposal = e.turnId === undefined ? ledger.lastAnswer : '';
    const earlier = [...ledger.grants, ...Object.values(ledger.held).flat()];
    // Where the model cannot judge, words that may take an authorization back
    // withdraw every earlier grant.
    const mayWithdraw = withdraws(e.text) && (extracting > 0 || earlier.length > 0);
    // The model judges a withdrawal against the grants it is shown; one still
    // being read from an earlier message is not among them.
    const canJudge = extracting === 0;
    let settle: (hasEntered: boolean) => void = () => {};
    const hasEntered = new Promise<boolean>((resolve) => (settle = resolve));
    // While grants stand, every message goes to the model: "not now" or
    // "keep it local" take a grant back without any word a list could hold.
    // Only a message that names an action or approves one can grant.
    const canGrant = mayGrant(e.text, proposal);
    if (canGrant || earlier.length > 0 || mayWithdraw) {
      extracting += 1;
      const reply = $.model
        .complete({
          model: 'haiku',
          system: EXTRACTION_SYSTEM,
          prompt: extractionPrompt(e.text, proposal, earlier),
          maxTokens: 800,
          timeoutMs: 8000,
        })
        .catch(() => undefined);
      enqueue(async () => {
        try {
          const answer = await reply;
          if (!(await hasEntered)) return;
          let granted: Grant[] = [];
          let isWithdrawal = mayWithdraw;
          if (answer?.isAnswered === true) {
            isWithdrawal = (canJudge ? parseWithdrawal(answer.text) : undefined) ?? mayWithdraw;
            const repo = await $.session.repo();
            const sessionRepo = repo?.remote == null ? undefined : repoFromUrl(repo.remote);
            if (canGrant) granted = parseGrants(answer.text, e.text, proposal, sessionRepo, prompt);
          }
          record($, {
            event: 'extract',
            prompt,
            isAnswered: answer?.isAnswered === true,
            granted,
            isWithdrawal,
          });
          let hasWithdrawn = false;
          await update($, ledgerRef, (current) => {
            hasWithdrawn =
              isWithdrawal && (current.grants.length > 0 || Object.keys(current.held).length > 0);
            return {
              ...current,
              grants: [...(isWithdrawal ? [] : current.grants), ...granted],
              held: isWithdrawal ? {} : current.held,
            };
          });
          const notes = [
            ...(hasWithdrawn ? ['withdrew earlier grants'] : []),
            ...(granted.length > 0 ? [`recorded: ${granted.map(describeGrant).join('; ')}`] : []),
          ];
          if (notes.length > 0) $.ui.toast(`preallow ${notes.join('; ')}`);
        } finally {
          extracting -= 1;
        }
      });
    }
    try {
      const result = await next(e);
      settle(result.drop === undefined);
      return result;
    } catch (error) {
      settle(false);
      throw error;
    }
  }).catch(($, e, next) => next(e));

  // An interrupt withdraws every grant, held ones included, and the cut-off
  // answer is no proposal to approve: the user grants again in words. Lines an
  // answer quotes are someone else's words, not the agent's proposal.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      if (e.isAborted) {
        await update($, ledgerRef, (ledger) => ({ ...ledger, lastAnswer: '' }));
        enqueue(() => update($, ledgerRef, (ledger) => ({ ...ledger, grants: [], held: {} })));
      } else {
        await update($, ledgerRef, (ledger) => ({
          ...ledger,
          lastAnswer: withoutQuotes(e.answer).slice(-ANSWER_TAIL),
        }));
      }
    }
    return next(e);
  }).catch(($, e, next) => next(e));

  // `/clear` and a resume end the conversation the grants were given in.
  on('session.end', async ($, e, next) => {
    await update($, ledgerRef, () => EMPTY);
    // An extraction still running belongs to the conversation that ended.
    enqueue(() => update($, ledgerRef, (ledger) => ({ ...ledger, grants: [], held: {} })));
    return next(e);
  }).catch(($, e, next) => next(e));

  // A query (`$.tool.check` with no call behind it) gets the same answer but
  // takes no grant and leaves no record.
  on('tool.check', { tool: 'Bash' }, async ($, e, next) => {
    const core: ToolCheckResult = await next(e);
    const input = e.input as {
      command?: unknown;
      dangerouslyDisableSandbox?: unknown;
      allowed_domains?: unknown;
      run_in_background?: unknown;
    };
    if (core.decision !== 'ask' || e.ceiling !== undefined || typeof input.command !== 'string')
      return core;
    const parsed = parse(input.command);
    // Every read of one dispatch sees one moment, so a check that may use
    // grants waits for queued grant changes before the first; a read does not.
    if (parsed.isParsed && parsed.segments.some((segment) => classify(segment).kind === 'effect'))
      await grantQueue;
    const ledger = await read($, ledgerRef);
    const mode = ledger.modes[e.agentId ?? 'main'];

    const id = e.tool_use_id;
    // A settings `ask` rule or a hook's ask is a decider the user chose. Both
    // sandbox fields widen the sandbox, and auto mode has the classifier review them.
    const decision: Decision =
      mode !== 'auto'
        ? { verdict: 'pass', reason: `mode ${mode ?? 'unknown'}` }
        : core.rule !== undefined
          ? { verdict: 'pass', reason: `settings rule ${core.rule}` }
          : core.hook !== undefined
            ? { verdict: 'pass', reason: `${core.hook} hook ask` }
            : input.dangerouslyDisableSandbox === true
              ? { verdict: 'pass', reason: 'sandbox disabled for the call' }
              : Array.isArray(input.allowed_domains) && input.allowed_domains.length > 0
                ? { verdict: 'pass', reason: 'allowed_domains' }
                : input.run_in_background === true
                  ? { verdict: 'pass', reason: 'background command' }
                  : withheldCommands.has(input.command)
                    ? { verdict: 'pass', reason: 'output withheld before' }
                    : await decide($, input.command, parsed, ledger.grants, e.agentId);
    // `reads` enforces the read lane alone, a step before `enforce`.
    const isEnforcing =
      enforcement === 'enforce' ||
      (enforcement === 'reads' && decision.verdict === 'allow' && decision.actions === undefined);
    let verdict = decision.verdict;
    const used = decision.verdict === 'allow' ? decision.grants : [];
    if (id !== undefined && used.length > 0) {
      // Confirm the grants still stand and take the one-shot ones in one
      // update, so a withdrawal during the lookups wins and two parallel
      // calls cannot both use one. Shadow mode takes them too, so the log
      // shows what enforce would do.
      const oneShot = used.filter((grant) => grant.isOneShot);
      const after = await update($, ledgerRef, (current) =>
        used.every((grant) => current.grants.some((candidate) => candidate.id === grant.id))
          ? {
              ...current,
              grants: current.grants.filter(
                (candidate) => !oneShot.some((grant) => grant.id === candidate.id),
              ),
              held: oneShot.length > 0 ? { ...current.held, [id]: oneShot } : current.held,
            }
          : current,
      );
      const isStanding = used.every((grant) =>
        after.grants.some((candidate) => candidate.id === grant.id),
      );
      if (oneShot.length > 0 ? after.held[id] === undefined : !isStanding) verdict = 'pass';
    }
    if (id !== undefined) {
      record($, {
        event: 'check',
        tool_use_id: id,
        agentId: e.agentId,
        command: input.command.slice(0, 2000),
        core: core.decision,
        coreReason: core.reason,
        coreRule: core.rule,
        coreHook: core.hook,
        verdict,
        reason: decision.reason,
        actions: decision.actions,
        grants: decision.verdict === 'allow' ? decision.grants.map((grant) => grant.id) : [],
        isEnforcing,
      });
    }
    if (id !== undefined && verdict === 'allow' && decision.actions === undefined)
      readLaneCalls.set(id, { command: input.command, isEnforcing });
    if (!isEnforcing || verdict !== 'allow') return core;
    return { decision: 'allow', reason: `preallow: ${decision.reason}` };
  }).catch(($, e, next) => next(e));

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'grants',
      description:
        'Lists the outward actions preallow holds as granted; `/grants clear` withdraws them.',
    });
    return next(e);
  });

  on('command.run', { command: 'grants' }, async ($, e) => {
    if (e.args.trim() === 'clear') {
      await enqueue(() => update($, ledgerRef, (ledger) => ({ ...ledger, grants: [], held: {} })));
      return { text: 'every grant withdrawn.' };
    }
    await grantQueue;
    const { grants } = await read($, ledgerRef);
    if (grants.length === 0) return { text: `no grants (${enforcement} mode).` };
    return {
      text: [
        `grants (${enforcement} mode):`,
        ...grants.map((grant) => `- ${describeGrant(grant)}: "${grant.quote}"`),
      ].join('\n'),
    };
  });

  // A call that used a one-shot grant and was denied before it ran gives the
  // grant back. An error does not: the outward action may have run before a
  // later segment failed. A read the plugin allowed has its output withheld
  // when it holds a credential-shaped value, since the classifier never saw
  // the command; run again, it goes to the classifier.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const result = await next(e);
    const id = e.tool_use_id;
    if (id === undefined) return result;
    const readLane = readLaneCalls.get(id);
    if (readLane !== undefined) {
      const why =
        result.deny === undefined
          ? await withholding($, result.text ?? '', result.result)
          : undefined;
      readLaneCalls.delete(id);
      if (why !== undefined) {
        record($, { event: 'withheld', tool_use_id: id, why, isEnforcing: readLane.isEnforcing });
        if (readLane.isEnforcing) {
          withheldCommands.add(readLane.command);
          return {
            deny: `preallow withheld the output: ${why}. Running the same command again leaves it to the auto-mode classifier.`,
          };
        }
      }
    }
    if ((await read($, ledgerRef)).held[id] === undefined) return result;
    await update($, ledgerRef, (ledger) => {
      const { [id]: returned = [], ...rest } = ledger.held;
      return {
        ...ledger,
        held: rest,
        grants: result.deny !== undefined ? [...ledger.grants, ...returned] : ledger.grants,
      };
    });
    return result;
  }).catch(($, e, next) => {
    // The tool has run: a check that failed or ran out of time must not show
    // the output it was checking.
    const readLane = e.tool_use_id === undefined ? undefined : readLaneCalls.get(e.tool_use_id);
    if (readLane?.isEnforcing !== true || !next.called) return next(e);
    readLaneCalls.delete(e.tool_use_id!);
    withheldCommands.add(readLane.command);
    return {
      deny: 'preallow withheld the output: checking it failed. Running the same command again leaves it to the auto-mode classifier.',
    };
  });
};
