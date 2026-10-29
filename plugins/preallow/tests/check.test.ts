import { describe, expect, test } from 'claude-code/testing';

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

  test('a call auto mode denied, made again unchanged, goes to the classifier until the user speaks', async ($, on) => {
    const w = world(on, { reply: REVIEW });
    await auto($);
    await say($, 'tidy the repository');
    const clean = bash('make clean');
    await check($, 'Bash', clean);
    await $.classic.PermissionDenied({
      tool_name: 'Bash',
      tool_input: clean,
      tool_use_id: 't1',
      reason: '[Synthetic]',
    });
    // A review auto mode did not deny leaves the call to the judge.
    await check($, 'Bash', bash('make lint'), { tool_use_id: 't2' });
    w.reply = ALLOW;
    expect(await check($, 'Bash', clean, { tool_use_id: 't3' })).toEqual(w.core);
    expect((await check($, 'Bash', bash('make lint'), { tool_use_id: 't4' })).decision).toBe(
      'allow',
    );
    await say($, 'clean it anyway');
    expect((await check($, 'Bash', clean, { tool_use_id: 't5' })).decision).toBe('allow');
    // Each review by both stages, then two allows by the first.
    expect(w.modelCalls).toHaveLength(6);
    const lines = await w.logged(6);
    expect(lines.map((line) => [line.event, line.tool_use_id])).toEqual([
      ['judged', 't1'],
      ['denied', 't1'],
      ['judged', 't2'],
      ['repeated', 't3'],
      ['judged', 't4'],
      ['judged', 't5'],
    ]);
  });

  test('a judge that gives no reply leaves the call to the classifier, saying why and what the call cost', async ($, on) => {
    const w = world(on, { reply: undefined });
    await auto($);
    expect((await check($, 'Bash', bash('make'))).decision).toBe('ask');
    const [line] = await w.logged(1);
    expect([line!.verdict, line!.isAnswered, line!.failure, line!.usage]).toEqual([
      'review',
      false,
      'api-error invalid_request (400)',
      [usageOf(1)],
    ]);
  });

  test("an empty reply is asked again after a wait on the session's clock", async ($, on) => {
    const w = world(on, { replies: [{ reason: 'empty-reply' }] });
    await auto($);
    const checked = check($, 'Bash', bash('make'));
    await w.clock.settle();
    expect(w.modelCalls).toHaveLength(1);
    await w.clock.advance(2000);
    expect((await checked).decision).toBe('allow');
    const [line] = await w.logged(1);
    expect([line!.isAnswered, line!.failure, line!.retried, line!.usage]).toEqual([
      true,
      undefined,
      ['empty-reply'],
      [usageOf(1), usageOf(2)],
    ]);
  });
});
