export type GrantClass = 'push' | 'force_push' | 'remote_branch_delete' | 'tag_push' | 'pr_merge';

// What the user authorized, as extracted from one of their messages.
export type Grant = {
  id: string;
  class: GrantClass;
  // `host/owner/name`.
  repo: string;
  branch?: string;
  // Whether `branch` appears in the quote of the user's own words.
  isBranchUserNamed: boolean;
  number?: number;
  tag?: string;
  isOneShot: boolean;
  // `user`: the user's message names the action. `plan`: the user approved a
  // proposal from the assistant's previous answer that names it.
  namedBy: 'user' | 'plan';
  quote: string;
  prompt: number;
};

export type Ledger = {
  grants: Grant[];
  // One-shot grants an allowed call is using, by tool_use_id; returned to
  // `grants` if that call is denied before it runs.
  held: Record<string, Grant[]>;
  // The main loop's last answer: the proposal the next message may approve.
  lastAnswer: string;
  // The permission mode each loop last reported, by subagent id or `main`.
  modes: Record<string, string>;
  prompts: number;
};

declare module 'claude-code' {
  interface PluginState {
    preallow: { ledger: Ledger };
  }
}
