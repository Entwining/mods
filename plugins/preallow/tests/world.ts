// The world beneath the plugin, shared by the tests that drive its hooks.

import { mock } from 'claude-code/testing';
import type { Engine } from 'claude-code/testing';
import type { On, ToolCheckResult } from 'claude-code';

export type World = {
  core: ToolCheckResult;
  // The judge's reply; undefined answers no text, as an API error does.
  // Queued replies are given first, one per model call.
  reply: string | undefined;
  replies: Array<string | undefined>;
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
  // How many log writes still to refuse, as a full disk would.
  failWrites: number;
  // Resolves once the session's log, or the part at `path`, holds `count` lines.
  logged: (count: number, path?: string) => Promise<Array<Record<string, unknown>>>;
};

export const ALLOW = JSON.stringify({ reason: 'a reversible step of the task', verdict: 'allow' });
export const REVIEW = JSON.stringify({
  reason: 'sends a message nobody asked for',
  verdict: 'review',
});
export const ENGINE_VERSION = '0.0.0-synthetic';
export const LOG = '/home/u/.claude/preallow/s1.jsonl';
export const REFUSAL =
  "Only the auto-mode classifier can allow mcp__srv__handoff: an allow of type 'hook' is not the classifier's verdict";
export const DENIAL =
  "Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Synthetic]. If you have other tasks that don't depend on this action, continue working on those.";

// Everything beneath the plugin: the engine's own decision, the judge model,
// subagent transcripts, and an in-memory log folder. A tool call asks for its
// permission under its own id, as a session does beneath every plugin's
// `tool.call` hook; an ask the classifier denies comes back as the error text
// the core reports, with no `deny` field.
export function world($: Engine, on: On, partial: Partial<World> = {}): World {
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
    failWrites: 0,
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
      agentId === undefined ? [{ role: 'user', text: 'the main conversation' }] : w.agents[agentId];
    const value = rows?.map((row) => ({ ...row, toolUses: [] })) ?? { deny: 'unknown agent' };
    return { value } as never;
  });
  on('model.complete', async (_$, e) => {
    const { model, effort, system, prompt, timeoutMs } = e as World['modelCalls'][number];
    w.modelCalls.push({ model, effort, system, prompt, timeoutMs });
    const reply = w.replies.length > 0 ? w.replies.shift() : w.reply;
    const value =
      reply === undefined
        ? { isAnswered: false, reason: 'api-error', error: 'invalid_request', status: 400 }
        : { isAnswered: true, text: reply };
    return { value: { ...value, usage: {} } } as never;
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
