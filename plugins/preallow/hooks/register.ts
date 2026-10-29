import { atom, read, update } from 'claude-code';
import type { Register, ToolCheckResult } from 'claude-code';

import type { Modes } from '../types';
import { judgeCase, judgePrompt } from './judge.ts';
import { judgeCall, type JudgeSettings } from './stages.ts';
import { loggedInput, record } from './log.ts';
import { rerunWarning, screen, WITHHELD } from './withhold.ts';
import { ANSWER_PREFIX, remember } from './messages.ts';

const modesRef = atom({ plugin: 'preallow', key: 'modes' } as const, {} as Modes);

const JUDGE_MODEL = 'haiku';
const JUDGE_EFFORT = 'high';
const ESCALATION_MODEL = 'opus';
const ESCALATION_EFFORT = 'medium';

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
  // refuses fails that stage's judge call, which does not allow the call.
  // An emptied field counts as unset. The default models are a pair: someone
  // who picks the judge's model is not given a second judge they did not pick.
  const setting = (key: string) => (options[key] as string | undefined) || undefined;
  const model = setting('model');
  const escalationModel =
    setting('escalation_model') ?? (model === undefined ? ESCALATION_MODEL : undefined);
  const settings: JudgeSettings = {
    model: model ?? JUDGE_MODEL,
    effort: setting('effort') ?? JUDGE_EFFORT,
    escalation:
      escalationModel === undefined
        ? undefined
        : { model: escalationModel, effort: setting('escalation_effort') ?? ESCALATION_EFFORT },
  };
  // Calls the plugin allowed, by tool_use_id, so their output is scanned
  // before the model reads it; calls left to the core when they run again,
  // after their output was redacted or withheld or the engine rejected the
  // plugin's allow; the calls the judge left to review, by tool_use_id, with
  // a digest of the judge's first prompt, so a denial of one is logged; and
  // the digests of those auto mode denied.
  const allowedCalls = new Map<string, string>();
  const coreCalls = new Set<string>();
  const reviewCalls = new Map<string, string>();
  const deniedCalls = new Set<string>();

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
    const promptDigest = reviewCalls.get(e.tool_use_id);
    if (promptDigest !== undefined) {
      reviewCalls.delete(e.tool_use_id);
      deniedCalls.add(promptDigest);
      record($, { event: 'denied', tool_use_id: e.tool_use_id, reason: e.reason.slice(0, 300) });
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
    const call = await judgeCase($, e.tool, e.input, e.agentId);
    // The judge's first prompt holds the call with the user's words, so a
    // call auto mode denied comes back the same until the user speaks again;
    // judged again, it could be allowed where nothing lifted the denial. Kept
    // as a digest: a prompt can run to a few hundred kilobytes.
    const hash = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(
        judgePrompt(call)
          .map(({ text }) => text)
          .join(''),
      ),
    );
    const promptDigest = btoa(String.fromCharCode(...new Uint8Array(hash)));
    if (deniedCalls.has(promptDigest)) return leave('repeated');
    const judged = await judgeCall($, settings, call);
    log('judged', { input: loggedInput(e.input), coreReason: core.reason, ...judged });
    const verdict = judged.escalation ?? judged;

    if (id !== undefined) {
      if (verdict.verdict === 'allow') allowedCalls.set(id, key);
      else reviewCalls.set(id, promptDigest);
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

  // A call the plugin allowed has each credential-shaped value in its output
  // redacted, or the output withheld, since the classifier never saw the
  // call; run again, it goes to the classifier.
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

    // Still listed while the scan runs, so `.catch` withholds the output if
    // the scan fails or runs out of time.
    const screened = await screen($, result);
    if (screened === undefined) {
      allowedCalls.delete(id);
      return result;
    }
    coreCalls.add(key);
    if ('redacted' in screened) {
      record($, { event: 'redacted', tool_use_id: id, kinds: screened.kinds });
      // A redacted result stays listed: the engine skips a hook whose answer
      // it refuses and lets the unredacted result stand, unless `.catch`
      // withholds it.
      return screened.redacted;
    }
    allowedCalls.delete(id);
    record($, { event: 'withheld', tool_use_id: id, reason: screened.withheld });
    // After a call that answered without error the engine already tells the
    // model that it ran and a plugin withheld its result.
    const prefix = result.isError === true ? WITHHELD : 'preallow:';
    return { deny: `${prefix} ${screened.withheld}. ${rerunWarning(result.result)}` };
  }).catch(async ($, e, next) => {
    // The tool has run: a scan that failed or ran out of time, or a redacted
    // result the engine refused, must not show the output it was scanning.
    const key = allowedCalls.get(e.tool_use_id);
    if (key === undefined || !next.called) return next(e);
    allowedCalls.delete(e.tool_use_id);
    coreCalls.add(key);
    record($, {
      event: 'withheld',
      tool_use_id: e.tool_use_id,
      reason: 'scanning or redacting it failed',
    });
    // In a catch handler, next replays the settled result without running the tool again.
    const warning = rerunWarning((await next(e)).result);
    return { deny: `${WITHHELD} scanning or redacting it failed. ${warning}` };
  });
};
