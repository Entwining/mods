import { describe, expect, test } from 'claude-code/testing';
import type { Engine } from 'claude-code/testing';

import { auto, bash, check, promptOf, say, turnsOf } from './session.ts';
import { world } from './world.ts';

describe("answers to the agent's question", () => {
  const QUESTION = 'Which directories should go?';
  const questions = [
    {
      question: QUESTION,
      header: 'Cleanup',
      multiSelect: true,
      options: [
        { label: 'build, cache', description: 'rm -r build cache' },
        { label: 'notes', description: 'rm -r notes-old' },
      ],
    },
  ];
  const ask = ($: Engine, tool = 'AskUserQuestion') =>
    $.tool.call({ tool, questions, tool_use_id: 'q1' } as never);

  test("the answer, the person's notes and typed text, and the questions they were shown reach the judge as given", async ($, on) => {
    const answered = {
      answers: { [QUESTION]: 'build, cache, notes' },
      annotations: { [QUESTION]: { notes: 'keep the README in notes' } },
      response: 'and empty the trash',
    };
    // A hook beneath reworded what the person saw.
    const shown = [{ ...questions[0]!, question: 'Which build directories should go?' }];
    const w = world($, on, {
      classifierAllows: true,
      record: { questions: shown, ...answered },
    });
    await auto($);
    await say($, 'tidy the repository');
    await ask($);
    await check($, 'Bash', bash('rm -r build cache notes-old'));
    const [task, answer] = promptOf(w).user_messages;
    expect(task).toBe('tidy the repository');
    expect(answer!.startsWith("Answer to the agent's question: {")).toBe(true);
    expect(JSON.parse(answer!.slice(answer!.indexOf('{')))).toEqual({
      ...answered,
      questions: shown,
    });
  });

  test('another tool, a dialog resolved while the person was away, or one that failed holds no answer', async ($, on) => {
    const w = world($, on, {
      classifierAllows: true,
      record: { questions, answers: { [QUESTION]: 'notes' } },
    });
    await auto($);
    await say($, 'tidy the repository');
    await ask($, 'mcp__srv__ask');
    w.record = { questions, answers: { [QUESTION]: 'notes' }, afkTimeoutMs: 60_000 };
    await ask($);
    w.callFails = true;
    await ask($);
    expect(turnsOf(w)).toEqual(['tidy the repository']);
  });
});
