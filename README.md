# mods

Claude Code plugins built on function hooks, published as the `entwining-mods` marketplace.

| Mod                          | What it does                                                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| [preallow](plugins/preallow) | In auto mode, a model judge runs the steps of your task without the classifier, leaving irreversible effects you did not explicitly ask for to it |

## Install

```
/plugin install preallow --marketplace Entwining/mods
```

Answer `y` to add the marketplace, then pick a scope. Each mod's README covers its options.

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
