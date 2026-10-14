import { describe, expect, mock, test } from 'claude-code/testing';
import type { Engine } from 'claude-code/testing';
import type { On, ToolCheckResult } from 'claude-code';
import { JUDGE_SYSTEM } from '../hooks/judge.ts';

type World = {
  core: ToolCheckResult;
  // The judge's reply; undefined answers no text, as an API error does.
  // Queued replies are given first, one per model call.
  reply: string | undefined;
  replies: Array<string | undefined>;
  modelFails: boolean;
  modelCalls: Array<{
    model: string;
    effort?: string;
    system: string;
    prompt: string;
    timeoutMs?: number;
  }>;
  // Each subagent's loop, by agent id; without one, the main loop's.
  agents: Record<string, Array<{ role: 'user' | 'assistant'; text: string }>>;
  files: Map<string, string>;
  // Answers to `$.process.run`, by the arguments after git's fixed options;
  // anything else exits 0 with no output.
  git: Record<string, { exitCode: number; stdout: string }>;
  // Whether the classifier lets a call the check asked about run.
  classifierAllows: boolean;
  // Whether the engine refuses a hook's allow, as for a tool only the
  // classifier may allow.
  engineRefuses: boolean;
  dropsPrompt: boolean;
  callFails: boolean;
  // The tool's output as the model reads it; undefined for a result a hook
  // gave, which carries no text.
  output: string | undefined;
  // The tool's own record, when it differs from the output text.
  record: unknown;
  // What the model reads beside the result.
  context: string[] | undefined;
  ran: number;
  sessionId: string;
  // The plugin's store, in insertion order, and how many characters of JSON
  // it takes before it refuses a write.
  store: Map<string, unknown>;
  storeLimit: number;
  // Awaited by every store write before it lands.
  writeGate: (() => Promise<void>) | undefined;
  // Resolves once the session's log, or the part at `path`, holds `count` lines.
  logged: (count: number, path?: string) => Promise<Array<Record<string, unknown>>>;
};

const ALLOW = JSON.stringify({ reason: 'a reversible step of the task', verdict: 'allow' });
const REVIEW = JSON.stringify({ reason: 'sends a message nobody asked for', verdict: 'review' });
// Built at run time, so no scanner takes the source for a leaked token.
const FAKE_TOKEN = `ghp_${'x'.repeat(36)}`;
const LOG = '/home/u/.claude/preallow/s1.jsonl';
const LOG_PART_1 = '/home/u/.claude/preallow/s1.1.jsonl';
const REFUSAL =
  "Only the auto-mode classifier can allow mcp__srv__handoff: an allow of type 'hook' is not the classifier's verdict";
const DENIAL =
  "Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Synthetic]. If you have other tasks that don't depend on this action, continue working on those.";

// Everything beneath the plugin: the engine's own decision, the judge model,
// subagent transcripts, and an in-memory log folder. A tool call asks for its
// permission under its own id, as a session does beneath every plugin's
// `tool.call` hook; an ask the classifier denies comes back as the error text
// the core reports, with no `deny` field.
function world($: Engine, on: On, partial: Partial<World> = {}): World {
  const waiters: Array<[number, string, (lines: Array<Record<string, unknown>>) => void]> = [];
  const lines = (path: string) =>
    (w.files.get(path) ?? '')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  const w: World = {
    core: { decision: 'ask' },
    reply: ALLOW,
    replies: [],
    modelFails: false,
    modelCalls: [],
    agents: {},
    files: new Map(),
    git: {},
    classifierAllows: false,
    engineRefuses: false,
    dropsPrompt: false,
    callFails: false,
    output: 'ok',
    record: undefined,
    context: undefined,
    ran: 0,
    sessionId: 's1',
    store: new Map(),
    storeLimit: 4 * 1024 * 1024,
    writeGate: undefined,
    logged: (count, path = LOG) =>
      new Promise((resolve) =>
        lines(path).length >= count ? resolve(lines(path)) : waiters.push([count, path, resolve]),
      ),
    ...partial,
  };
  mock.env(on, { HOME: '/home/u' });
  on('classic.UserPromptSubmit', async () => ({}));
  on('classic.SubagentStart', async () => ({}));
  on('tool.check', async () => w.core);
  on('session.id', async () => ({ value: w.sessionId }));
  on('store.get', async (_$, e) => ({ value: w.store.get(e.key) }) as never);
  on('store.set', async (_$, e) => {
    await w.writeGate?.();
    const next = new Map(w.store).set(e.key, e.value);
    if (JSON.stringify(Object.fromEntries(next)).length > w.storeLimit)
      throw new Error('store over its limit');
    w.store = next;
    return { value: undefined } as never;
  });
  on('store.delete', async (_$, e) => {
    w.store.delete(e.key);
    return { value: undefined } as never;
  });
  on('store.keys', async () => ({ value: [...w.store.keys()] }) as never);
  on('session.messages', async (_$, e) => {
    const { agentId } = (e ?? {}) as { agentId?: string };
    const rows =
      agentId === undefined
        ? [{ role: 'user' as const, text: 'the main conversation' }]
        : w.agents[agentId];
    return {
      value:
        rows === undefined
          ? { deny: 'unknown agent' }
          : rows.map((row) => ({ ...row, toolUses: [] })),
    } as never;
  });
  on('model.complete', async (_$, e) => {
    const { model, effort, system, prompt, timeoutMs } = e as {
      model: string;
      effort?: string;
      system: string;
      prompt: string;
      timeoutMs?: number;
    };
    w.modelCalls.push({ model, effort, system, prompt, timeoutMs });
    if (w.modelFails) return { deny: 'model unavailable' } as never;
    const reply = w.replies.length > 0 ? w.replies.shift() : w.reply;
    return {
      value:
        reply === undefined
          ? {
              isAnswered: false,
              reason: 'api-error',
              error: 'invalid_request',
              status: 400,
              usage: {},
            }
          : { isAnswered: true, text: reply, usage: {} },
    } as never;
  });
  on('session.cwd', async () => ({ value: '/w' }) as never);
  on('session.usage', async () => ({ value: { startedAt: 0 } }) as never);
  on('process.run', async (_$, e) => {
    const { argv } = e as { argv: readonly string[] };
    const answer = w.git[argv.slice(7).join(' ')] ?? { exitCode: 0, stdout: '' };
    return { value: { ...answer, stderr: '', isStdoutTruncated: false } } as never;
  });
  on('fs.exists', async (_$, e) => ({ value: w.files.has(e.path) }));
  on('fs.read', async (_$, e) => {
    if (!w.files.has(e.path)) throw new Error(`no such file: ${e.path}`);
    return { value: w.files.get(e.path) } as never;
  });
  on(
    'fs.stat',
    async (_$, e) =>
      ({ value: { kind: 'file', size: (w.files.get(e.path) ?? '').length, mtimeMs: 0 } }) as never,
  );
  on('fs.write', async (_$, e) => {
    w.files.set(e.path, e.text);
    for (const waiter of waiters.filter(([count, path]) => lines(path).length >= count)) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter[2](lines(waiter[1]));
    }
    return { value: undefined } as never;
  });
  on('prompt.submit', async (_$, e) =>
    w.dropsPrompt ? { drop: 'blocked beneath' } : { text: e.text },
  );
  on('session.end', async () => ({ sessionId: 's1' }) as never);
  on('tool.call', async (_$, e) => {
    const { tool, tool_use_id, agentId, ...input } = e as {
      tool: string;
      tool_use_id: string;
      agentId?: string;
    };
    const { decision } = await $.tool.check({
      tool,
      input,
      tool_use_id,
      ...(agentId === undefined ? {} : { agentId }),
    } as never);
    if (decision === 'deny') return { deny: 'denied by a rule' } as never;
    if (decision === 'allow' && w.engineRefuses)
      return { isError: true, result: REFUSAL, text: REFUSAL } as never;
    if (decision === 'ask' && !w.classifierAllows)
      return { isError: true, result: `Error: ${DENIAL}`, text: DENIAL } as never;
    w.ran++;
    if (w.callFails) return { isError: true, result: 'exit 1', text: 'exit 1' } as never;
    return { result: w.record ?? w.output, text: w.output, context: w.context } as never;
  });
  return w;
}

async function auto($: Engine, mode = 'auto', agentId?: string) {
  if (agentId === undefined)
    await $.classic.UserPromptSubmit({ prompt: '', permission_mode: mode } as never);
  else
    await $.classic.SubagentStart({
      agent_id: agentId,
      agent_type: 'x',
      permission_mode: mode,
    } as never);
}

function check(
  $: Engine,
  tool: string,
  input: Record<string, unknown>,
  call: Record<string, unknown> = {},
): Promise<ToolCheckResult> {
  return $.tool.check({ tool, input, tool_use_id: 't1', ...call } as never);
}

const bash = (command: string) => ({ command });

// A conversation's words as the store keeps them, `at` its last write.
const kept = (at: number, ...turns: string[]) => ({ turns, leftOut: 0, at });
const turnsOf = (w: World, session = 's1') =>
  (w.store.get(`turns:${session}`) as { turns: string[] } | undefined)?.turns;

function say($: Engine, text: string, kind = 'composer', extra: Record<string, unknown> = {}) {
  return $.prompt.submit({ text, wait: false, origin: { kind }, ...extra } as never);
}

function judged(w: World, index = -1) {
  return JSON.parse(w.modelCalls.at(index)!.prompt) as {
    user_messages: string[];
    subagent_brief?: string;
    tool: string;
    input: unknown;
    facts?: { answers: unknown[] };
  };
}

describe('the judge', () => {
  test('a call the judge allows runs without the classifier', async ($, on) => {
    const w = world($, on);
    await auto($);
    await say($, 'set up the build');
    const result = await check($, 'Bash', bash('make setup'));
    expect(result.decision).toBe('allow');
    expect(result.reason).toContain('a reversible step of the task');
    w.reply = REVIEW;
    expect((await check($, 'Bash', bash('make publish'), { tool_use_id: 't2' })).decision).toBe(
      'ask',
    );
  });

  test('the judge answers for every tool', async ($, on) => {
    const w = world($, on);
    await auto($);
    expect((await check($, 'Agent', { prompt: 'do it' })).decision).toBe('allow');
    expect((await check($, 'mcp__srv__send', { to: 'x' })).decision).toBe('allow');
    expect(w.modelCalls.map((_, i) => judged(w, i).tool)).toEqual(['Agent', 'mcp__srv__send']);
  });

  test('a core allow or deny is never touched', async ($, on) => {
    const w = world($, on, { core: { decision: 'deny', reason: 'rule' }, reply: ALLOW });
    await auto($);
    expect((await check($, 'Bash', bash('ls'))).decision).toBe('deny');
    w.core = { decision: 'allow' };
    w.reply = REVIEW;
    expect((await check($, 'Bash', bash('ls'))).decision).toBe('allow');
    expect(w.modelCalls).toHaveLength(0);
  });

  test('an ask from a settings rule, a hook, or an organization ceiling is left to the core', async ($, on) => {
    const w = world($, on, { core: { decision: 'ask', rule: 'Bash(make:*)' } });
    await auto($);
    expect((await check($, 'Bash', bash('make'))).decision).toBe('ask');
    w.core = { decision: 'ask', hook: 'PreToolUse' };
    expect((await check($, 'Bash', bash('make'))).decision).toBe('ask');
    w.core = { decision: 'ask' };
    expect((await check($, 'Bash', bash('make'), { ceiling: 'ask' })).decision).toBe('ask');
    expect(w.modelCalls).toHaveLength(0);
  });

  test('a tool whose verdict the engine keeps never reaches the judge', async ($, on) => {
    const w = world($, on);
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
    const w = world($, on, { core: { decision: 'ask', reason: 'synthetic core reason' } });
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

  test('each loop is judged only in its own auto mode', async ($, on) => {
    const w = world($, on);
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
    const sub = { agentId: 'a1' };
    expect((await check($, 'Bash', bash('make'), sub)).decision).toBe('ask');
    await auto($, 'auto', 'a1');
    expect((await check($, 'Bash', bash('make'), sub)).decision).toBe('allow');
    await auto($, 'default', 'a2');
    expect((await check($, 'Bash', bash('make'), { agentId: 'a2' })).decision).toBe('ask');
    expect(w.ran).toBe(0);
  });

  for (const [name, change, why] of [
    ['gives no reply', (w: World) => (w.reply = undefined), 'api-error invalid_request (400)'],
    ['fails', (w: World) => (w.modelFails = true), 'model unavailable'],
  ] as const) {
    test(`a judge that ${name} leaves the call to the classifier, saying why`, async ($, on) => {
      const w = world($, on);
      change(w);
      await auto($);
      expect((await check($, 'Bash', bash('make'))).decision).toBe('ask');
      const [line] = await w.logged(1);
      expect([line!.verdict, line!.reason]).toEqual(['pass', expect.stringContaining(why)]);
    });
  }

  test(
    'the judge runs on the model and effort the user set, as written, with a time limit',
    {
      options: { model: 'some-model-id', effort: 'some-effort' },
    },
    async ($, on) => {
      const w = world($, on);
      await auto($);
      await check($, 'Bash', bash('make'));
      expect(w.modelCalls.map(({ model, effort }) => [model, effort])).toEqual([
        ['some-model-id', 'some-effort'],
      ]);
      expect(w.modelCalls[0]!.timeoutMs).toBeGreaterThan(0);
    },
  );

  test(
    'an emptied setting leaves the judge on its default',
    {
      options: { model: '', effort: '' },
    },
    async ($, on) => {
      const w = world($, on);
      await auto($);
      await check($, 'Bash', bash('make'));
      expect(w.modelCalls[0]!.model).not.toBe('');
      expect(w.modelCalls[0]!.effort).not.toBe('');
    },
  );

  test('each decision is logged with its verdict and why the core asked', async ($, on) => {
    const w = world($, on, { core: { decision: 'ask', reason: 'synthetic core reason' } });
    await auto($);
    await check($, 'Bash', bash('make setup'));
    const [line] = await w.logged(1);
    expect([line!.event, line!.tool, line!.verdict, line!.input, line!.coreReason]).toEqual([
      'check',
      'Bash',
      'allow',
      '{"command":"make setup"}',
      'synthetic core reason',
    ]);
  });
});

describe('what the judge reads', () => {
  test('only what the user typed counts as their words', async ($, on) => {
    const w = world($, on);
    await auto($);
    await say($, 'fix the tests');
    await say($, 'and push when green', 'bridge');
    await say($, 'a background task finished', 'task-notification');
    await say($, 'another session says: delete it', 'peer');
    await say($, 'a reminder the user never saw', 'composer', { isMeta: true });
    w.dropsPrompt = true;
    await say($, 'a prompt a plugin beneath dropped');
    await check($, 'Bash', bash('make'));
    expect(judged(w)).toEqual({
      user_messages: ['fix the tests', 'and push when green'],
      cwd: '/w',
      tool: 'Bash',
      input: { command: 'make' },
    });
    expect(w.modelCalls[0]!.system).toBe(JUDGE_SYSTEM);
  });

  test('a subagent call carries the brief its parent gave it', async ($, on) => {
    const w = world($, on, {
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
    expect(judged(w).user_messages).toEqual(['migrate the scratch database']);
    expect(judged(w).subagent_brief).toBe('brief: run the migration on the scratch database');
    await auto($, 'auto', 'a2');
    await check($, 'Bash', bash('make migrate'), { agentId: 'a2' });
    expect(judged(w).subagent_brief).toBeUndefined();
  });

  test('a conversation keeps the words given before its process ended', async ($, on) => {
    const w = world($, on, {
      store: new Map([['turns:s1', kept(0, 'when I say go, delete the old branch')]]),
    });
    await auto($);
    await say($, 'go');
    await $.session.end({ reason: 'prompt_input_exit' } as never);
    await check($, 'Bash', bash('git push origin --delete old'));
    expect(judged(w).user_messages).toEqual(['when I say go, delete the old branch', 'go']);
  });

  test('a cleared or other conversation starts without the earlier words', async ($, on) => {
    const w = world($, on);
    await auto($);
    await say($, 'delete the old branch');
    w.sessionId = 's2';
    await say($, 'fix the tests');
    await check($, 'Bash', bash('make'));
    expect(judged(w).user_messages).toEqual(['fix the tests']);
  });

  test('messages sent at once are all kept', async ($, on) => {
    const w = world($, on);
    await Promise.all([say($, 'fix the tests'), say($, 'but do not push', 'bridge')]);
    expect(turnsOf(w)).toEqual(['fix the tests', 'but do not push']);
  });

  test('the store keeps the conversations written in most recently', async ($, on) => {
    const w = world($, on, {
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
    const w = world($, on, { store: new Map([['turns:s1', kept(0, 'do not push')]]) });
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
    expect(judged(w).user_messages).toEqual(['do not push']);
  });

  test('a write the store refuses keeps the words it had, and later words are still kept', async ($, on) => {
    const w = world($, on, { store: new Map([['turns:s1', kept(0, 'do not push')]]) });
    w.storeLimit = JSON.stringify(Object.fromEntries(w.store)).length + 50;
    await say($, 'x'.repeat(100)).catch(() => {});
    expect(turnsOf(w)).toEqual(['do not push']);
    w.storeLimit = 4 * 1024 * 1024;
    await say($, 'fix the tests');
    expect(turnsOf(w)).toEqual(['do not push', 'fix the tests']);
  });

  test('a full store drops the least recent conversations to keep the newest words', async ($, on) => {
    const w = world($, on, {
      store: new Map([
        ['turns:b', kept(2, 'b'.repeat(400))],
        ['turns:a', kept(1, 'a'.repeat(400))],
        ['turns:s1', kept(3, 'earlier')],
      ]),
      storeLimit: 600,
    });
    await say($, 'later');
    expect([...w.store.keys()]).toEqual(['turns:b', 'turns:s1']);
    expect(turnsOf(w)).toEqual(['earlier', 'later']);
  });
});

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
    const [task, answer] = judged(w).user_messages;
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

describe('facts', () => {
  const CHECK = JSON.stringify({
    reason: 'whether the reset discards uncommitted work',
    verdict: 'check',
    check: [{ path: '/w' }, { repo: '/w', ref: 'origin/topic' }],
  });

  test('the judge decides again with what the checks found', async ($, on) => {
    const w = world($, on, {
      replies: [CHECK],
      git: {
        'rev-parse --show-toplevel': { exitCode: 0, stdout: '/w\n' },
        'status --porcelain=v1 -z --untracked-files=all --ignored=matching -- /w': {
          exitCode: 0,
          stdout: ' M src/a.ts\0',
        },
        'rev-parse --verify --quiet origin/topic^{commit}': { exitCode: 1, stdout: '' },
      },
      files: new Map([['/w', '']]),
    });
    await auto($);
    await say($, 'start over from main');
    expect((await check($, 'Bash', bash('git reset --hard origin/main'))).decision).toBe('allow');
    expect(w.modelCalls).toHaveLength(2);
    expect(judged(w, 0).facts).toBeUndefined();
    expect(judged(w, 1).facts!.answers).toMatchObject([
      { path: '/w', exists: true, git: { uncommittedChanges: { count: 1, first: ['src/a.ts'] } } },
      { repo: '/w', ref: 'origin/topic', exists: false },
    ]);
    const [line] = await w.logged(1);
    expect(line!.checked).toEqual([{ path: '/w' }, { repo: '/w', ref: 'origin/topic' }]);
    expect(line!.facts).toEqual(judged(w, 1).facts);
  });
});

describe('the log', () => {
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

  test('only a denial or refusal from the engine is logged as one', async ($, on) => {
    // Calls that ran and printed what a denial says.
    const w = world($, on, { reply: REVIEW, classifierAllows: true, output: DENIAL });
    await auto($);
    const call = (id: string) =>
      $.tool.call({ tool: 'Bash', command: 'make', tool_use_id: id } as never);
    await call('t1');
    w.callFails = true;
    await call('t2');
    w.reply = ALLOW;
    w.classifierAllows = false;
    await call('t3');
    await call('t4');
    const lines = await w.logged(4);
    expect(lines.map((line) => line.event)).toEqual(['check', 'check', 'check', 'check']);
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

describe('output', () => {
  test('a call the plugin allowed has its output withheld when it holds a credential, and runs again under the classifier', async ($, on) => {
    const w = world($, on, { output: `TOKEN=${FAKE_TOKEN}` });
    await auto($);
    const result = await $.tool.call({
      tool: 'Bash',
      command: 'cat config.json',
      tool_use_id: 't1',
    } as never);
    expect(w.ran).toBe(1);
    expect(result.deny).toContain('API key');
    expect(JSON.stringify(result)).not.toContain(FAKE_TOKEN);
    expect((await check($, 'Bash', bash('cat config.json'))).decision).toBe('ask');
    expect((await check($, 'Bash', bash('cat other.json'))).decision).toBe('allow');
  });

  test('output is passed on when it holds no credential, or the plugin did not allow the call', async ($, on) => {
    const w = world($, on, { output: 'version 1.2.3' });
    await auto($);
    const call = (id: string) =>
      $.tool.call({ tool: 'Bash', command: 'cat config.json', tool_use_id: id } as never);
    expect((await call('t1')).text).toBe('version 1.2.3');
    w.output = `TOKEN=${FAKE_TOKEN}`;
    w.core = { decision: 'allow' };
    expect((await call('t2')).text).toContain(FAKE_TOKEN);
  });

  test("output the model would read later, from a file, from a hook's own result, or beside it is checked or withheld", async ($, on) => {
    const w = world($, on, {
      output: 'Output too large, saved to /out/t1.txt',
      record: { stdout: '', persistedOutputPath: '/out/t1.txt' },
    });
    await auto($);
    const call = (command: string, id: string) =>
      $.tool.call({ tool: 'Bash', command, tool_use_id: id } as never);
    w.files.set('/out/t1.txt', `line\nTOKEN=${FAKE_TOKEN}\n`);
    expect((await call('cat a.log', 't1')).deny).toContain('API key');
    w.files.set('/out/t1.txt', 'line\n'.repeat(3));
    expect((await call('cat b.log', 't2')).text).toBe('Output too large, saved to /out/t1.txt');
    w.files.delete('/out/t1.txt');
    expect((await call('cat c.log', 't3')).deny).toContain('could not be read');
    w.record = { stdout: '', backgroundTaskId: 'b1' };
    expect((await call('cat d.log', 't4')).deny).toContain('background');
    w.output = undefined;
    w.record = { stdout: `TOKEN=${FAKE_TOKEN}` };
    expect((await call('cat e.log', 't5')).deny).toContain('API key');
    w.output = 'ok';
    w.record = undefined;
    w.context = [`TOKEN=${FAKE_TOKEN}`];
    expect((await call('cat f.log', 't6')).deny).toContain('API key');
  });

  test('a check that fails withholds the output instead of showing it', async ($, on) => {
    world($, on, {
      record: {
        get backgroundTaskId(): string {
          throw new Error('unreadable record');
        },
      },
    });
    await auto($);
    const call = (id: string) =>
      $.tool.call({ tool: 'Bash', command: 'cat a.log', tool_use_id: id } as never);
    expect((await call('t1')).deny).toContain('checking it failed');
    expect((await check($, 'Bash', bash('cat a.log'))).decision).toBe('ask');
  });
});
