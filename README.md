# mods

Claude Code plugins published as the `entwining-mods` marketplace. The plugins use function hooks to change how Claude Code handles tool calls.

## Let task steps run in auto mode

[preallow](plugins/preallow) asks a model judge before Claude Code's auto-mode classifier. Calls the judge allows run without the classifier. Other calls keep Claude Code's native approval flow.

## Install

```sh
claude plugin install preallow --marketplace Entwining/mods
```

Start a new session after installing. Third-party marketplace plugins do not update automatically unless you [enable auto-update](plugins/preallow/docs/usage.md#install).

## Development

Contributors [validate and test mods with the pinned Claude Code engine](docs/development.md). [AGENTS.md](AGENTS.md) defines the constraints for changes to the marketplace and its plugins.

The marketplace is released under the [MIT License](LICENSE).
