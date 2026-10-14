# Repository instructions

This repository is the `entwining-mods` Claude Code marketplace. Each mod is a plugin under `plugins/<mod>/`, listed in `.claude-plugin/marketplace.json`, with its own `README.md`, `LICENSE`, and, where it has invariants beyond this file, an `AGENTS.md`. Read the mod's `AGENTS.md` before changing that mod.

## Layout

- Development tooling lives only at the repository root: a `package.json` with a lockfile inside a plugin folder makes Claude Code install dependencies on every user's machine.
- An install copies only the plugin folder, so anything a mod needs at run time or a user needs to read stays inside it.
- `plugins/<mod>/.claude-plugin/types/` is written by the engine when it loads the mod and holds the machine's MCP tool list; it stays untracked.

## Code

- Use what the mods API, Bun, or the standard library already provides before writing a helper, and add no type, wrapper, or abstraction whose only purpose is to look tidy.
- A guard, fallback, or `catch` handles an observed failure or a documented engine behavior, and comes with the test the Checks section asks for; otherwise leave it out.
- Comments state the reason the code cannot show, not what it does or what it replaced.
- `.oxlintrc.json` enforces the cases of these that a lint rule can catch.

## Checks

`bun run check` runs what CI runs: `oxfmt --check`, `oxlint`, `claude plugin validate` for the marketplace and each plugin, and `claude plugin test`. `bun run typecheck` needs the generated types (see the README) and does not run in CI.

- Tests use synthetic inputs only. This repository is public: no transcripts, logs, real repository names, hostnames, or credentials. Build credential-shaped test strings at run time, such as `` `ghp_${'x'.repeat(36)}` ``, so the source does not look like a leaked key.
- Every safeguard has a test that fails when the safeguard is removed. After adding or changing one, remove it, watch a test fail, and restore it.
- Each test covers a behavior no other test fails on; merge or delete one that fails on the same bug as another, and delete one whose behavior the code no longer has.

## Commits and releases

Use Conventional Commits: `type(scope): summary`, with the mod's name as the scope for a change inside one mod. A change users should receive goes into the `CHANGELOG.md` entry of the mod's next release in the same commit. Versions go 0.0.1, 0.0.2, ... until the user declares a mod 1.0.0, one step per release, not per commit: the first such change after a release on `main` bumps `version` in the mod's `plugin.json` and opens the entry, and later changes before the next release extend that entry. Any change to the `version` string reaches installed users.
