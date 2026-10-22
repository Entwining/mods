import { describe, expect, test } from 'claude-code/testing';

import { JUDGE_SYSTEM } from '../hooks/policy.ts';
import { auto, bash, check, promptOf, say } from './session.ts';
import { ALLOW, REVIEW, usageOf, world } from './world.ts';

describe('tool.check', () => {
  test('a call the judge allows runs without the classifier', async ($, on) => {
    const w = world(on);
    await auto($);
    await say($, 'set up the build');
    const result = await check($, 'Bash', bash('make setup'), { approver: 'person' });
    expect(result.decision).toBe('allow');
    expect(result.reason).toContain('a reversible step of the task');
    w.reply = REVIEW;
    expect((await check($, 'Bash', bash('make publish'), { tool_use_id: 't2' })).decision).toBe(
      'ask',
    );
  });

  test('the judge answers for every tool', async ($, on) => {
    const w = world(on);
    await auto($);
    expect((await check($, 'Agent', { prompt: 'do it' })).decision).toBe('allow');
    expect((await check($, 'mcp__srv__send', { to: 'x' })).decision).toBe('allow');
    expect(w.modelCalls.map((_, i) => promptOf(w, i).tool)).toEqual(['Agent', 'mcp__srv__send']);
  });

  test('a core allow or deny is never touched', async ($, on) => {
    const w = world(on, { core: { decision: 'deny', reason: 'rule' }, reply: ALLOW });
    await auto($);
    expect((await check($, 'Bash', bash('ls'))).decision).toBe('deny');
    w.core = { decision: 'allow' };
    w.reply = REVIEW;
    expect((await check($, 'Bash', bash('ls'))).decision).toBe('allow');
    expect(w.modelCalls).toHaveLength(0);
  });

  test('a tool whose verdict the engine keeps never reaches the judge', async ($, on) => {
    const w = world(on);
    await auto($);
    for (const tool of ['SubagentHandback', 'AskUserQuestion', 'ExitPlanMode']) {
      w.core = { decision: 'ask', reason: `synthetic reason for ${tool}` };
      expect(await check($, tool, {}, { tool_use_id: tool })).toEqual(w.core);
    }
    expect(w.modelCalls).toHaveLength(0);
    const lines = await w.logged(3);
    expect(lines.map((line) => [line.event, line.tool, line.coreReason])).toEqual([
      ['reserved', 'SubagentHandback', 'synthetic reason for SubagentHandback'],
      ['reserved', 'AskUserQuestion', 'synthetic reason for AskUserQuestion'],
      ['reserved', 'ExitPlanMode', 'synthetic reason for ExitPlanMode'],
    ]);
  });

  test('a call run in the background never reaches the judge', async ($, on) => {
    const w = world(on, { core: { decision: 'ask', reason: 'synthetic core reason' } });
    await auto($);
    const dev = { command: 'npm run dev', run_in_background: true };
    expect(await check($, 'Bash', dev)).toEqual(w.core);
    expect(w.modelCalls).toHaveLength(0);
    const [line] = await w.logged(1);
    expect([line!.event, line!.tool, line!.coreReason]).toEqual([
      'background',
      'Bash',
      'synthetic core reason',
    ]);
  });

  test('sandbox commands requesting network grants are left to the classifier', async ($, on) => {
    const w = world(on);
    await auto($);
    for (const tool of ['Bash', 'PowerShell', 'Monitor']) {
      const input = { command: 'curl https://example.com', allowed_domains: ['example.com'] };
      expect(await check($, tool, input, { tool_use_id: tool })).toEqual(w.core);
    }
    expect(w.modelCalls).toHaveLength(0);
    const lines = await w.logged(3);
    expect(lines.map((line) => [line.event, line.tool])).toEqual([
      ['network', 'Bash'],
      ['network', 'PowerShell'],
      ['network', 'Monitor'],
    ]);
  });

  test('empty network grants and search domain filters still reach the judge', async ($, on) => {
    const w = world(on);
    await auto($);
    expect((await check($, 'Bash', { command: 'make', allowed_domains: [] })).decision).toBe(
      'allow',
    );
    expect(
      (await check($, 'WebSearch', { query: 'example', allowed_domains: ['example.com'] }))
        .decision,
    ).toBe('allow');
    expect(w.modelCalls).toHaveLength(2);
  });

  test('each loop is judged only in its own auto mode', async ($, on) => {
    const w = world(on);
    expect((await check($, 'Bash', bash('make'))).decision).toBe('ask');
    // A tool's own arguments, which `classic.PreToolUse` carries, are not a
    // mode report.
    await $.tool.call({
      tool: 'Bash',
      command: 'make',
      permission_mode: 'auto',
      tool_use_id: 't0',
    } as never);
    expect((await check($, 'Bash', bash('make'))).decision).toBe('ask');
    await auto($, 'default');
    expect((await check($, 'Bash', bash('make'))).decision).toBe('ask');
    await auto($);
    // A classic event that reports no mode leaves the loop's mode as it was.
    await $.classic.UserPromptSubmit({ prompt: '' } as never);
    expect((await check($, 'Bash', bash('make'))).decision).toBe('allow');
    const sub = { agentId: 'a1' };
    expect((await check($, 'Bash', bash('make'), sub)).decision).toBe('ask');
    await auto($, 'auto', 'a1');
    expect((await check($, 'Bash', bash('make'), sub)).decision).toBe('allow');
    await auto($, 'default', 'a2');
    expect((await check($, 'Bash', bash('make'), { agentId: 'a2' })).decision).toBe('ask');
    expect(w.ran).toBe(0);
  });

  test('a judge that gives no reply leaves the call to the classifier, saying why and what the call cost', async ($, on) => {
    const w = world(on, { reply: undefined });
    await auto($);
    expect((await check($, 'Bash', bash('make'))).decision).toBe('ask');
    const [line] = await w.logged(1);
    expect([line!.verdict, line!.reason, line!.usage]).toEqual([
      'review',
      expect.stringContaining('api-error invalid_request (400)'),
      [usageOf(1)],
    ]);
  });

  test(
    'the judge runs on the model and effort the user set, as written, with a time limit and its policy cached',
    {
      options: { model: 'some-model-id', effort: 'some-effort' },
    },
    async ($, on) => {
      const w = world(on);
      await auto($);
      await check($, 'Bash', bash('make'));
      expect(w.modelCalls.map(({ model, effort }) => [model, effort])).toEqual([
        ['some-model-id', 'some-effort'],
      ]);
      expect(w.modelCalls[0]!.timeoutMs).toBeGreaterThan(0);
      expect(w.modelCalls[0]!.systemBlocks).toEqual([{ text: JUDGE_SYSTEM, cache: true }]);
    },
  );

  test(
    'an emptied setting leaves the judge on its default',
    {
      options: { model: '', effort: '' },
    },
    async ($, on) => {
      const w = world(on);
      await auto($);
      await check($, 'Bash', bash('make'));
      expect(w.modelCalls[0]!.model).not.toBe('');
      expect(w.modelCalls[0]!.effort).not.toBe('');
    },
  );
});
