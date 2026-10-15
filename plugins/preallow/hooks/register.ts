import { atom, read, update } from 'claude-code';
import type { Register, ToolCheckResult } from 'claude-code';

import type { Modes } from '../types';
import { judgeCall, type JudgeSettings } from './judge.ts';
import { loggedInput, record } from './log.ts';
import { RERUN, WITHHELD, withholding } from './withhold.ts';
import { ANSWER_PREFIX, remember } from './words.ts';

const modesRef = atom({ plugin: 'preallow', key: 'modes' } as const, {} as Modes);

// What the judge runs on when the user leaves the `model` or `effort`
// setting empty.
const JUDGE_MODEL = 'opus';
const JUDGE_EFFORT = 'medium';

// Tools whose verdict the engine keeps whatever a hook answers: it refuses a
// hook's allow of a subagent's handback, which only the classifier may allow,
// and a question or a plan waits for the person.
const ENGINE_DECIDED = new Set(['SubagentHandback', 'AskUserQuestion', 'ExitPlanMode']);

// The fields of the core's answer that put an ask to someone other than the
// classifier: a settings rule, a classic hook, an option's own check (the read
// block, which asks the person), a host that answers the session's asks, and
// an organization's ceiling. Every field but the verdict and its reason is
// listed, so `bun run typecheck` fails on a field the engine adds until it is
// marked here; a field marked false is read as information and leaves the ask
// to the judge.
const HOLDS_ASK = {
  rule: true,
  hook: true,
  setting: true,
  decider: true,
  ceiling: true,
} satisfies Record<Exclude<keyof ToolCheckResult, 'decision' | 'reason'>, boolean>;

// How the engine reports refusing a hook's allow of a tool only the
// classifier may allow.
const ENGINE_REFUSAL = 'Only the auto-mode classifier can allow';

// How the core reports a call the auto-mode classifier denied; the denial
// carries no `deny` field.
const CLASSIFIER_DENIAL =
  'Permission for this action was denied by the Claude Code auto mode classifier';

export const register: Register = (on, options) => {
  // The settings go to the model client as the user wrote them; a value it
  // refuses fails the judge call, which leaves the call to the classifier.
  // An emptied field counts as unset.
  const settings: JudgeSettings = {
    model: (options.model as string | undefined) || JUDGE_MODEL,
    effort: (options.effort as string | undefined) || JUDGE_EFFORT,
  };
  // Calls the plugin allowed, by tool_use_id, so their output is checked
  // before the model reads it; calls left to the core when they run again,
  // after their output was withheld or the engine refused the plugin's allow;
  // and the calls the judge passed, so a classifier denial of one is logged.
  const allowedCalls = new Map<string, string>();
  const coreCalls = new Set<string>();
  const passedCalls = new Set<string>();

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
    // Leaves the ask to the core without asking the judge.
    const leave = (event: string, details: Record<string, unknown> = {}) => {
      log(event, { ...details, coreReason: core.reason });
      return core;
    };
    const heldBy = (Object.keys(HOLDS_ASK) as Array<keyof typeof HOLDS_ASK>).find(
      (field) => HOLDS_ASK[field] && core[field] !== undefined,
    );
    if (heldBy !== undefined) return leave('held', { heldBy, [heldBy]: core[heldBy] });
    if (ENGINE_DECIDED.has(e.tool)) return leave('reserved');
    // A call run in the background returns before its output arrives, and the
    // plugin cannot check what reaches the model later.
    if ((e.input as { run_in_background?: unknown }).run_in_background === true)
      return leave('background');
    const key = `${e.tool} ${JSON.stringify(e.input)}`;
    if (coreCalls.has(key)) return core;
    const verdict = await judgeCall($, settings, e.tool, e.input, e.agentId);
    log('check', {
      input: loggedInput(e.input),
      coreReason: core.reason,
      verdict: verdict.verdict,
      reason: verdict.reason,
      checked: verdict.checked,
      facts: verdict.facts,
      ms: verdict.ms,
    });
    if (id !== undefined) {
      if (verdict.verdict === 'allow') allowedCalls.set(id, key);
      else passedCalls.add(id);
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
  // again, it goes to the classifier. A call the judge passed and the
  // classifier denied is logged.
  on('tool.call', async ($, e, next) => {
    const result = await next(e);
    const id = e.tool_use_id;
    if (passedCalls.delete(id)) {
      if (result.isError === true && result.text?.startsWith(CLASSIFIER_DENIAL) === true)
        record($, {
          event: 'denied',
          tool_use_id: id,
          denial: result.text.slice(CLASSIFIER_DENIAL.length, CLASSIFIER_DENIAL.length + 300),
        });
      return result;
    }
    const key = allowedCalls.get(id);
    if (key === undefined) return result;
    if (result.isError === true && result.text?.startsWith(ENGINE_REFUSAL) === true) {
      allowedCalls.delete(id);
      coreCalls.add(key);
      record($, { event: 'refused', tool_use_id: id, refusal: result.text.slice(0, 300) });
      return result;
    }
    const why = await withholding($, result.text, result.result, result.context);
    // Still listed while the check runs, so `.catch` withholds the output if
    // the check fails or runs out of time.
    allowedCalls.delete(id);
    if (why === undefined) return result;
    record($, { event: 'withheld', tool_use_id: id, why });
    coreCalls.add(key);
    return { deny: `${WITHHELD} ${why}. ${RERUN}` };
  }).catch(($, e, next) => {
    // The tool has run: a check that failed or ran out of time must not show
    // the output it was checking.
    const key = allowedCalls.get(e.tool_use_id);
    if (key === undefined || !next.called) return next(e);
    allowedCalls.delete(e.tool_use_id);
    coreCalls.add(key);
    return { deny: `${WITHHELD} checking it failed. ${RERUN}` };
  });
};
