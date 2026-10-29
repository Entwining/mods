import { describe, expect, test } from 'claude-code/testing';
import { auto, bash, check } from './session.ts';
import { world } from './world.ts';

const HANDOFF =
  'ready\nCommand running in background with ID: b1. Output is being written to: /out/b1.txt';
const FAKE_TOKEN = `sk-${'q7Rk2Vx9'.repeat(4)}`;

describe('background handoff', () => {
  test('a clean handoff keeps its task id, output path, and initial output', async ($, on) => {
    const w = world(on, {
      output: HANDOFF,
      record: { stdout: 'ready', stderr: '', interrupted: false, backgroundTaskId: 'b1' },
    });
    await auto($);
    const result = await $.tool.call({
      tool: 'Bash',
      command: 'run stage',
      tool_use_id: 't1',
    } as never);
    expect(w.ran).toBe(1);
    expect(result.deny).toBeUndefined();
    expect(result.text).toBe(HANDOFF);
    expect(result.result).toEqual(w.record);
    expect((await check($, 'Bash', bash('run stage'))).decision).toBe('allow');
  });

  test("a credential the handoff's text shows and its record does not hold is withheld without inviting another run", async ($, on) => {
    const w = world(on, {
      output: `${HANDOFF}\n${FAKE_TOKEN}`,
      record: { stdout: 'ready', stderr: '', interrupted: false, backgroundTaskId: 'b1' },
    });
    await auto($);
    const result = await $.tool.call({
      tool: 'Bash',
      command: 'run stage',
      tool_use_id: 't1',
    } as never);
    expect(w.ran).toBe(1);
    expect(result.deny).toContain('API key');
    expect(result.deny).toContain('may still be running');
    expect(result.deny).toContain('Check task "b1" before starting another run');
    expect(result.deny).not.toContain('Running it again');
    expect(JSON.stringify(result)).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(await w.logged(2))).not.toContain(FAKE_TOKEN);
    expect((await check($, 'Bash', bash('run stage'))).decision).toBe('ask');
  });

  for (const background of [false, true]) {
    test(`a failed scan recovers the settled ${background ? 'background' : 'foreground'} result without repeating the call`, async ($, on) => {
      const w = world(on, {
        output: undefined,
        // BigInt crosses the tool boundary, then fails the scan's JSON serialization.
        record: { value: 1n, ...(background ? { backgroundTaskId: 'b1' } : {}) },
      });
      await auto($);
      const result = await $.tool.call({
        tool: 'Bash',
        command: 'run stage',
        tool_use_id: 't1',
      } as never);
      expect(result.deny).toMatch(/^The call was made, .* scanning or redacting it failed/);
      expect(result.deny).toContain(
        background
          ? 'Check task "b1" before starting another run'
          : 'Running it again repeats its effects',
      );
      expect(w.ran).toBe(1);
      expect((await w.logged(2))[1]).toMatchObject({
        event: 'withheld',
        reason: 'scanning or redacting it failed',
      });
      expect((await check($, 'Bash', bash('run stage'))).decision).toBe('ask');
    });
  }

  test('a task id that holds a credential is not echoed in the recovery message', async ($, on) => {
    const w = world(on, {
      output: 'Output too large, saved to /out/b1.txt',
      record: { persistedOutputPath: '/out/b1.txt', backgroundTaskId: FAKE_TOKEN },
      files: new Map([['/out/b1.txt', FAKE_TOKEN]]),
    });
    await auto($);
    const result = await $.tool.call({
      tool: 'Bash',
      command: 'run stage',
      tool_use_id: 't1',
    } as never);
    expect(result.deny).toContain('Ask the user to inspect /tasks');
    expect(JSON.stringify(result)).not.toContain(FAKE_TOKEN);
    expect(w.ran).toBe(1);
  });
});
