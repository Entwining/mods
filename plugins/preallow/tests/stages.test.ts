import { describe, expect, test } from 'claude-code/testing';

import { JUDGE_SYSTEM } from '../hooks/policy.ts';
import { auto, bash, check } from './session.ts';
import { ALLOW, REVIEW, usageOf, world } from './world.ts';

const checkReply = (ref: string) =>
  JSON.stringify({ reason: 'unsure', verdict: 'check', check: [{ repo: '/w', ref }] });

describe('the judge stages', () => {
  test('only a call the first stage did not allow, failures included, is judged again from the start, and that verdict is final', async ($, on) => {
    const w = world(on, {
      git: {
        // A missing ref.
        'rev-parse --verify --quiet origin/gone^{commit}': { exitCode: 1, stdout: '' },
      },
    });
    await auto($);
    expect((await check($, 'Bash', bash('make'), { tool_use_id: 'allowed' })).decision).toBe(
      'allow',
    );
    expect(w.modelCalls).toHaveLength(1);
    const outcomes = [
      ['review', [REVIEW]],
      ['unsure check', [checkReply('origin/gone'), checkReply('origin/gone')]],
      ['no reply', [undefined]],
    ] as const;
    for (const [i, [outcome, replies]] of outcomes.entries()) {
      const before = w.modelCalls.length;
      w.replies = [...replies, ALLOW];
      const result = await check($, 'Bash', bash(`make ${i}`), { tool_use_id: `t${i}` });
      expect([outcome, result.decision]).toEqual([outcome, 'allow']);
      const escalated = before + replies.length;
      expect(w.modelCalls.length).toBe(escalated + 1);
      expect(w.modelCalls[escalated]!.prompt).toBe(w.modelCalls[before]!.prompt);
    }

    w.replies = [REVIEW, REVIEW];
    expect((await check($, 'Bash', bash('make publish'), { tool_use_id: 'last' })).decision).toBe(
      'ask',
    );
    const lines = await w.logged(outcomes.length + 2);
    expect(
      lines.map((line) => [
        line.verdict,
        (line.escalation as { verdict: string } | undefined)?.verdict,
      ]),
    ).toEqual([
      ['allow', undefined],
      ...outcomes.map(() => ['review', 'allow']),
      ['review', 'review'],
    ]);
    const { model, effort, usage } = lines[1]!.escalation as Record<string, unknown>;
    expect([model, effort, usage]).toEqual([
      w.modelCalls[2]!.model,
      w.modelCalls[2]!.effort,
      [usageOf(3)],
    ]);
  });

  test('a call too long to ask the first stage about is not passed to the second', async ($, on) => {
    const w = world(on, {});
    await auto($);
    const input = { file_path: '/w/a', content: 'x'.repeat(100_001) };
    expect((await check($, 'Write', input)).decision).toBe('ask');
    const [line] = await w.logged(1);
    expect([line!.reason, line!.escalation]).toEqual([
      expect.stringMatching(/too long/),
      undefined,
    ]);
  });

  test(
    'a judge model the user set has no second stage, whatever escalation effort is set',
    { options: { model: 'some-model-id', escalation_effort: 'some-effort' } },
    async ($, on) => {
      const w = world(on, { reply: REVIEW });
      await auto($);
      expect((await check($, 'Bash', bash('make'))).decision).toBe('ask');
      expect(w.modelCalls).toHaveLength(1);
    },
  );

  test(
    'both stages run on the models and efforts the user set, as written, with a time limit and their policy cached',
    {
      options: {
        model: 'some-model-id',
        effort: 'some-effort',
        escalation_model: 'other-model-id',
        escalation_effort: 'other-effort',
      },
    },
    async ($, on) => {
      const w = world(on, { reply: REVIEW });
      await auto($);
      await check($, 'Bash', bash('make'));
      expect(w.modelCalls.map(({ model, effort }) => [model, effort])).toEqual([
        ['some-model-id', 'some-effort'],
        ['other-model-id', 'other-effort'],
      ]);
      for (const { timeoutMs, systemBlocks } of w.modelCalls) {
        expect(timeoutMs).toBeGreaterThan(0);
        expect(systemBlocks).toEqual([{ text: JUDGE_SYSTEM, cache: true }]);
      }
    },
  );

  test(
    'emptied settings leave both stages on their defaults',
    {
      options: { model: '', effort: '', escalation_model: '', escalation_effort: '' },
    },
    async ($, on) => {
      const w = world(on, { reply: REVIEW });
      await auto($);
      await check($, 'Bash', bash('make'));
      expect(w.modelCalls.map(({ model, effort }) => [model, effort])).toEqual([
        ['haiku', 'high'],
        ['opus', 'medium'],
      ]);
    },
  );
});
