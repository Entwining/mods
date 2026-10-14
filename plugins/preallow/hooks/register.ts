import { atom, read, update } from 'claude-code';
import type { EngineInterface, ModelEffort, Register } from 'claude-code';

import type { Modes } from '../types';
import { gatherFacts } from './facts.ts';
import { addTurn, judge, NO_WORDS, type UserWords, type Verdict } from './judge.ts';
import { findSecret } from './secrets.ts';

const modesRef = atom({ plugin: 'preallow', key: 'modes' } as const, {} as Modes);

// The user's words of each conversation, kept in the store under its session
// id: a resumed conversation runs under the id it had, so its words outlive
// the process, and `/clear` goes on under a new id that holds none.
const TURNS_KEY = 'turns:';
// The conversations written in least recently go first. Each is bounded by
// what the judge reads (`addTurn`), but together they can still pass the
// store's 4 MiB, so a write the store refuses makes room the same way.
const KEPT_CONVERSATIONS = 50;

// `at` orders the conversations: the store keeps keys in the order they were
// first set, whatever was written since.
type KeptWords = UserWords & { at: number };

// What the judge runs on when the user leaves the `model` or `effort`
// setting empty.
const JUDGE_MODEL = 'opus';
const JUDGE_EFFORT = 'medium';
// A judge that has not answered by then sends the call to the classifier.
const JUDGE_TIMEOUT_MS = 90_000;
const LOGGED_INPUT_CHARS = 2000;

// Tools whose verdict the engine keeps whatever a hook answers: it refuses a
// hook's allow of a subagent's handback, which only the classifier may allow,
// and a question or a plan waits for the person.
const ENGINE_DECIDED = new Set(['SubagentHandback', 'AskUserQuestion', 'ExitPlanMode']);

// How the engine reports refusing a hook's allow of a tool only the
// classifier may allow.
const ENGINE_REFUSAL = 'Only the auto-mode classifier can allow';

// How the core reports a call the auto-mode classifier denied; the denial
// carries no `deny` field.
const CLASSIFIER_DENIAL =
  'Permission for this action was denied by the Claude Code auto mode classifier';

// Marks the user's answer to the agent's question among their words;
// `JUDGE_SYSTEM` names it to say how a chosen option authorizes.
const ANSWER_PREFIX = "Answer to the agent's question: ";

// For a subagent's call, the first message of its loop: the brief its parent
// gave it.
async function briefOf($: EngineInterface, agentId: string | undefined) {
  if (agentId === undefined) return undefined;
  const messages = await $.session.messages({ agentId });
  if (!Array.isArray(messages)) return undefined;
  return messages.find((message) => message.role === 'user')?.text;
}

async function userWords($: EngineInterface): Promise<UserWords> {
  return (
    ((await $.store.get(`${TURNS_KEY}${await $.session.id()}`)) as KeptWords | undefined) ??
    NO_WORDS
  );
}

async function otherConversations($: EngineInterface, key: string): Promise<string[]> {
  return (await $.store.keys()).filter((other) => other.startsWith(TURNS_KEY) && other !== key);
}

// Least recently written first.
async function byAge($: EngineInterface, keys: readonly string[]): Promise<string[]> {
  const at = new Map<string, number>();
  for (const key of keys) at.set(key, ((await $.store.get(key)) as KeptWords).at);
  return keys.toSorted((a, b) => at.get(a)! - at.get(b)!);
}

let storeTail: Promise<void> = Promise.resolve();

// Writes one at a time, so a message is never lost to a concurrent write: a
// lost prohibition would let through a call the user ruled out. Each write
// replaces the conversation's words whole, so the judge reads them as they
// were before the message or after it, and a write the store refuses leaves
// them as they were.
function remember($: EngineInterface, text: string): Promise<void> {
  storeTail = storeTail
    .catch(() => {})
    .then(async () => {
      const key = `${TURNS_KEY}${await $.session.id()}`;
      const kept: KeptWords = { ...addTurn(await userWords($), text), at: Date.now() };
      for (;;) {
        try {
          await $.store.set(key, kept);
          break;
        } catch (error) {
          const [oldest] = await byAge($, await otherConversations($, key));
          if (oldest === undefined) throw error;
          await $.store.delete(oldest);
        }
      }
      const others = await otherConversations($, key);
      const excess = others.length - (KEPT_CONVERSATIONS - 1);
      if (excess <= 0) return;
      for (const old of (await byAge($, others)).slice(0, excess)) await $.store.delete(old);
    });
  return storeTail;
}

type JudgeSettings = { model: string; effort: string };

async function judgeCall(
  $: EngineInterface,
  settings: JudgeSettings,
  tool: string,
  input: unknown,
  agentId: string | undefined,
): Promise<Verdict & { ms: number }> {
  const started = Date.now();
  // Read inside the hook: a subagent's loop may run in a directory of its own.
  const cwd = await $.session.cwd();
  const verdict = await judge(
    {
      tool,
      input,
      words: await userWords($),
      brief: await briefOf($, agentId),
      cwd,
    },
    async (system, prompt) => {
      const reply = await $.model.complete({
        model: settings.model,
        effort: settings.effort as ModelEffort,
        system,
        prompt,
        maxTokens: 8192,
        timeoutMs: JUDGE_TIMEOUT_MS,
      });
      if (reply.isAnswered) return reply.text;
      throw new Error(
        reply.reason === 'api-error' ? `api-error ${reply.error} (${reply.status})` : reply.reason,
      );
    },
    async (requests) =>
      gatherFacts(
        {
          run: (argv, init) => $.process.run(argv, init),
          exists: (path) => $.fs.exists(path),
          stat: (path) => $.fs.stat(path),
          list: (path) => $.fs.list(path),
          cwd,
          home: await $.env.get('HOME'),
          startedAt: (await $.session.usage()).startedAt,
        },
        requests,
      ),
  );
  return { ...verdict, ms: Date.now() - started };
}

// Why the output of a call the plugin allowed must be withheld, if it must:
// what the model would read, including the full output a large result leaves
// in a file, holds a credential-shaped value, or the output cannot be checked.
// The model reads the core's `text`, or a hook's own result, which carries
// none, and any context beside it.
async function withholding(
  $: EngineInterface,
  text: string | undefined,
  output: unknown,
  context: readonly string[] | undefined,
): Promise<string | undefined> {
  const { backgroundTaskId, persistedOutputPath } = (output ?? {}) as {
    backgroundTaskId?: unknown;
    persistedOutputPath?: unknown;
  };
  if (backgroundTaskId !== undefined)
    return 'the call moved to the background, where its output cannot be checked';
  let full = [text ?? JSON.stringify(output) ?? '', ...(context ?? [])].join('\n');
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

// One JSON line per event, under ~/.claude/preallow, one file per
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

const loggedInput = (input: unknown) => (JSON.stringify(input) ?? '').slice(0, LOGGED_INPUT_CHARS);

export const register: Register = (on, options) => {
  // The settings go to the model client as the user wrote them; a value it
  // refuses fails the judge call, which leaves the call to the classifier.
  // An emptied field counts as unset.
  const settings: JudgeSettings = {
    model: (options.model as string | undefined) || JUDGE_MODEL,
    effort: (options.effort as string | undefined) || JUDGE_EFFORT,
  };
  // Calls the plugin allowed, by tool_use_id, so their output is checked
  // before the model reads it; calls left to the core when they run again,
  // after their output was withheld or the engine refused the plugin's allow;
  // and the calls the judge passed, so a classifier denial of one is logged.
  const allowedCalls = new Map<string, string>();
  const coreCalls = new Set<string>();
  const passedCalls = new Set<string>();

  // Subagents can run under a mode of their own, and the user can switch
  // modes mid-turn, so every classic event that reports a mode updates its
  // loop. `classic.PreToolUse` carries the tool call's own arguments instead,
  // which a tool's input could fill.
  on('classic.*', async ($, e, next) => {
    if (next.is('classic.PreToolUse', e)) return next(e);
    const { permission_mode: mode, agent_id: agentId } = e as {
      permission_mode?: string;
      agent_id?: string;
    };
    const loop = agentId ?? 'main';
    if (mode !== undefined && (await read($, modesRef))[loop] !== mode) {
      await update($, modesRef, (modes) => ({ ...modes, [loop]: mode }));
    }
    return next(e);
  });

  // Only what the user typed authorizes: not a task notification, another
  // session's message, a channel relay, or a prompt dropped beneath.
  on('prompt.submit', async ($, e, next) => {
    const result = await next(e);
    if (
      (e.origin.kind === 'composer' || e.origin.kind === 'bridge') &&
      e.isMeta !== true &&
      result.drop === undefined
    ) {
      await remember($, e.text);
    }
    return result;
  });

  on('tool.check', async ($, e, next) => {
    const core = await next(e);
    // A settings `ask` rule, a hook's ask, and an organization's ceiling are
    // deciders the user or their organization chose.
    if (
      core.decision !== 'ask' ||
      core.rule !== undefined ||
      core.hook !== undefined ||
      e.ceiling !== undefined
    )
      return core;
    if ((await read($, modesRef))[e.agentId ?? 'main'] !== 'auto') return core;
    if (ENGINE_DECIDED.has(e.tool)) {
      if (e.tool_use_id !== undefined)
        record($, {
          event: 'reserved',
          tool_use_id: e.tool_use_id,
          agentId: e.agentId,
          tool: e.tool,
          coreReason: core.reason,
        });
      return core;
    }
    // A call run in the background returns before its output arrives, and the
    // plugin cannot check what reaches the model later.
    if ((e.input as { run_in_background?: unknown }).run_in_background === true) {
      if (e.tool_use_id !== undefined)
        record($, {
          event: 'background',
          tool_use_id: e.tool_use_id,
          agentId: e.agentId,
          tool: e.tool,
          coreReason: core.reason,
        });
      return core;
    }
    const key = `${e.tool} ${JSON.stringify(e.input)}`;
    if (coreCalls.has(key)) return core;
    const verdict = await judgeCall($, settings, e.tool, e.input, e.agentId);
    const id = e.tool_use_id;
    if (id !== undefined) {
      record($, {
        event: 'check',
        tool_use_id: id,
        agentId: e.agentId,
        tool: e.tool,
        input: loggedInput(e.input),
        coreReason: core.reason,
        verdict: verdict.verdict,
        reason: verdict.reason,
        checked: verdict.checked,
        facts: verdict.facts,
        ms: verdict.ms,
      });
      if (verdict.verdict === 'allow') allowedCalls.set(id, key);
      else passedCalls.add(id);
    }
    if (verdict.verdict !== 'allow') return core;
    return { decision: 'allow', reason: `preallow: ${verdict.reason}` };
  });

  // The person's answer to the agent's question is kept with their words, as
  // the engine gives it: answers keyed by question, several chosen labels
  // joined by commas that a label may also hold, so the judge reads them
  // against the questions the person was shown, which a hook may have
  // rewritten. A dialog that resolved while the person was away holds no
  // answer of theirs.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const result = await next(e);
    if (result.result === undefined || result.isError === true) return result;
    const { answers, annotations, response, questions, afkTimeoutMs } = result.result;
    if (afkTimeoutMs === undefined)
      await remember(
        $,
        `${ANSWER_PREFIX}${JSON.stringify({ answers, annotations, response, questions })}`,
      );
    return result;
  });

  // A call the plugin allowed has its output withheld when it holds a
  // credential-shaped value, since the classifier never saw the call; run
  // again, it goes to the classifier. A call the judge passed and the
  // classifier denied is logged.
  on('tool.call', async ($, e, next) => {
    const result = await next(e);
    const id = e.tool_use_id;
    if (passedCalls.delete(id)) {
      if (result.isError === true && result.text?.startsWith(CLASSIFIER_DENIAL) === true)
        record($, {
          event: 'denied',
          tool_use_id: id,
          denial: result.text.slice(CLASSIFIER_DENIAL.length, CLASSIFIER_DENIAL.length + 300),
        });
      return result;
    }
    const key = allowedCalls.get(id);
    if (key === undefined) return result;
    if (result.isError === true && result.text?.startsWith(ENGINE_REFUSAL) === true) {
      allowedCalls.delete(id);
      coreCalls.add(key);
      record($, { event: 'refused', tool_use_id: id, refusal: result.text.slice(0, 300) });
      return result;
    }
    const why = await withholding($, result.text, result.result, result.context);
    // Still listed while the check runs, so `.catch` withholds the output if
    // the check fails or runs out of time.
    allowedCalls.delete(id);
    if (why === undefined) return result;
    record($, { event: 'withheld', tool_use_id: id, why });
    coreCalls.add(key);
    return {
      deny: `preallow withheld the output: ${why}. Running the same call again leaves it to the auto-mode classifier.`,
    };
  }).catch(($, e, next) => {
    // The tool has run: a check that failed or ran out of time must not show
    // the output it was checking.
    const key = allowedCalls.get(e.tool_use_id);
    if (key === undefined || !next.called) return next(e);
    allowedCalls.delete(e.tool_use_id);
    coreCalls.add(key);
    return {
      deny: 'preallow withheld the output: checking it failed. Running the same call again leaves it to the auto-mode classifier.',
    };
  });
};
