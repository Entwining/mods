// The judge: one policy for every tool, applied by a model to the call and to
// what the user said. `judge` takes the model call, the fact reader, and the
// clock as functions, so an evaluation outside the engine runs the same
// prompt, parsing, retries, and checks; `judgeCall` binds them to the session.

import type {
  EngineInterface,
  ModelApiError,
  ModelCompleteRequest,
  ModelCompleteResult,
  ModelEffort,
  ModelUsage,
} from 'claude-code';

import { gatherFacts, type FactRequest } from './facts.ts';
import { JUDGE_SYSTEM } from './policy.ts';
import { parseVerdict, type Reply } from './verdict.ts';
import { selectMessages } from './select.ts';
import { clip, userMessages, type UserMessages } from './messages.ts';

export type JudgeCase = {
  tool: string;
  input: unknown;
  messages: UserMessages;
  // For a subagent's call, the brief its parent agent gave it.
  brief?: string;
  // The directory the call's loop runs in.
  cwd?: string;
  // Answers to the checks the judge asked for.
  facts?: unknown;
};

export type Verdict = {
  verdict: 'allow' | 'review';
  reason: string;
  // Whether the model answered, absent when the judge was not asked and false
  // when its time ran out before the call after a check; when it did not
  // answer, why; and the failures retried before it.
  isAnswered?: boolean;
  failure?: string;
  retried?: string[];
  // What the judge asked to check, and what it was told.
  checks?: readonly FactRequest[];
  facts?: unknown;
  // What each model call cost.
  usage: ModelUsage[];
};

export type JudgeHost = {
  // One model call; the caller chooses the model, effort, and reply cap.
  complete: (
    request: Pick<ModelCompleteRequest, 'system' | 'prompt' | 'timeoutMs'>,
  ) => Promise<ModelCompleteResult>;
  // Answers the checks; rejects when the facts cannot be read.
  gather: (requests: readonly FactRequest[]) => Promise<unknown>;
  // The clock the judge's time limit and the wait before a retry run on.
  now: () => Promise<number>;
  sleep: (ms: number) => Promise<void>;
};

// The call runs with its whole input, so the judge reads all of it; an input
// longer than this goes to the classifier unjudged.
const INPUT_CHARS = 100_000;
const BRIEF_CHARS = 8000;
// A judge that has not answered by then, retries included, sends the call to
// the classifier.
const JUDGE_TIMEOUT_MS = 90_000;
// Empty replies come between replies to prompts of the same size seconds
// apart, so a call made again shortly after usually gets one. The wait, unlike
// a model call, counts against the hook's own ten-second budget.
const RETRY_DELAY_MS = 2000;
// The API errors the engine says may clear on their own: overload, rate
// limits, and the server's own failures.
const TRANSIENT = new Set<ModelApiError>(['rate_limit', 'overloaded', 'server_error']);

export function judgePrompt(call: JudgeCase): string {
  return JSON.stringify(
    {
      user_messages: selectMessages(call.messages, `${call.tool} ${JSON.stringify(call.input)}`),
      ...(call.brief === undefined ? {} : { subagent_brief: clip(call.brief, BRIEF_CHARS) }),
      cwd: call.cwd,
      tool: call.tool,
      input: call.input,
      facts: call.facts,
    },
    null,
    2,
  );
}

type Run = { deadline: number; usage: ModelUsage[]; retried: string[] };

// The model's reply, or why it gave none. A call that failed in a way a later
// call can get past is made once more while the judge's time lasts; one cut
// short, by the time limit or the person, or refused for what it asked is not.
async function ask(
  host: JudgeHost,
  call: JudgeCase,
  run: Run,
): Promise<Reply | { failure: string }> {
  const prompt = judgePrompt(call);
  for (let retry = false; ; retry = true) {
    const timeoutMs = run.deadline - (await host.now());
    if (timeoutMs <= 0) return { failure: 'aborted' };
    let result: ModelCompleteResult;
    try {
      result = await host.complete({
        // Only the policy is marked: the words are chosen per call, so a mark
        // on the prompt would pay for cache writes that later calls rarely read.
        system: [{ text: JUDGE_SYSTEM, cache: true }],
        prompt,
        timeoutMs,
      });
    } catch (error) {
      // The engine refused to send it, as for a model or effort it rejects.
      return { failure: String(error) };
    }
    run.usage.push(result.usage);
    if (result.isAnswered) return parseVerdict(result.text);

    const failure =
      result.reason === 'api-error'
        ? `api-error ${result.error} (${result.status})`
        : result.reason;
    const retryable =
      result.reason === 'empty-reply' ||
      (result.reason === 'api-error' && TRANSIENT.has(result.error));
    if (retry || !retryable || (await host.now()) + RETRY_DELAY_MS >= run.deadline)
      return { failure };
    run.retried.push(failure);
    await host.sleep(RETRY_DELAY_MS);
  }
}

// One round of checks at most: the judge decides with the facts it asked
// for, and answers review when they cannot be read or still leave it unsure.
export async function judge(call: JudgeCase, host: JudgeHost): Promise<Verdict> {
  const inputChars = (JSON.stringify(call.input) ?? '').length;
  if (inputChars > INPUT_CHARS)
    return {
      verdict: 'review',
      reason: `input of ${inputChars} characters, too long to judge`,
      usage: [],
    };

  const run: Run = { deadline: (await host.now()) + JUDGE_TIMEOUT_MS, usage: [], retried: [] };
  const spent = () => ({
    usage: run.usage,
    ...(run.retried.length > 0 ? { retried: run.retried } : {}),
  });

  const first = await ask(host, call, run);
  if ('failure' in first)
    return { verdict: 'review', reason: 'no reply', isAnswered: false, ...first, ...spent() };
  if (first.verdict !== 'check') return { ...first, isAnswered: true, ...spent() };

  const checks = first.check;
  let facts: unknown;
  try {
    facts = await host.gather(checks);
  } catch (error) {
    return {
      verdict: 'review',
      reason: `facts unavailable (${String(error)}): ${first.reason}`,
      isAnswered: true,
      checks,
      ...spent(),
    };
  }

  const second = await ask(host, { ...call, facts }, run);
  if ('failure' in second)
    return {
      verdict: 'review',
      reason: `no reply to the facts: ${first.reason}`,
      isAnswered: false,
      ...second,
      checks,
      facts,
      ...spent(),
    };
  return {
    verdict: second.verdict === 'allow' ? 'allow' : 'review',
    reason: second.verdict === 'check' ? `still unsure: ${second.reason}` : second.reason,
    isAnswered: true,
    checks,
    facts,
    ...spent(),
  };
}

// For a subagent's call, the first message of its loop: the brief its parent
// gave it.
async function briefOf($: EngineInterface, agentId: string | undefined) {
  if (agentId === undefined) return undefined;
  const messages = await $.session.messages({ agentId });
  if (!Array.isArray(messages)) return undefined;
  return messages.find((message) => message.role === 'user')?.text;
}

export type JudgeSettings = { model: string; effort: string };

export async function judgeCall(
  $: EngineInterface,
  settings: JudgeSettings,
  tool: string,
  input: unknown,
  agentId: string | undefined,
): Promise<Verdict & { ms: number }> {
  const started = Date.now();
  // Read inside the hook: a subagent's loop may run in a directory of its own.
  const cwd = await $.session.cwd();
  return {
    ...(await judge(
      {
        tool,
        input,
        messages: await userMessages($),
        brief: await briefOf($, agentId),
        cwd,
      },
      {
        complete: (request) =>
          $.model.complete({
            ...request,
            model: settings.model,
            effort: settings.effort as ModelEffort,
            maxTokens: 8192,
          }),
        gather: async (requests) =>
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
        now: () => $.clock.now(),
        sleep: (ms) => $.clock.sleep(ms),
      },
    )),
    ms: Date.now() - started,
  };
}
