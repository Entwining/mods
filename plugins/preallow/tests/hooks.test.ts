import { describe, expect, mock, test } from 'claude-code/testing';
import type { Engine } from 'claude-code/testing';
import type { On, ToolCheckResult } from 'claude-code';

type World = {
  core: ToolCheckResult;
  sandbox: { enabled?: boolean; excludedCommands?: string[] };
  isShellPinned: boolean;
  reply: string | undefined;
  modelCalls: number;
  modelPrompts: string[];
  toasts: string[];
  files: Map<string, string>;
  callFails: boolean;
  callDenied: boolean;
  // Whether the classifier lets a call the check asked about run.
  classifierAllows: boolean;
  dropsPrompt: boolean;
  // Holds the next model call's answer until it resolves.
  gate: Promise<unknown> | undefined;
  output: string;
  // The tool's own record, when it differs from the output text.
  record: unknown;
  // Repository lookups that differ from GIT.
  git: Record<string, string>;
  // Directories holding the repository.
  repoDirs: string[];
  ran: number;
  // Resolves once the session's log holds `count` lines.
  logged: (count: number) => Promise<unknown[]>;
};

const GIT: Record<string, string> = {
  'git symbolic-ref --quiet --short HEAD': 'feature',
  'git config --get branch.feature.remote': 'origin',
  'git remote get-url --push --all origin': 'git@github.com:o/r.git',
  'git symbolic-ref --quiet --short refs/remotes/origin/HEAD': 'origin/main',
  'git show-ref --verify --quiet refs/heads/feature': '',
  'git show-ref --verify --quiet refs/heads/other': '',
};

const PUSH_GRANT = JSON.stringify({
  grants: [
    {
      class: 'push',
      repo: null,
      branch: 'feature',
      number: null,
      tag: null,
      oneShot: true,
      namedBy: 'user',
      quote: 'push feature',
    },
  ],
});
const PLAN_PUSH_GRANT = PUSH_GRANT.replace('"user"', '"plan"');
// Built at run time, so no scanner takes the source for a leaked token.
const FAKE_TOKEN = `ghp_${'x'.repeat(36)}`;
const LOG = '/home/u/.claude/preallow/s1.jsonl';

// Everything beneath the plugin: the engine's own decision, a repository on
// branch `feature` of o/r, the extraction model, and an in-memory log folder.
// A tool call asks for its permission under its own id, as a session does
// beneath every plugin's `tool.call` hook, and runs only when allowed; a
// `callDenied` world denies it after the check, as a hook above core would.
function world($: Engine, on: On, partial: Partial<World> = {}): World {
  const waiters: Array<[number, (lines: unknown[]) => void]> = [];
  const lines = () =>
    (w.files.get(LOG) ?? '')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  const w: World = {
    core: { decision: 'ask' },
    sandbox: { enabled: true, excludedCommands: ['git:*', 'docker:*', 'jq:*'] },
    isShellPinned: true,
    reply: undefined,
    modelCalls: 0,
    modelPrompts: [],
    toasts: [],
    files: new Map(),
    callFails: false,
    callDenied: false,
    classifierAllows: false,
    dropsPrompt: false,
    gate: undefined,
    output: 'ok',
    record: undefined,
    git: {},
    repoDirs: ['/repo'],
    ran: 0,
    logged: (count) =>
      new Promise((resolve) =>
        lines().length >= count ? resolve(lines()) : waiters.push([count, resolve]),
      ),
    ...partial,
  };
  mock.env(on, {
    HOME: '/home/u',
    ...(w.isShellPinned ? { CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: '1' } : {}),
  });
  on('classic.UserPromptSubmit', async () => ({}));
  on('classic.SubagentStart', async () => ({}));
  on('settings.read', async () => ({ value: { sandbox: w.sandbox } }) as never);
  on('tool.check', async () => w.core);
  on('session.cwd', async () => ({ value: '/repo' }));
  on('session.id', async () => ({ value: 's1' }));
  on(
    'session.repo',
    async () =>
      ({
        value: { root: '/repo', remote: 'git@github.com:o/r.git', internal: false, name: 'r' },
      }) as never,
  );
  on('process.run', async (_$, e) => {
    const stdout = w.repoDirs.includes(e.init?.cwd ?? '')
      ? { ...GIT, ...w.git }[e.argv.join(' ')]
      : undefined;
    return {
      value: { exitCode: stdout === undefined ? 1 : 0, stdout: stdout ?? '', stderr: '' },
    } as never;
  });
  on('model.complete', async (_$, e) => {
    w.modelCalls++;
    w.modelPrompts.push((e as { prompt: string }).prompt);
    const reply = w.reply;
    const gate = w.gate;
    w.gate = undefined;
    await gate;
    return {
      value:
        reply === undefined
          ? { isAnswered: false, reason: 'error' }
          : { isAnswered: true, text: reply, usage: {} },
    } as never;
  });
  on('ui.toast', async (_$, e) => {
    w.toasts.push(e.text);
    return { value: undefined } as never;
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
    for (const waiter of waiters.filter(([count]) => lines().length >= count)) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter[1](lines());
    }
    return { value: undefined } as never;
  });
  on('prompt.submit', async (_$, e) =>
    w.dropsPrompt ? { drop: 'blocked beneath' } : { text: e.text },
  );
  on('turn.complete', async (_$, e) => ({ text: e.answer }));
  on('session.end', async () => ({ sessionId: 's1' }) as never);
  on('tool.call', async (_$, e) => {
    const { tool, tool_use_id, ...input } = e as { tool: string; tool_use_id: string };
    const { decision } = await $.tool.check({ tool, input, tool_use_id } as never);
    if (decision !== 'allow' && !(decision === 'ask' && w.classifierAllows))
      return { deny: decision } as never;
    if (w.callDenied) return { deny: 'denied above core' } as never;
    w.ran++;
    return (
      w.callFails
        ? { isError: true, result: 'exit 1', text: 'exit 1' }
        : { result: w.record ?? w.output, text: w.output }
    ) as never;
  });
  return w;
}

const ENFORCE = { options: { mode: 'enforce' } };

async function auto($: Engine, mode = 'auto') {
  await $.classic.UserPromptSubmit({ prompt: '', permission_mode: mode } as never);
}

function check(
  $: Engine,
  command: string,
  id?: string,
  input: Record<string, unknown> = {},
  call: Record<string, unknown> = {},
): Promise<ToolCheckResult> {
  return $.tool.check({
    tool: 'Bash',
    input: { command, ...input },
    ...(id === undefined ? {} : { tool_use_id: id }),
    ...call,
  } as never);
}

function say($: Engine, text: string, kind = 'composer', turnId?: string) {
  return $.prompt.submit({
    text,
    wait: false,
    origin: { kind },
    ...(turnId === undefined ? {} : { turnId }),
  } as never);
}

function answer($: Engine, text: string) {
  return $.turn.complete({
    answer: text,
    durationMs: 1,
    isAborted: false,
    turnId: 'x',
    reason: 'answer',
  } as never);
}

describe('tool.check', () => {
  test('a core allow or deny is never touched', ENFORCE, async ($, on) => {
    world($, on, { core: { decision: 'deny', reason: 'rule' } });
    await auto($);
    expect((await check($, 'ls', 't1')).decision).toBe('deny');
  });

  test('outside auto mode the core answer stands', ENFORCE, async ($, on) => {
    world($, on);
    await auto($, 'default');
    expect((await check($, 'ls', 't1')).decision).toBe('ask');
  });

  test('enforce allows a read-only command', ENFORCE, async ($, on) => {
    world($, on);
    await auto($);
    expect((await check($, 'git log --oneline -5 | head -3', 't1')).decision).toBe('allow');
    expect((await check($, 'rm -rf x', 't2')).decision).toBe('ask');
  });

  test('a read that names secret material is left to the classifier', ENFORCE, async ($, on) => {
    world($, on);
    await auto($);
    expect((await check($, "rg -n 'apiKey' config.json", 't1')).decision).toBe('ask');
    expect((await check($, 'cat ~/.netrc-Password.txt', 't2')).decision).toBe('ask');
  });

  test('a call that widens the sandbox is left to the core', ENFORCE, async ($, on) => {
    world($, on);
    await auto($);
    expect((await check($, 'ls', 't1', { dangerouslyDisableSandbox: true })).decision).toBe('ask');
    expect((await check($, 'ls', 't2', { allowed_domains: ['example.com'] })).decision).toBe('ask');
    expect((await check($, 'ls', 't3', { allowed_domains: [] })).decision).toBe('allow');
  });

  test(
    'without the sandbox, or for a program outside it, the core answer stands',
    ENFORCE,
    async ($, on) => {
      const w = world($, on);
      await auto($);
      expect((await check($, 'git status', 't1')).decision).toBe('allow');
      expect((await check($, 'jq . x', 't2')).decision).toBe('ask');
      expect((await check($, 'echo "$(jq . x)"', 't3')).decision).toBe('ask');
      w.sandbox = { enabled: false };
      expect((await check($, 'ls', 't3')).decision).toBe('ask');
    },
  );

  test('an organization ceiling is left to the core', ENFORCE, async ($, on) => {
    world($, on);
    await auto($);
    expect((await check($, 'ls', 't1', {}, { ceiling: 'ask' })).decision).toBe('ask');
  });

  test('an ask from a settings rule or a hook is left to the core', ENFORCE, async ($, on) => {
    const w = world($, on, { core: { decision: 'ask', rule: 'Bash(git status)' } });
    await auto($);
    expect((await check($, 'git status', 't1')).decision).toBe('ask');
    w.core = { decision: 'ask', hook: 'PreToolUse' };
    expect((await check($, 'git status', 't2')).decision).toBe('ask');
  });

  test('a subagent is judged by its own mode', ENFORCE, async ($, on) => {
    world($, on);
    await auto($);
    expect((await check($, 'ls', 't1', {}, { agentId: 'a1' })).decision).toBe('ask');
    await $.classic.SubagentStart({
      agent_id: 'a1',
      agent_type: 'x',
      permission_mode: 'auto',
    } as never);
    expect((await check($, 'ls', 't2', {}, { agentId: 'a1' })).decision).toBe('allow');
    await $.classic.SubagentStart({
      agent_id: 'a2',
      agent_type: 'x',
      permission_mode: 'default',
    } as never);
    expect((await check($, 'ls', 't3', {}, { agentId: 'a2' })).decision).toBe('ask');
  });

  test('shadow answers the core and logs what enforce would do', async ($, on) => {
    const w = world($, on);
    await auto($);
    // Writes land in order, so a logged query would be the first line.
    await check($, 'ls');
    expect((await check($, 'ls', 't1')).decision).toBe('ask');
    const lines = (await w.logged(1)) as Array<Record<string, unknown>>;
    expect(lines.map((line) => [line.tool_use_id, line.verdict, line.isEnforcing])).toEqual([
      ['t1', 'allow', false],
    ]);
  });

  test('shadow uses one-shot grants as enforce would, so the log matches', async ($, on) => {
    const w = world($, on, { reply: PUSH_GRANT });
    await auto($);
    await say($, 'push feature');
    await check($, 'git push origin feature', 't1');
    await check($, 'git push origin feature', 't2');
    const lines = (await w.logged(3)) as Array<Record<string, unknown>>;
    expect(lines.filter((line) => line.event === 'check').map((line) => line.verdict)).toEqual([
      'allow',
      'pass',
    ]);
  });
});

test(
  'reads mode allows read-only commands and only logs granted pushes',
  { options: { mode: 'reads' } },
  async ($, on) => {
    world($, on, { reply: PUSH_GRANT });
    await auto($);
    await say($, 'push feature');
    expect((await check($, 'git status', 't1')).decision).toBe('allow');
    expect((await check($, 'git push origin feature', 't2')).decision).toBe('ask');
  },
);

describe('grants', () => {
  test('a push needs a grant from the user', ENFORCE, async ($, on) => {
    const w = world($, on, { reply: PUSH_GRANT });
    await auto($);
    expect((await check($, 'git push origin feature', 't1')).decision).toBe('ask');
    await say($, 'looks right, push feature now');
    expect((await check($, 'git push origin feature', 't2')).decision).toBe('allow');
    expect(w.toasts.length).toBe(1);
  });

  test(
    'a push waits for the classifier when the shell may have left the session directory',
    ENFORCE,
    async ($, on) => {
      const w = world($, on, { reply: PUSH_GRANT, isShellPinned: false });
      await auto($);
      await say($, 'push feature now');
      expect((await check($, 'git push origin feature', 't1')).decision).toBe('ask');
      expect(w.toasts.length).toBe(1);
    },
  );

  test('a push after a cd to an absolute path is resolved there', ENFORCE, async ($, on) => {
    world($, on, {
      reply: PUSH_GRANT.replace('"oneShot":true', '"oneShot":false'),
      isShellPinned: false,
      repoDirs: ['/clone', 'clone', '/clone$X', '/clone${X}'],
    });
    await auto($);
    await say($, 'push feature now');
    expect((await check($, 'cd /clone && git push origin feature', 't1')).decision).toBe('allow');
    for (const [id, command] of [
      ['t2', 'cd /clone; git push origin feature'],
      ['t3', 'cd /clone || git push origin feature'],
      ['t4', 'cd clone && git push origin feature'],
      ['t5', 'cd /clone && cd /repo && git push origin feature'],
      ['t7', 'cd /clone$X && git push origin feature'],
      ['t6', 'git push origin feature'],
    ]) {
      expect([command, (await check($, command!, id)).decision]).toEqual([command, 'ask']);
    }
  });

  test('a subagent push waits for the classifier', ENFORCE, async ($, on) => {
    world($, on, { reply: PUSH_GRANT });
    await auto($);
    await $.classic.SubagentStart({
      agent_id: 'a1',
      agent_type: 'x',
      permission_mode: 'auto',
    } as never);
    await say($, 'push feature now');
    expect((await check($, 'git push origin feature', 't1', {}, { agentId: 'a1' })).decision).toBe(
      'ask',
    );
    expect((await check($, 'git push origin feature', 't2')).decision).toBe('allow');
  });

  test('the grant names the branch it covers', ENFORCE, async ($, on) => {
    world($, on, { reply: PUSH_GRANT });
    await auto($);
    await say($, 'push feature please');
    expect((await check($, 'git push origin other', 't1')).decision).toBe('ask');
    expect((await check($, 'git push origin feature', 't2')).decision).toBe('allow');
  });

  test('a quote the message does not contain grants nothing', ENFORCE, async ($, on) => {
    world($, on, { reply: PUSH_GRANT });
    await auto($);
    await say($, 'push it');
    expect((await check($, 'git push origin feature', 't1')).decision).toBe('ask');
  });

  test('a message from another session grants nothing', ENFORCE, async ($, on) => {
    const w = world($, on, { reply: PUSH_GRANT });
    await auto($);
    await say($, 'push feature now', 'peer');
    expect(w.modelCalls).toBe(0);
    expect((await check($, 'git push origin feature', 't1')).decision).toBe('ask');
  });

  test('a message without an outward action skips the model', ENFORCE, async ($, on) => {
    const w = world($, on, { reply: PUSH_GRANT });
    await auto($);
    await say($, 'explain the parser');
    expect(w.modelCalls).toBe(0);
  });

  test(
    'while grants stand, the model judges every message, so a withdrawal needs no listed word',
    ENFORCE,
    async ($, on) => {
      const w = world($, on, { reply: PUSH_GRANT.replace('"oneShot":true', '"oneShot":false') });
      await auto($);
      await say($, 'push feature as you go');
      expect((await check($, 'git push origin feature')).decision).toBe('allow');
      w.reply = JSON.stringify({ grants: [], withdraws: false });
      await say($, 'explain the parser');
      expect((await check($, 'git push origin feature', 't1')).decision).toBe('allow');
      w.reply = JSON.stringify({ grants: [], withdraws: true });
      await say($, 'keep it local for now');
      expect((await check($, 'git push origin feature', 't2')).decision).toBe('ask');
      expect(w.modelCalls).toBe(3);
    },
  );

  test('a message judged only for withdrawal grants nothing', ENFORCE, async ($, on) => {
    const w = world($, on, { reply: PUSH_GRANT });
    await auto($);
    await say($, 'push feature');
    expect((await check($, 'git push origin feature')).decision).toBe('allow');
    await answer($, 'Next I will push other.');
    w.reply = JSON.stringify({
      grants: [
        {
          ...JSON.parse(PUSH_GRANT).grants[0],
          branch: 'other',
          namedBy: 'plan',
          quote: 'push other',
        },
      ],
      withdraws: false,
    });
    await say($, 'explain the parser');
    expect(w.modelCalls).toBe(2);
    expect((await check($, 'git push origin other', 't1')).decision).toBe('ask');
  });

  test('a later message that takes the grant back withdraws it', ENFORCE, async ($, on) => {
    const w = world($, on, { reply: PUSH_GRANT });
    await auto($);
    await say($, 'push feature once the tests pass');
    expect((await check($, 'git push origin feature')).decision).toBe('allow');
    w.reply = JSON.stringify({ grants: [] });
    await say($, "actually don't push, I want to review the diff first");
    expect((await check($, 'git push origin feature', 't1')).decision).toBe('ask');
  });

  test(
    'the model judges whether words such as "don\'t" take a grant back',
    ENFORCE,
    async ($, on) => {
      const w = world($, on, { reply: PUSH_GRANT.replace('}]}', '}],"withdraws":false}') });
      await auto($);
      await say($, 'push feature as you go');
      expect((await check($, 'git push origin feature')).decision).toBe('allow');
      w.reply = JSON.stringify({ grants: [], withdraws: false });
      await say($, "don't add comments to the tests");
      expect((await check($, 'git push origin feature', 't1')).decision).toBe('allow');
      w.reply = JSON.stringify({ grants: [], withdraws: true });
      await say($, 'hold on, let me look first');
      expect((await check($, 'git push origin feature', 't2')).decision).toBe('ask');
      expect(w.modelCalls).toBe(3);
      expect(w.modelPrompts[2]).toContain(
        '<earlier_grants>\n- push (github.com/o/r, branch feature), once: "push feature"',
      );
    },
  );

  test(
    'without the model, words such as "don\'t" take every grant back',
    ENFORCE,
    async ($, on) => {
      const w = world($, on, { reply: PUSH_GRANT });
      await auto($);
      await say($, 'push feature as you go');
      w.reply = undefined;
      await say($, "don't add comments to the tests");
      expect((await check($, 'git push origin feature', 't1')).decision).toBe('ask');
    },
  );

  test(
    'a message is not held up by the model, and its grants apply in the order sent',
    ENFORCE,
    async ($, on) => {
      let release: (value?: unknown) => void = () => {};
      const w = world($, on, {
        reply: PUSH_GRANT,
        gate: new Promise((resolve) => (release = resolve)),
      });
      await auto($);
      await say($, 'push feature');
      expect(w.toasts).toEqual([]);
      w.reply = JSON.stringify({ grants: [], withdraws: false });
      await say($, "wait, don't push yet");
      release();
      expect((await check($, 'git push origin feature', 't1')).decision).toBe('ask');
    },
  );

  test('a read does not wait for a grant still being read', ENFORCE, async ($, on) => {
    let release: (value?: unknown) => void = () => {};
    world($, on, { reply: PUSH_GRANT, gate: new Promise((resolve) => (release = resolve)) });
    await auto($);
    await say($, 'push feature');
    const push = check($, 'git push origin feature', 't2');
    expect((await check($, 'git status', 't1')).decision).toBe('allow');
    release();
    expect((await push).decision).toBe('allow');
  });

  test('an interrupt withdraws grants still being read', ENFORCE, async ($, on) => {
    let release: (value?: unknown) => void = () => {};
    world($, on, { reply: PUSH_GRANT, gate: new Promise((resolve) => (release = resolve)) });
    await auto($);
    await say($, 'push feature');
    await $.turn.complete({
      answer: '',
      durationMs: 1,
      isAborted: true,
      turnId: 'x',
      reason: 'aborted',
    } as never);
    release();
    expect((await check($, 'git push origin feature', 't1')).decision).toBe('ask');
  });

  test(
    'a grant still being read when the session ends does not carry over',
    ENFORCE,
    async ($, on) => {
      let release: (value?: unknown) => void = () => {};
      world($, on, { reply: PUSH_GRANT, gate: new Promise((resolve) => (release = resolve)) });
      await auto($);
      await say($, 'push feature');
      await $.session.end({ reason: 'clear', resume: {} } as never);
      release();
      await auto($);
      expect((await check($, 'git push origin feature', 't1')).decision).toBe('ask');
    },
  );

  test(
    'an approval typed over a running turn does not approve the last answer',
    ENFORCE,
    async ($, on) => {
      world($, on, { reply: PLAN_PUSH_GRANT });
      await auto($);
      await answer($, 'Next I will push feature to origin.');
      await say($, 'ok', 'composer', 'running');
      expect((await check($, 'git push origin feature', 't1')).decision).toBe('ask');
      await say($, 'ok');
      expect((await check($, 'git push origin feature', 't2')).decision).toBe('allow');
    },
  );

  test('an answer approves what it proposes, not what it quotes', ENFORCE, async ($, on) => {
    world($, on, { reply: PLAN_PUSH_GRANT });
    await auto($);
    await answer($, 'The issue asks:\n> push feature\nShould I?');
    await say($, 'ok');
    expect((await check($, 'git push origin feature', 't1')).decision).toBe('ask');
    await answer($, 'Next I will push feature.');
    await say($, 'ok');
    expect((await check($, 'git push origin feature', 't2')).decision).toBe('allow');
  });

  test('a prompt dropped beneath grants nothing', ENFORCE, async ($, on) => {
    const w = world($, on, { reply: PUSH_GRANT, dropsPrompt: true });
    await auto($);
    await say($, 'push feature');
    expect((await check($, 'git push origin feature', 't1')).decision).toBe('ask');
    expect(w.toasts).toEqual([]);
  });

  test('ending the session withdraws every grant', ENFORCE, async ($, on) => {
    world($, on, { reply: PUSH_GRANT });
    await auto($);
    await say($, 'push feature');
    await $.session.end({ reason: 'clear', resume: {} } as never);
    await auto($);
    expect((await check($, 'git push origin feature', 't1')).decision).toBe('ask');
  });

  test(
    'an interrupt withdraws grants, and its cut-off answer is no proposal',
    ENFORCE,
    async ($, on) => {
      const w = world($, on, { reply: PUSH_GRANT });
      await auto($);
      await say($, 'push feature when done');
      await $.turn.complete({
        answer: 'Next I will push feature',
        durationMs: 1,
        isAborted: true,
        turnId: 'x',
        reason: 'aborted',
      } as never);
      w.reply = PLAN_PUSH_GRANT;
      await say($, 'ok');
      expect((await check($, 'git push origin feature', 't1')).decision).toBe('ask');
      w.reply = PUSH_GRANT;
      await say($, 'push feature now');
      expect((await check($, 'git push origin feature', 't2')).decision).toBe('allow');
    },
  );

  test('a one-shot grant is used once; a query does not use it', ENFORCE, async ($, on) => {
    world($, on, { reply: PUSH_GRANT });
    await auto($);
    await say($, 'push feature');
    expect((await check($, 'git push origin feature')).decision).toBe('allow');
    expect((await check($, 'git push origin feature', 't1')).decision).toBe('allow');
    expect((await check($, 'git push origin feature', 't2')).decision).toBe('ask');
  });

  test('two parallel calls cannot both use one one-shot grant', ENFORCE, async ($, on) => {
    world($, on, { reply: PUSH_GRANT });
    await auto($);
    await say($, 'push feature');
    const decisions = await Promise.all([
      check($, 'git push origin feature', 't1'),
      check($, 'git push origin feature', 't2'),
    ]);
    expect(decisions.map((decision) => decision.decision).sort()).toEqual(['allow', 'ask']);
  });

  test('a call denied before it ran gives its one-shot grant back', ENFORCE, async ($, on) => {
    const w = world($, on, { reply: PUSH_GRANT, callDenied: true });
    await auto($);
    await say($, 'push feature');
    await $.tool.call({ tool: 'Bash', command: 'git push origin feature' } as never);
    expect(w.ran).toBe(0);
    expect((await check($, 'git push origin feature', 't1')).decision).toBe('allow');
  });

  for (const callFails of [false, true]) {
    test(
      `a call that ran keeps its one-shot grant used${callFails ? ', even when it failed' : ''}`,
      ENFORCE,
      async ($, on) => {
        const w = world($, on, { reply: PUSH_GRANT, callFails });
        await auto($);
        await say($, 'push feature');
        await $.tool.call({ tool: 'Bash', command: 'git push origin feature' } as never);
        expect(w.ran).toBe(1);
        expect((await check($, 'git push origin feature', 't1')).decision).toBe('ask');
      },
    );
  }

  test('/grants lists the grants and clear withdraws them', ENFORCE, async ($, on) => {
    world($, on, { reply: PUSH_GRANT });
    await auto($);
    await say($, 'push feature');
    expect((await $.command.run({ command: 'grants', args: '' } as never)).text).toContain(
      'push (github.com/o/r, branch feature), once',
    );
    await $.command.run({ command: 'grants', args: 'clear' } as never);
    expect((await check($, 'git push origin feature', 't1')).decision).toBe('ask');
  });
});

describe('output', () => {
  test(
    'a read the plugin allowed has its output withheld when it holds a credential, and runs again under the classifier',
    ENFORCE,
    async ($, on) => {
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
      expect((await check($, 'cat config.json', 't2')).decision).toBe('ask');
      expect((await check($, 'cat other.json', 't3')).decision).toBe('allow');
    },
  );

  test(
    'output is passed on when it holds no credential, or the plugin did not allow the read',
    ENFORCE,
    async ($, on) => {
      const w = world($, on, { output: 'version 1.2.3' });
      await auto($);
      expect(
        (
          await $.tool.call({
            tool: 'Bash',
            command: 'cat config.json',
            tool_use_id: 't1',
          } as never)
        ).text,
      ).toBe('version 1.2.3');
      w.output = `TOKEN=${FAKE_TOKEN}`;
      w.core = { decision: 'allow' };
      expect(
        (
          await $.tool.call({
            tool: 'Bash',
            command: 'cat config.json',
            tool_use_id: 't2',
          } as never)
        ).text,
      ).toContain(FAKE_TOKEN);
    },
  );

  test('a background read is left to the classifier', ENFORCE, async ($, on) => {
    world($, on);
    await auto($);
    expect((await check($, 'ls', 't1', { run_in_background: true })).decision).toBe('ask');
  });

  test(
    'output the model would read later or from a file is checked or withheld',
    ENFORCE,
    async ($, on) => {
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
    },
  );

  test('a check that fails withholds the output instead of showing it', ENFORCE, async ($, on) => {
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
    expect((await check($, 'cat a.log', 't2')).decision).toBe('ask');
  });

  test('shadow logs the output it would withhold and passes it on', async ($, on) => {
    const w = world($, on, { output: `TOKEN=${FAKE_TOKEN}`, classifierAllows: true });
    await auto($);
    const result = await $.tool.call({
      tool: 'Bash',
      command: 'cat config.json',
      tool_use_id: 't1',
    } as never);
    expect(result.text).toContain(FAKE_TOKEN);
    const lines = (await w.logged(2)) as Array<Record<string, unknown>>;
    expect(lines.map((line) => [line.event, line.isEnforcing])).toEqual([
      ['check', false],
      ['withheld', false],
    ]);
    expect(JSON.stringify(lines)).not.toContain(FAKE_TOKEN);
  });

  test('a granted push keeps its output', ENFORCE, async ($, on) => {
    world($, on, { reply: PUSH_GRANT, output: `remote: ${FAKE_TOKEN}` });
    await auto($);
    await say($, 'push feature');
    expect(
      (
        await $.tool.call({
          tool: 'Bash',
          command: 'git push origin feature',
          tool_use_id: 't1',
        } as never)
      ).text,
    ).toContain(FAKE_TOKEN);
  });
});

describe('default branch', () => {
  const forceGrant = (branch: string | null, quote: string) =>
    PUSH_GRANT.replace('"push"', '"force_push"')
      .replace('"branch":"feature"', `"branch":${JSON.stringify(branch)}`)
      .replace('"push feature"', JSON.stringify(quote));

  test('a force push of the default branch needs the user to name it', ENFORCE, async ($, on) => {
    const w = world($, on, {
      reply: forceGrant(null, 'force push'),
      git: {
        'git symbolic-ref --quiet --short HEAD': 'main',
        'git show-ref --verify --quiet refs/heads/main': '',
      },
    });
    await auto($);
    await say($, 'force push');
    expect((await check($, 'git push --force origin main', 't1')).decision).toBe('ask');
    w.reply = forceGrant('main', 'force push');
    await say($, 'force push; the main thing is speed');
    expect((await check($, 'git push --force origin main', 't2')).decision).toBe('ask');
    w.reply = forceGrant('main', 'force push main');
    await say($, 'force push main');
    expect((await check($, 'git push --force origin main', 't3')).decision).toBe('allow');
  });
});
