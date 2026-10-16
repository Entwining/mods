# Repository instructions

This repository is the `entwining-mods` Claude Code marketplace. Each mod is a plugin under `plugins/<mod>/`, listed in `.claude-plugin/marketplace.json`, with its own `README.md`, `LICENSE`, and, where it has invariants beyond this file, an `AGENTS.md`. Read the mod's `AGENTS.md` before changing that mod.

## Layout

- Development tooling lives only at the repository root: a `package.json` with a lockfile inside a plugin folder makes Claude Code install dependencies on every user's machine.
- An install copies only the plugin folder, so anything a mod needs at run time or a user needs to read stays inside it.
- `plugins/<mod>/.claude-plugin/types/` is written by the engine when it loads the mod and holds the machine's MCP tool list; it stays untracked.
- A mod's README is written for the people who install it; what only someone changing the mod needs goes in its AGENTS.md.

## Code

- Use what the mods API, Bun, or the standard library already provides before writing a helper, and add no type, wrapper, or abstraction whose only purpose is to look tidy.
- A guard, fallback, or `catch` handles a failure a real session meets or a documented engine behavior, and comes with the test the Checks section asks for; otherwise leave it out. A case only a constructed input reaches goes in the README's known gaps instead, unless it breaks a promise the README makes.
- A file stays within 200 lines of code (`max-lines`, which skips blank lines and comments, so blank lines that set blocks apart cost nothing; a script's `*.generated.ts` output is not linted). Split it along what its parts do rather than to fit the count; a mod's tests follow the same split, with shared fixtures in `tests/` files not named `*.test.ts`.
- Comments state the reason the code cannot show, not what it does or what it replaced.
- `.oxlintrc.json` enforces the cases of these that a lint rule can catch.

## Checks

`bun run check` runs what CI runs, apart from CI regenerating preallow's gitleaks rules and failing when they differ from the committed file, so a Renovate update of the gitleaks release `scripts/gitleaks.ts` pins waits for someone to run `bun run gitleaks` on its branch. It runs `oxfmt --check`, `oxlint`, `claude plugin validate` for the marketplace and each plugin, `claude plugin test`, and `bun run typecheck:core`, which checks every mod against the plugin API's core declarations that `scripts/core-types.ts` takes from the pinned engine's binary. That check is what keeps an engine update, which Renovate merges once CI passes, from adding a field to an answer a mod reads, such as preallow's `OWNS_ASK`, unnoticed. Tool records are declared only in the types an interactive session writes, so `tool-results.d.ts` types the ones a mod reads, as loosely as it reads them; add a record there when a mod starts reading one. `bun run typecheck` checks a mod against all the engine's declarations (see the README); run it whenever you load a mod from the checkout.

- Tests use synthetic inputs only. This repository is public: no transcripts, logs, real repository names, hostnames, or credentials. Build credential-shaped test strings at run time, such as `` `ghp_${'x'.repeat(36)}` ``, so the source does not look like a leaked key.
- Every safeguard has a test that fails when the safeguard is removed. After adding or changing one, remove it, watch a test fail, and restore it.
- Each test covers a behavior no other test fails on; merge or delete one that fails on the same bug as another, and delete one whose behavior the code no longer has.

## Commits and releases

Use Conventional Commits: `type(scope): summary`, with the mod's name as the scope for a change inside one mod. A change users should receive goes into the `CHANGELOG.md` entry of the mod's next release in the same commit. Versions go 0.0.1, 0.0.2, ... until the user declares a mod 1.0.0, one step per release, not per commit: the first such change after a release on `main` bumps `version` in the mod's `plugin.json` and opens the entry, and later changes before the next release extend that entry. Any change to the `version` string reaches installed users.

Prefer merging a pull request by fast-forwarding `main` to its head (`git merge --ff-only`) and pushing, which GitHub records as the pull request's merge and which keeps the commits CI checked, signatures included; when `main` has moved past the branch's base, rebase the branch, push it, and wait for its checks first. GitHub's merge buttons are also fine, but rebase merge drops the signatures.
