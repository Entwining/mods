import { describe, expect, test } from 'claude-code/testing';

import { auto, bash, check } from './session.ts';
import { DENIAL, ENGINE_VERSION, LOG, REFUSAL, REVIEW, usageOf, world } from './world.ts';

const LOG_PART_1 = '/home/u/.claude/preallow/s1.1.jsonl';

describe('the log', () => {
  test('each decision is logged with its verdict and why the core asked', async ($, on) => {
    const w = world($, on, { core: { decision: 'ask', reason: 'synthetic core reason' } });
    await auto($);
    await check($, 'Bash', bash('make setup'));
    const [line] = await w.logged(1);
    expect([
      line!.event,
      line!.tool,
      line!.verdict,
      line!.input,
      line!.coreReason,
      line!.engine,
    ]).toEqual([
      'check',
      'Bash',
      'allow',
      '{"command":"make setup"}',
      'synthetic core reason',
      ENGINE_VERSION,
    ]);
  });

  test('a check line carries what each judge call cost and the settings it ran on', async ($, on) => {
    const w = world($, on, {
      replies: [JSON.stringify({ reason: 'r', verdict: 'check', check: [{ path: '/w' }] })],
    });
    await auto($);
    await check($, 'Bash', bash('rm -r build'));
    const [line] = await w.logged(1);
    const { model, effort } = w.modelCalls[0]!;
    expect([line!.model, line!.effort, line!.usage]).toEqual([
      model,
      effort,
      [usageOf(1), usageOf(2)],
    ]);
  });

  test('a call the judge passed and the classifier denied is logged', async ($, on) => {
    const w = world($, on, { reply: REVIEW });
    await auto($);
    const result = await $.tool.call({ tool: 'Bash', command: 'make', tool_use_id: 't1' } as never);
    expect(result.text).toBe(DENIAL);
    expect(w.modelCalls).toHaveLength(1);
    const lines = await w.logged(2);
    expect(lines.map((line) => [line.event, line.tool_use_id, line.verdict])).toEqual([
      ['check', 't1', 'pass'],
      ['denied', 't1', undefined],
    ]);
    expect(lines[1]!.denial).toContain('[Synthetic]');

    // Denied without the judge, then a later call judged and denied.
    await $.tool.call({
      tool: 'Bash',
      command: 'make',
      run_in_background: true,
      tool_use_id: 't2',
    } as never);
    await $.tool.call({ tool: 'Bash', command: 'make', tool_use_id: 't3' } as never);
    const later = await w.logged(5);
    expect(later.slice(2).map((line) => [line.event, line.tool_use_id])).toEqual([
      ['background', 't2'],
      ['check', 't3'],
      ['denied', 't3'],
    ]);
  });

  test('an allow the engine refuses is logged, and the call run again goes to the core', async ($, on) => {
    const w = world($, on, { engineRefuses: true });
    await auto($);
    const result = await $.tool.call({ tool: 'mcp__srv__handoff', tool_use_id: 't1' } as never);
    expect(result.text).toBe(REFUSAL);
    const lines = await w.logged(2);
    expect(lines.map((line) => [line.event, line.tool_use_id, line.verdict])).toEqual([
      ['check', 't1', 'allow'],
      ['refused', 't1', undefined],
    ]);
    expect(lines[1]!.refusal).toBe(REFUSAL);
    expect((await check($, 'mcp__srv__handoff', {}, { tool_use_id: 't2' })).decision).toBe('ask');
    expect(w.modelCalls).toHaveLength(1);
  });

  test('a call the plugin allowed that printed what a refusal says is not logged as refused', async ($, on) => {
    const w = world($, on, { output: REFUSAL });
    await auto($);
    const call = (id: string) =>
      $.tool.call({ tool: 'Bash', command: 'make', tool_use_id: id } as never);
    await call('t1');
    // A later line, so a wrong `refused` line for t1 would come before it.
    await call('t2');
    const lines = await w.logged(2);
    expect(lines.map((line) => line.event)).toEqual(['check', 'check']);
  });

  test('decisions made at once are all logged', async ($, on) => {
    const w = world($, on);
    await auto($);
    await Promise.all([
      check($, 'Bash', bash('make a')),
      check($, 'Bash', bash('make b'), { tool_use_id: 't2' }),
    ]);
    const lines = await w.logged(2);
    expect(lines.map((line) => line.tool_use_id).toSorted()).toEqual(['t1', 't2']);
  });

  test('without HOME nothing is logged', async ($, on) => {
    const w = world($, on, { env: {} });
    await auto($);
    await check($, 'Bash', bash('make'));
    await check($, 'Bash', bash('make b'), { tool_use_id: 't2' });
    expect([...w.files.keys()]).toEqual([]);
  });

  test('a log write that fails leaves later lines to be written', async ($, on) => {
    const w = world($, on, { failWrites: 1 });
    await auto($);
    await check($, 'Bash', bash('make a'));
    await check($, 'Bash', bash('make b'), { tool_use_id: 't2' });
    const [line] = await w.logged(1);
    expect(line!.tool_use_id).toBe('t2');
  });

  test('a full log part rolls over to the next, and a long input is cut', async ($, on) => {
    const full = `${JSON.stringify({ event: 'check', input: 'x'.repeat(1000) })}\n`.repeat(1000);
    const w = world($, on, { files: new Map([[LOG, full]]) });
    await auto($);
    await check($, 'Bash', bash('x'.repeat(5000)));
    const [line] = await w.logged(1, LOG_PART_1);
    expect((line!.input as string).length).toBeLessThanOrEqual(2000);
    expect(w.files.get(LOG)).toBe(full);
  });
});
