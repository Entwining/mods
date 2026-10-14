// The permission mode each loop last reported, by subagent id or `main`.
export type Modes = Record<string, string>;

declare module 'claude-code' {
  interface PluginState {
    preallow: { modes: Modes };
  }
}
