import { describe, expect, test } from 'claude-code/testing';
import type { ToolCheckResult } from 'claude-code';

import { auto, bash, check } from './session.ts';
import { world } from './world.ts';

describe('approval ownership', () => {
  test("an ask from a settings rule, a hook, an option's own check, a host, or an organization ceiling is left to the core, and logged", async ($, on) => {
    const w = world(on);
    await auto($);
    const asks: Array<[ToolCheckResult, Record<string, unknown>]> = [
      [{ decision: 'ask', rule: 'Bash(make:*)' }, {}],
      [{ decision: 'ask', hook: 'PreToolUse' }, {}],
      [{ decision: 'ask', setting: 'permissions.blockReadsOutsideWorkingDirectories' }, {}],
      [{ decision: 'ask' }, { approver: 'host' }],
      [{ decision: 'ask' }, { ceiling: 'ask' }],
    ];
    for (const [i, [core, call]] of asks.entries()) {
      w.core = { ...core, reason: 'synthetic core reason' };
      expect(await check($, 'Bash', bash('make'), { tool_use_id: `t${i}`, ...call })).toMatchObject(
        w.core,
      );
    }
    expect(w.modelCalls).toHaveLength(0);
    const lines = await w.logged(5);
    expect(lines.map((line) => [line.event, line.ownedBy, line[line.ownedBy as string]])).toEqual([
      ['owned', 'rule', 'Bash(make:*)'],
      ['owned', 'hook', 'PreToolUse'],
      ['owned', 'setting', 'permissions.blockReadsOutsideWorkingDirectories'],
      ['owned', 'approver', 'host'],
      ['owned', 'ceiling', 'ask'],
    ]);
    expect(lines.every((line) => line.coreReason === 'synthetic core reason')).toBe(true);
  });

  test(
    'an ask made by another plugin is left to that plugin',
    {
      plugins: [
        {
          name: 'gate',
          tier: 'append',
          register(on) {
            on('tool.check', async (_$, e, next) => {
              await next(e);
              return { decision: 'ask', reason: 'synthetic plugin ask' };
            });
          },
        },
      ],
    },
    async ($, on) => {
      const w = world(on);
      await auto($);
      expect(await check($, 'Bash', bash('make'))).toMatchObject({
        decision: 'ask',
        plugin: 'gate',
        reason: 'synthetic plugin ask',
      });
      expect(w.modelCalls).toHaveLength(0);
      expect((await w.logged(1))[0]).toMatchObject({
        event: 'owned',
        ownedBy: 'plugin',
        plugin: 'gate',
      });
    },
  );
});
