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

To run a mod from this checkout, start a session with `claude --plugin-dir plugins/<mod>`. That session also writes the mod's generated types to `plugins/<mod>/.claude-plugin/types/`, after which `bun run typecheck` type-checks it. The types are those of the engine running the session, as the first line of `claude-code/index.d.ts` there says, so start it with `bunx claude` to check against the pinned version. CI cannot generate those types, so run the type check yourself after bumping the pinned `@anthropic-ai/claude-code`.

## License

MIT
