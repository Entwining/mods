# preallow

preallow lets Claude Code auto mode run task steps without its classifier when a model judge allows them. It requires Claude Code 2.1.308 or later.

## Judge task steps

The judge [applies one policy to every tool](docs/usage.md#what-the-judge-allows). It allows task steps that can be undone and irreversible effects you explicitly requested. Leaks, calls outside your task, and calls that violate your instructions stay with native approval.

## Keep native approval boundaries

preallow never changes an `allow` or a `deny`. [Settings rules, other approval owners, and calls it cannot cover](docs/usage.md#what-it-leaves-to-native-approval) keep native approval. Disabling the plugin restores Claude Code's native flow.

## Redact credential-shaped output

For calls it allowed, preallow [redacts credential-shaped values or withholds output it cannot redact](docs/usage.md#output-it-redacts). The scan can miss credentials and redact text that is not a credential. It does not scan calls Claude Code or the classifier allowed.

## Configure the judges

You can [choose the models and effort in `/config`](docs/usage.md#settings). A second judge can review calls the first did not allow. Each judge reads [your kept messages and the call's input](docs/usage.md#what-the-judge-reads).

## Install

```sh
claude plugin install preallow --marketplace Entwining/mods
```

Start a new session after installing or updating. Third-party marketplace plugins require [enabling auto-update or updating manually](docs/usage.md#install).

## Know the limits

Managed Claude Code setups can [keep every call from reaching the judge](docs/usage.md#what-it-leaves-to-native-approval). The judge can lose earlier instructions, and output delivered later can escape the scan. The [known gaps](docs/usage.md#known-gaps) describe these limits and the scan's misses and false positives.

Tool inputs are logged without scanning. A credential in a command or file edit lands in the local log. The [log records verdicts, failures, and redaction events](docs/usage.md#reading-the-log).

preallow is released under the [MIT License](LICENSE).
