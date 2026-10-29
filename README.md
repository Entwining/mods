# mods

Claude Code plugins built on function hooks, published as the `entwining-mods` marketplace.

| Mod                          | What it does                                                                                                                                                                      |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [preallow](plugins/preallow) | In auto mode, a model judge allows the steps of your task without the classifier, leaving the rest to it, such as a leak or an irreversible effect you did not explicitly ask for |

## Install

```sh
claude plugin install preallow --marketplace Entwining/mods
```

This installs for your user. To pick a scope interactively, run `/plugin install preallow --marketplace Entwining/mods` in a Claude Code session. Each mod's README covers its options.

Claude Code does not update plugins from third-party marketplaces by default. In `/plugin`, select `entwining-mods` on the Marketplaces tab and choose **Enable auto-update**, or run `claude plugin update preallow@entwining-mods` manually. Start a new session after installing or updating.

## Development

Requires [Bun](https://bun.sh). The pinned `@anthropic-ai/claude-code` dev dependency supplies the engine that validates and tests the mods.

```sh
bun install
bun run check   # format check, lint, plugin validation, tests
bun run fmt     # format in place
```

To run a mod from this checkout, start a session with `bunx claude --plugin-dir plugins/<mod>`, which runs the pinned engine. That session writes the mod's generated types to `plugins/<mod>/.claude-plugin/types/`, where the first line of `claude-code/index.d.ts` names the engine that wrote them, and `bun run typecheck` then checks the mod against them. CI checks the mods against the core declarations it takes from the engine's binary (`bun run typecheck:core`, part of `bun run check`); the declarations of each tool's record come only from such a session, so the full check runs on your machine.

## License

MIT
