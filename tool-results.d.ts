// The records of tools a mod reads, which the core declarations leave to
// the tool declarations an interactive session writes, typed only as loosely
// as the mods read them, so `bun run typecheck:core` can check the rest in
// CI; `bun run typecheck` checks them against the engine's own.
declare module 'claude-code' {
  interface BuiltinToolResults {
    AskUserQuestion: {
      questions: unknown;
      answers: unknown;
      response?: unknown;
      annotations?: unknown;
      afkTimeoutMs?: unknown;
    };
  }
}
