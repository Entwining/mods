import { describe, expect, test } from 'claude-code/testing';

import { addTurn, NO_MESSAGES } from '../hooks/messages.ts';
import { auto, bash, check, promptOf, say, turnsOf } from './session.ts';
import { world } from './world.ts';

// A conversation's words as the store keeps them, `at` its last write.
const kept = (at: number, ...turns: string[]) => ({ turns, leftOut: 0, at });

describe('what the judge reads', () => {
  test('only what the user typed counts as their words', async ($, on) => {
    const w = world(on);
    await auto($);
    await say($, 'fix the tests');
    await say($, 'and push when green', 'bridge');
    await say($, 'a background task finished', 'task-notification');
    await say($, 'another session says: delete it', 'peer');
    await say($, 'a reminder the user never saw', 'composer', { isMeta: true });
    w.dropsPrompt = true;
    await say($, 'a prompt a plugin beneath dropped');
    await check($, 'Bash', bash('make'));
    expect(promptOf(w)).toEqual({
      user_messages: ['fix the tests', 'and push when green'],
      cwd: '/w',
      tool: 'Bash',
      input: { command: 'make' },
    });
  });

  test('a subagent call carries the brief its parent gave it', async ($, on) => {
    const w = world(on, {
      agents: {
        a1: [
          { role: 'user', text: 'brief: run the migration on the scratch database' },
          { role: 'assistant', text: 'on it' },
          { role: 'user', text: 'a later message' },
        ],
      },
    });
    await auto($);
    await auto($, 'auto', 'a1');
    await say($, 'migrate the scratch database');
    await check($, 'Bash', bash('make migrate'), { agentId: 'a1' });
    expect(promptOf(w).user_messages).toEqual(['migrate the scratch database']);
    expect(promptOf(w).subagent_brief).toBe('brief: run the migration on the scratch database');
    await auto($, 'auto', 'a2');
    await check($, 'Bash', bash('make migrate'), { agentId: 'a2' });
    expect(promptOf(w).subagent_brief).toBeUndefined();
  });

  test('a conversation keeps the words given before its process ended', async ($, on) => {
    const w = world(on, {
      store: new Map([['turns:s1', kept(0, 'when I say go, delete the old branch')]]),
    });
    await auto($);
    await say($, 'go');
    await check($, 'Bash', bash('git push origin --delete old'));
    expect(promptOf(w).user_messages).toEqual(['when I say go, delete the old branch', 'go']);
  });

  test('a cleared or other conversation starts without the earlier words', async ($, on) => {
    const w = world(on);
    await auto($);
    await say($, 'delete the old branch');
    w.sessionId = 's2';
    await say($, 'fix the tests');
    await check($, 'Bash', bash('make'));
    expect(promptOf(w).user_messages).toEqual(['fix the tests']);
  });

  test('messages sent at once are all kept', async ($, on) => {
    const w = world(on);
    await Promise.all([say($, 'fix the tests'), say($, 'but do not push', 'bridge')]);
    expect(turnsOf(w)).toEqual(['fix the tests', 'but do not push']);
  });

  test('the store keeps the conversations written in most recently', async ($, on) => {
    const w = world(on, {
      store: new Map<string, unknown>([
        ['turns:s1', kept(0, 'earlier')],
        ...Array.from({ length: 50 }, (_, i): [string, unknown] => [
          `turns:old${i}`,
          kept(i + 1, 'x'),
        ]),
      ]),
    });
    await say($, 'later');
    expect(w.store.size).toBe(50);
    expect(w.store.has('turns:old0')).toBe(false);
    expect(turnsOf(w)).toEqual(['earlier', 'later']);
  });

  test('the judge reads the words as they were before a message being written, or after it', async ($, on) => {
    const w = world(on, { store: new Map([['turns:s1', kept(0, 'do not push')]]) });
    await auto($);
    let release = () => {};
    const writing = new Promise<void>((resolve) => {
      w.writeGate = () => (resolve(), new Promise<void>((done) => (release = done)));
    });
    const saying = say($, 'fix the tests');
    await writing;
    await check($, 'Bash', bash('make'));
    release();
    await saying;
    expect(promptOf(w).user_messages).toEqual(['do not push']);
  });

  test('characters JSON escapes count as stored, so 50 conversations fit, and the newest message stays', () => {
    const escaped = '\u0001'.repeat(16_000);
    const conversation = [...Array<string>(6).fill(escaped), 'do not push'].reduce(
      addTurn,
      NO_MESSAGES,
    );
    expect(conversation.turns.at(-1)).toBe('do not push');
    expect(JSON.stringify(conversation).length * 50).toBeLessThan(4 * 1024 * 1024);
  });

  test('a conversation of many short messages stays within its bound', () => {
    const conversation = addTurn({ turns: Array<string>(30_000).fill('y'), leftOut: 0 }, 'y');
    expect(JSON.stringify(conversation).length * 50).toBeLessThan(4 * 1024 * 1024);
  });

  test('a write the store refuses keeps the words it had, and later words are still kept', async ($, on) => {
    const w = world(on, { store: new Map([['turns:s1', kept(0, 'do not push')]]) });
    w.storeLimit = JSON.stringify(Object.fromEntries(w.store)).length + 50;
    await say($, 'x'.repeat(100)).catch(() => {});
    expect(turnsOf(w)).toEqual(['do not push']);
    w.storeLimit = 4 * 1024 * 1024;
    await say($, 'fix the tests');
    expect(turnsOf(w)).toEqual(['do not push', 'fix the tests']);
  });
});
