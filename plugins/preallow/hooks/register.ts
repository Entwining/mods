import { atom, read, update } from 'claude-code';
import type { Register, ToolCheckResult } from 'claude-code';

import type { Modes } from '../types';
import { judgeCall, type JudgeSettings } from './judge.ts';
import { loggedInput, record } from './log.ts';
import { rerunWarning, WITHHELD, withholding } from './withhold.ts';
import { ANSWER_PREFIX, remember } from './messages.ts';

const modesRef = atom({ plugin: 'preallow', key: 'modes' } as const, {} as Modes);

const JUDGE_MODEL = 'opus';
const JUDGE_EFFORT = 'medium';

// Tools whose verdict the engine keeps whatever a hook answers: it rejects a
// hook's allow of a subagent's handback, which only the classifier may allow,
// and a question or a plan waits for the person.
const RESERVED_TOOLS = new Set(['SubagentHandback', 'AskUserQuestion', 'ExitPlanMode']);

// The fields of the core's answer that put an ask to someone other than the
// classifier: a settings rule, a classic hook, an option's own check (the read
// block, which asks the person), another plugin, and an organization's
// ceiling. Every field but the verdict and its reason is
// listed, so `bun run typecheck:core` fails on a field the engine adds until
// it is marked here; a field marked false is read as information and leaves
// the ask to the judge.
const OWNS_ASK = {
  rule: true,
  hook: true,
  setting: true,
  plugin: true,
  ceiling: true,
} satisfies Record<Exclude<keyof ToolCheckResult, 'decision' | 'reason'>, boolean>;

// How the engine reports rejecting a hook's allow of a tool only the
// classifier may allow.
const ENGINE_REJECTION = 'Only the auto-mode classifier can allow';

export const register: Register = (on, options) => {
  // The settings go to the model client as the user wrote them; a value it
  // refuses fails the judge call, which leaves the call to the classifier.
  // An emptied field counts as unset.
  const settings: JudgeSettings = {
    model: (options.model as string | undefined) || JUDGE_MODEL,
    effort: (options.effort as string | undefined) || JUDGE_EFFORT,
  };
  // Calls the plugin allowed, by tool_use_id, so their output is scanned
  // before the model reads it; calls left to the core when they run again,
  // after their output was withheld or the engine rejected the plugin's allow;
  // and the calls the judge left to review, so a denial of one is logged.
  const allowedCalls = new Map<string, string>();
  const coreCalls = new Set<string>();
  const reviewCalls = new Set<string>();

  // Subagents can run under a mode of their own, and the user can switch
  // modes mid-turn, so every classic event that reports a mode updates its
  // loop. `classic.PreToolUse` carries the tool call's own arguments instead,
  // which a tool's input could fill.
  on('classic.*', async ($, e, next) => {
    if (next.is('classic.PreToolUse', e)) return next(e);
    const { permission_mode: mode, agent_id: agentId } = e as {
      permission_mode?: string;
      agent_id?: string;
    };
    const loop = agentId ?? 'main';
    if (mode !== undefined && (await read($, modesRef))[loop] !== mode) {
      await update($, modesRef, (modes) => ({ ...modes, [loop]: mode }));
    }
    return next(e);
  });

  // The engine raises this only for auto mode's denials, including those made
  // without a classifier verdict.
  on('classic.PermissionDenied', async ($, e, next) => {
    if (reviewCalls.has(e.tool_use_id))
      record($, { event: 'denied', tool_use_id: e.tool_use_id, reason: e.reason.slice(0, 300) });
    return next(e);
  });

  // Only what the user typed authorizes: not a task notification, another
  // session's message, a channel relay, or a prompt dropped beneath.
  on('prompt.submit', async ($, e, next) => {
    const result = await next(e);
    if (
      (e.origin.kind === 'composer' || e.origin.kind === 'bridge') &&
      e.isMeta !== true &&
      result.drop === undefined
    ) {
      await remember($, e.text);
    }
    return result;
  });

  on('tool.check', async ($, e, next) => {
    const core = await next(e);
    if (core.decision !== 'ask') return core;
    if ((await read($, modesRef))[e.agentId ?? 'main'] !== 'auto') return core;

    const id = e.tool_use_id;
    const log = (event: string, details: Record<string, unknown>) => {
      if (id !== undefined)
        record($, { event, tool_use_id: id, agentId: e.agentId, tool: e.tool, ...details });
    };
    const leave = (event: string, details: Record<string, unknown> = {}) => {
      log(event, { ...details, coreReason: core.reason });
      return core;
    };

    if (e.approver === 'host') return leave('owned', { ownedBy: 'approver', approver: e.approver });
    const ownedBy = (Object.keys(OWNS_ASK) as Array<keyof typeof OWNS_ASK>).find(
      (field) => OWNS_ASK[field] && core[field] !== undefined,
    );
    if (ownedBy !== undefined) return leave('owned', { ownedBy, [ownedBy]: core[ownedBy] });
    if (RESERVED_TOOLS.has(e.tool)) return leave('reserved');

    // A hook allow approves the command, not its network grants.
    const domains = (e.input as { allowed_domains?: unknown }).allowed_domains;
    if (
      ['Bash', 'PowerShell', 'Monitor'].includes(e.tool) &&
      Array.isArray(domains) &&
      domains.length > 0
    )
      return leave('network');

    // A call run in the background returns before its output arrives, and the
    // plugin cannot scan what reaches the model later.
    if ((e.input as { run_in_background?: unknown }).run_in_background === true)
      return leave('background');

    const key = `${e.tool} ${JSON.stringify(e.input)}`;
    if (coreCalls.has(key)) return core;
    const verdict = await judgeCall($, settings, e.tool, e.input, e.agentId);
    log('judged', {
      input: loggedInput(e.input),
      coreReason: core.reason,
      verdict: verdict.verdict,
      reason: verdict.reason,
      isAnswered: verdict.isAnswered,
      failure: verdict.failure,
      retried: verdict.retried,
      checks: verdict.checks,
      facts: verdict.facts,
      ms: verdict.ms,
      model: settings.model,
      effort: settings.effort,
      usage: verdict.usage,
    });

    if (id !== undefined) {
      if (verdict.verdict === 'allow') allowedCalls.set(id, key);
      else reviewCalls.add(id);
    }

    if (verdict.verdict !== 'allow') return core;
    return { decision: 'allow', reason: `preallow: ${verdict.reason}` };
  });

  // The person's answer to the agent's question is kept with their words, as
  // the engine gives it: answers keyed by question, several chosen labels
  // joined by commas that a label may also hold, so the judge reads them
  // against the questions the person was shown, which a hook may have
  // rewritten. A dialog that resolved while the person was away holds no
  // answer of theirs.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const result = await next(e);
    if (result.result === undefined || result.isError === true) return result;
    const { answers, annotations, response, questions, afkTimeoutMs } = result.result;
    if (afkTimeoutMs === undefined)
      await remember(
        $,
        `${ANSWER_PREFIX}${JSON.stringify({ answers, annotations, response, questions })}`,
      );
    return result;
  });

  // A call the plugin allowed has its output withheld when it holds a
  // credential-shaped value, since the classifier never saw the call; run
  // again, it goes to the classifier.
  on('tool.call', async ($, e, next) => {
    const result = await next(e);
    const id = e.tool_use_id;
    if (reviewCalls.delete(id)) return result;

    const key = allowedCalls.get(id);
    if (key === undefined) return result;
    if (result.isError === true && result.text?.startsWith(ENGINE_REJECTION) === true) {
      allowedCalls.delete(id);
      coreCalls.add(key);
      record($, { event: 'rejected', tool_use_id: id, reason: result.text.slice(0, 300) });
      return result;
    }

    const why = await withholding($, result.text, result.result, result.context);
    const warning = why === undefined ? undefined : rerunWarning(result.result);
    // Still listed while the scan runs, so `.catch` withholds the output if
    // the scan fails or runs out of time.
    allowedCalls.delete(id);
    if (why === undefined) return result;
    record($, { event: 'withheld', tool_use_id: id, reason: why });
    coreCalls.add(key);
    // After a call that answered without error the engine already tells the
    // model that it ran and a plugin withheld its result.
    const prefix = result.isError === true ? WITHHELD : 'preallow:';
    return { deny: `${prefix} ${why}. ${warning}` };
  }).catch(async ($, e, next) => {
    // The tool has run: a scan that failed or ran out of time must not show
    // the output it was scanning.
    const key = allowedCalls.get(e.tool_use_id);
    if (key === undefined || !next.called) return next(e);
    allowedCalls.delete(e.tool_use_id);
    coreCalls.add(key);
    record($, { event: 'withheld', tool_use_id: e.tool_use_id, reason: 'scanning it failed' });
    // In a catch handler, next replays the settled result without running the tool again.
    const warning = rerunWarning((await next(e)).result);
    return { deny: `${WITHHELD} scanning it failed. ${warning}` };
  });
};
