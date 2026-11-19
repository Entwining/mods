import { describe, expect, test } from 'claude-code/testing';
import type { ModelApiError, ModelCompleteResult, ModelTextBlock } from 'claude-code';

import { judge, type JudgeHost } from '../hooks/judge.ts';
import { addTurn, NO_MESSAGES } from '../hooks/messages.ts';

const messages = (...turns: string[]) => turns.reduce(addTurn, NO_MESSAGES);

// The prompt's blocks joined, as the model reads them.
const joined = (blocks: readonly ModelTextBlock[]) => blocks.map(({ text }) => text).join('');

const USAGE = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};
const text = (reply: string): ModelCompleteResult => ({
  isAnswered: true,
  text: reply,
  usage: USAGE,
});
const EMPTY: ModelCompleteResult = { isAnswered: false, reason: 'empty-reply', usage: USAGE };
const ABORTED: ModelCompleteResult = { isAnswered: false, reason: 'aborted', usage: USAGE };
const apiError = (error: ModelApiError, status: number | null): ModelCompleteResult => ({
  isAnswered: false,
  reason: 'api-error',
  error,
  status,
  usage: USAGE,
});

// A model that gives these results in turn, on a clock that moves only while
// a call or the facts take their time and while the judge waits.
function model(results: ModelCompleteResult[], callMs = 0, factsMs = 0) {
  let clock = 0;
  const calls: Array<{ prompt: string; startedAt: number; timeoutMs: number }> = [];
  const host: JudgeHost = {
    complete: async ({ prompt, timeoutMs }) => {
      calls.push({
        prompt: joined(prompt as ModelTextBlock[]),
        startedAt: clock,
        timeoutMs: timeoutMs!,
      });
      clock += callMs;
      return results[calls.length - 1] ?? EMPTY;
    },
    gather: async () => {
      clock += factsMs;
      return {};
    },
    now: async () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  };
  return { calls, host };
}

describe('judge', () => {
  const CALL = { tool: 'Bash', input: { command: 'rm -rf build' }, messages: messages('tidy up') };
  const CHECK = text(
    JSON.stringify({ reason: 'r', verdict: 'check', check: [{ path: '/w/build' }] }),
  );
  const ALLOW = text(JSON.stringify({ reason: 'only files made this session', verdict: 'allow' }));

  test('facts that cannot be read go to review', async () => {
    const failing = model([CHECK, ALLOW]);
    failing.host.gather = async () => {
      throw new Error('timed out');
    };
    const unavailable = await judge(CALL, failing.host);
    expect([unavailable.verdict, failing.calls.length]).toEqual(['review', 1]);
  });

  test('an empty reply, or an API error the engine says may clear on its own, is asked once more', async () => {
    for (const failed of [EMPTY, apiError('overloaded', 529), apiError('server_error', null)]) {
      const { calls, host } = model([failed, ALLOW]);
      expect(await judge(CALL, host)).toMatchObject({ verdict: 'allow', isAnswered: true });
      expect(calls).toHaveLength(2);
      expect(calls[1]!.prompt).toBe(calls[0]!.prompt);
    }
    const twice = model([apiError('rate_limit', 429), EMPTY, ALLOW]);
    expect(await judge(CALL, twice.host)).toEqual({
      verdict: 'review',
      reason: 'no reply',
      isAnswered: false,
      failure: 'empty-reply',
      retried: ['api-error rate_limit (429)'],
      usage: [USAGE, USAGE],
    });
  });

  test('a call that runs out its own time is made once more, and the judge says so when that one stalls too', async () => {
    const stalled = model([ABORTED, ALLOW], 45_000);
    expect(await judge(CALL, stalled.host)).toMatchObject({
      verdict: 'allow',
      retried: ['timeout'],
    });
    expect(stalled.calls.map(({ startedAt, timeoutMs }) => [startedAt, timeoutMs])).toEqual([
      [0, 45_000],
      [47_000, 43_000],
    ]);
    const twice = model([ABORTED, ABORTED], 45_000);
    expect(await judge(CALL, twice.host)).toMatchObject({
      verdict: 'review',
      failure: 'timeout',
      retried: ['timeout'],
    });
  });

  test('a call the person cut short, or refused for what it asked, is not made again', async () => {
    for (const [failed, failure] of [
      [ABORTED, 'aborted'],
      [apiError('invalid_request', 400), 'api-error invalid_request (400)'],
    ] as const) {
      const { calls, host } = model([failed, ALLOW]);
      const verdict = await judge(CALL, host);
      expect([verdict.verdict, verdict.failure, verdict.retried, calls.length]).toEqual([
        'review',
        failure,
        undefined,
        1,
      ]);
    }
  });

  test('a request the model client refuses to send is a failure that says why', async () => {
    const { host } = model([]);
    host.complete = async () => {
      throw new Error('synthetic refusal of the effort');
    };
    expect(await judge(CALL, host)).toMatchObject({
      verdict: 'review',
      isAnswered: false,
      failure: 'Error: synthetic refusal of the effort',
    });
  });

  test("the judge's calls, retries included, end within its time limit", async () => {
    const slow = model([CHECK, EMPTY, ALLOW], 40_000);
    expect((await judge(CALL, slow.host)).verdict).toBe('allow');
    expect(slow.calls.map(({ startedAt, timeoutMs }) => [startedAt, timeoutMs])).toEqual([
      [0, 45_000],
      [40_000, 45_000],
      [82_000, 8000],
    ]);

    // No time left to wait and call again, or to ask about the facts.
    const late = model([EMPTY, ALLOW], 89_000);
    expect(await judge(CALL, late.host)).toMatchObject({
      verdict: 'review',
      failure: 'empty-reply',
    });
    const facts = model([CHECK, ALLOW], 80_000, 10_000);
    expect(await judge(CALL, facts.host)).toMatchObject({ verdict: 'review', failure: 'timeout' });
    expect([late.calls.length, facts.calls.length]).toEqual([1, 1]);
  });
});
