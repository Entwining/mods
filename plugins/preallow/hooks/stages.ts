// The judge's two stages, each on the session's model client, facts, and
// clock.

import type { EngineInterface, ModelEffort } from 'claude-code';

import { gatherFacts } from './facts.ts';
import { judge, type JudgeCase, type Verdict } from './judge.ts';

type JudgeStage = { model: string; effort: string };
// The stage that judges every call, and the one that judges again a call the
// first did not allow.
export type JudgeSettings = JudgeStage & { escalation?: JudgeStage };

type Judged = Verdict & JudgeStage & { ms: number };

async function judgeOn(
  $: EngineInterface,
  { model, effort }: JudgeStage,
  call: JudgeCase & { cwd: string },
): Promise<Judged> {
  const started = Date.now();
  return {
    ...(await judge(call, {
      complete: (request) =>
        $.model.complete({ ...request, model, effort: effort as ModelEffort, maxTokens: 8192 }),
      gather: async (requests) => {
        const [home, usage] = await Promise.all([$.env.get('HOME'), $.session.usage()]);
        return gatherFacts(
          {
            run: (argv, init) => $.process.run(argv, init),
            exists: (path) => $.fs.exists(path),
            stat: (path) => $.fs.stat(path),
            list: (path) => $.fs.list(path),
            cwd: call.cwd,
            home,
            startedAt: usage.startedAt,
          },
          requests,
        );
      },
      now: () => $.clock.now(),
      sleep: (ms) => $.clock.sleep(ms),
    })),
    model,
    effort,
    ms: Date.now() - started,
  };
}

// A call the first stage did not allow, failures included, is judged again from
// the start by the second, whose verdict is final; one too long to ask the
// first about is too long for the second. Each stage has the judge's whole
// time limit, since one shared would leave none to judge a call the first
// stage ran out of time on.
export async function judgeCall(
  $: EngineInterface,
  settings: JudgeSettings,
  call: JudgeCase & { cwd: string },
): Promise<Judged & { escalation?: Judged }> {
  const judged = await judgeOn($, settings, call);
  if (
    judged.verdict === 'allow' ||
    judged.isAnswered === undefined ||
    settings.escalation === undefined
  )
    return judged;
  return { ...judged, escalation: await judgeOn($, settings.escalation, call) };
}
