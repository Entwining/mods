// The judge: one policy for every tool, applied by a model to the call and to
// what the user said. `judge` takes the model call and the fact reader as
// functions, so an evaluation outside the engine runs the same prompt,
// parsing, and checks; `judgeCall` binds them to the session.

import type { EngineInterface, ModelEffort } from 'claude-code';

import { gatherFacts, type FactRequest } from './facts.ts';
import { JUDGE_SYSTEM } from './policy.ts';
import { parseVerdict, type Reply } from './verdict.ts';
import { selectWords } from './select.ts';
import { clip, userWords, type UserWords } from './words.ts';

export type JudgeCase = {
  tool: string;
  input: unknown;
  words: UserWords;
  // For a subagent's call, the brief its parent agent gave it.
  brief?: string;
  // The directory the call's loop runs in.
  cwd?: string;
  // Answers to the checks the judge asked for.
  facts?: unknown;
};

export type Verdict = {
  verdict: 'allow' | 'pass';
  reason: string;
  // What the judge asked to check, and what it was told.
  checked?: readonly FactRequest[];
  facts?: unknown;
};

// Resolves the model's reply text; rejects, saying why, when there is none.
export type Complete = (system: string, prompt: string) => Promise<string>;

// Answers the checks; rejects when the facts cannot be read.
export type Gather = (requests: readonly FactRequest[]) => Promise<unknown>;

// The call runs with its whole input, so the judge reads all of it; an input
// longer than this goes to the classifier unjudged.
const INPUT_CHARS = 100_000;
const BRIEF_CHARS = 8000;
// A judge that has not answered by then sends the call to the classifier.
const JUDGE_TIMEOUT_MS = 90_000;

export function judgePrompt(call: JudgeCase): string {
  return JSON.stringify(
    {
      user_messages: selectWords(call.words, `${call.tool} ${JSON.stringify(call.input)}`),
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

async function ask(complete: Complete, call: JudgeCase): Promise<Reply> {
  let text: string;
  try {
    text = await complete(JUDGE_SYSTEM, judgePrompt(call));
  } catch (error) {
    return { verdict: 'pass', reason: `no reply (${String(error)})` };
  }
  return parseVerdict(text);
}

// One round of checks at most: the judge decides with the facts it asked
// for, and passes when they cannot be read or still leave it unsure.
export async function judge(call: JudgeCase, complete: Complete, gather: Gather): Promise<Verdict> {
  const inputChars = (JSON.stringify(call.input) ?? '').length;
  if (inputChars > INPUT_CHARS)
    return { verdict: 'pass', reason: `input of ${inputChars} characters, too long to judge` };

  const first = await ask(complete, call);
  if (first.verdict !== 'check') return first;

  const checked = first.check;
  let facts: unknown;
  try {
    facts = await gather(checked);
  } catch (error) {
    return {
      verdict: 'pass',
      reason: `facts unavailable (${String(error)}): ${first.reason}`,
      checked,
    };
  }

  const second = await ask(complete, { ...call, facts });
  return {
    verdict: second.verdict === 'allow' ? 'allow' : 'pass',
    reason: second.verdict === 'check' ? `still unsure: ${second.reason}` : second.reason,
    checked,
    facts,
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
