// The world beneath the plugin, shared by the tests that drive its hooks.

import { mock } from 'claude-code/testing';
import type { ModelTextBlock, On, ToolCheckResult } from 'claude-code';
import type { MockClock } from 'claude-code/testing';

export type World = {
  core: ToolCheckResult;
  // The judge's reply: its text; undefined answers an API error the engine
  // classes as an invalid request, and an object answers no text for the
  // reason it gives. Queued replies are given first, one per model call.
  reply: Reply;
  replies: Reply[];
  modelCalls: Array<{
    model: string;
    effort?: string;
    systemBlocks?: readonly ModelTextBlock[];
    prompt: string;
    timeoutMs?: number;
  }>;
  // Each subagent's loop, by agent id; without one, the main loop's.
  agents: Record<string, Array<{ role: 'user' | 'assistant'; text: string }>>;
  files: Map<string, string>;
  // Answers to `$.process.run`, by the arguments after git's fixed options;
  // anything else exits 0 with no output.
  git: Record<string, { exitCode: number; stdout: string }>;
  // Whether the synthetic permission decider lets an ask run.
  asksAllowed: boolean;
  // Whether the engine rejects a hook's allow, as for a tool only the
  // classifier may allow.
  engineRejects: boolean;
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
  // The session's clock, which moves only when a test moves it.
  clock: MockClock;
  sessionId: string;
  env: Record<string, string>;
  // The plugin's store, in insertion order, and how many characters of JSON
  // it takes before it refuses a write.
  store: Map<string, unknown>;
  storeLimit: number;
  // Awaited by every store write before it lands.
  writeGate: (() => Promise<void>) | undefined;
  // How many log writes still to refuse, as a full disk would.
  failWrites: number;
  // Resolves once the session's log, or the part at `path`, holds `count` lines.
  logged: (count: number, path?: string) => Promise<Array<Record<string, unknown>>>;
};

type Reply = string | undefined | { reason: string };

export const ALLOW = JSON.stringify({ reason: 'a reversible step of the task', verdict: 'allow' });
export const REVIEW = JSON.stringify({
  reason: 'sends a message nobody asked for',
  verdict: 'review',
});
export const ENGINE_VERSION = '0.0.0-synthetic';
export const LOG = '/home/u/.claude/preallow/s1.jsonl';
export const REJECTION =
  "Only the auto-mode classifier can allow mcp__srv__handoff: an allow of type 'hook' is not the classifier's verdict";

// What the judge model's nth call costs, distinct for each call so a usage
// entry dropped or counted twice shows.
export const usageOf = (n: number) => ({
  input_tokens: n,
  output_tokens: 10 * n,
  cache_read_input_tokens: 100 * n,
  cache_creation_input_tokens: 1000 * n,
});

// The engine's core decision, model client, tool results and local storage.
// The testing engine owns the permission check before a mocked tool runs.
export function world(on: On, partial: Partial<World> = {}): World {
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
    modelCalls: [],
    agents: {},
    files: new Map(),
    git: {},
    asksAllowed: false,
    engineRejects: false,
    dropsPrompt: false,
    callFails: false,
    output: 'ok',
    record: undefined,
    context: undefined,
    ran: 0,
    clock: mock.clock(on),
    sessionId: 's1',
    env: { HOME: '/home/u' },
    store: new Map(),
    storeLimit: 4 * 1024 * 1024,
    writeGate: undefined,
    failWrites: 0,
    logged: (count, path = LOG) =>
      new Promise((resolve) =>
        lines(path).length >= count ? resolve(lines(path)) : waiters.push([count, path, resolve]),
      ),
    ...partial,
  };
  mock.env(on, w.env);
  on('classic.UserPromptSubmit', async () => ({}));
  on('classic.SubagentStart', async () => ({}));
  on('classic.PermissionDenied', async () => ({}));
  on('classic.PermissionRequest', async () => ({
    decision: w.asksAllowed
      ? { behavior: 'allow' }
      : { behavior: 'deny', message: 'Synthetic permission denial' },
  }));
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
      agentId === undefined ? [{ role: 'user', text: 'the main conversation' }] : w.agents[agentId];
    const value = rows?.map((row) => ({ ...row, toolUses: [] })) ?? { deny: 'unknown agent' };
    return { value } as never;
  });
  on('model.complete', async (_$, e) => {
    const { model, effort, systemBlocks, prompt, timeoutMs } = e as World['modelCalls'][number];
    w.modelCalls.push({ model, effort, systemBlocks, prompt, timeoutMs });
    const reply = w.replies.length > 0 ? w.replies.shift() : w.reply;
    const value =
      reply === undefined
        ? { isAnswered: false, reason: 'api-error', error: 'invalid_request', status: 400 }
        : typeof reply === 'string'
          ? { isAnswered: true, text: reply }
          : { isAnswered: false, ...reply };
    return { value: { ...value, usage: usageOf(w.modelCalls.length) } } as never;
  });
  on('session.cwd', async () => ({ value: '/w' }) as never);
  on('session.version', async () => ({ value: { version: ENGINE_VERSION } }) as never);
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
    if (w.failWrites > 0 && w.failWrites--) throw new Error('disk full');
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
  on('tool.call', async () => {
    if (w.engineRejects) return { isError: true, result: REJECTION, text: REJECTION } as never;
    w.ran++;
    if (w.callFails) return { isError: true, result: w.output, text: w.output } as never;
    return { result: w.record ?? w.output, text: w.output, context: w.context } as never;
  });
  return w;
}
