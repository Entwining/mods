// What a session raises at the plugin, and what the judge was asked.

import type { Engine } from 'claude-code/testing';
import type { ToolCheckResult } from 'claude-code';

import type { World } from './world.ts';

export async function auto($: Engine, mode = 'auto', agentId?: string) {
  if (agentId === undefined)
    await $.classic.UserPromptSubmit({ prompt: '', permission_mode: mode } as never);
  else
    await $.classic.SubagentStart({
      agent_id: agentId,
      agent_type: 'x',
      permission_mode: mode,
    } as never);
}

export function check(
  $: Engine,
  tool: string,
  input: Record<string, unknown>,
  call: Record<string, unknown> = {},
): Promise<ToolCheckResult> {
  return $.tool.check({ tool, input, tool_use_id: 't1', ...call } as never);
}

export const bash = (command: string) => ({ command });

export function say(
  $: Engine,
  text: string,
  kind = 'composer',
  extra: Record<string, unknown> = {},
) {
  return $.prompt.submit({ text, wait: false, origin: { kind }, ...extra } as never);
}

export function judged(w: World, index = -1) {
  return JSON.parse(w.modelCalls.at(index)!.prompt) as {
    user_messages: string[];
    subagent_brief?: string;
    tool: string;
    input: unknown;
    facts?: { answers: unknown[] };
  };
}

// The user's words the store keeps for a conversation.
export const turnsOf = (w: World, session = 's1') =>
  (w.store.get(`turns:${session}`) as { turns: string[] } | undefined)?.turns;
