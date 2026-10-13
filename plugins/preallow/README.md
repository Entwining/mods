# preallow

A Claude Code plugin for auto mode. When the core permission check would hand a Bash call to the auto-mode classifier, preallow answers two kinds of call itself:

- **Read-only commands.** Every segment of the command line is a program and option set the plugin knows only reads, such as `git log`, `rg`, `ls`, or `gh pr view` (plus `mktemp`, which only creates a new empty file or directory). The call still runs in the sandbox. If its output, including the full output a large result leaves in a file, holds what looks like a credential (a private key, a known API key format, a JSON web token, a netrc or registry login, or a password or token in a URL, header, or assignment), the plugin withholds the output, and the same command run again goes to the classifier. It also withholds the result of a read that moves to the background while it runs, since it cannot check that output.
- **Outward actions you authorized.** A `git push` (including force push, tag push, and remote branch deletion) or a pull or merge request merge that a grant covers. A grant comes from your own typed message, such as "push this branch" or "ok" to an answer that proposed the push. A small model reads it after you send the message, without holding the message up; an outward action waits for it. The plugin keeps a grant only when its quote names the action and appears verbatim in your own words (or in the answer you approved), and a toast reads it back. Text you paste in a code block or as a `>` quote grants nothing, and lines an answer quotes are not part of its proposal.

Everything else goes to the classifier as before. The plugin only loosens: it never changes an `allow` or `deny`, and disabling it restores the classifier for every call.

## What it leaves to the classifier

- Any mode other than `auto`, and a subagent's calls until the subagent's mode has been reported.
- Calls that set `dangerouslyDisableSandbox`, `allowed_domains`, or `run_in_background`, sessions with the sandbox off, and programs listed in `sandbox.excludedCommands` (except `git`, whose read forms the plugin limits to options that read only the repository).
- Shell syntax it does not read: heredocs, subshells, groups, `case`, functions, background jobs, process substitution, arithmetic, and parameter expansions beyond a name with a default, trim, or replace operator.
- For programs whose read-only forms depend on their options (`find`, `git`, `gh`, `sort`, and others), any word the shell could turn into an option: a substitution, a glob or brace expansion at the start of a word, or a variable whose value the command line does not fix. Loop variables over written values and variables assigned a written value earlier in the line are read as those values.
- Reads whose command line names secret material, such as an API key, token, password, or credential. The sandbox decides what a read can open, not whether printing it into the conversation is fine, and the classifier judges that case by case.
- Comments, pull or merge request bodies, a merge's own subject or body, issues, and releases: a grant cannot bind the text you would want to preview.
- Outward actions in a subagent, which may work in a worktree of its own, and outward actions whose directory is uncertain: the plugin resolves targets in the directory a leading `cd /absolute/path &&` enters, or else in the session's directory, which is the shell's only when `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR` is `1`. Any other `cd` sends the call to the classifier.
- Outward actions whose target cannot be pinned down: a push that `push.default` or a configured push refspec may send elsewhere, a tag deletion, a merge named by branch, or a remote that is not a named remote.
- A force push to, or deletion of, the default branch, unless the words of your own message that grant it name that branch, as in "force push main".
- A command line with several outward actions, or with a command the plugin does not read before an outward action, such as `git commit -m x && git push`.

Grants belong to the repository of the session's `origin` remote, host included; a repository your message names is taken to be on the same host. A session whose `origin` is a local path records no grants. A merge grant without a request number covers one merge. Grants last until they are used (a one-shot grant), withdrawn, or the conversation ends. While grants stand, the model reads every message you send and judges whether it takes them back, so "not now" or "keep it local" withdraws them; a message that names no action and approves none grants nothing new. If the model gives no answer, or a grant from an earlier message is still being read, a message with words that may take an authorization back ("don't", "wait", "instead", "先别", "算了") withdraws every earlier grant. Interrupting a turn withdraws them too, and `/clear` or resuming another conversation starts with none. `/grants` lists the current grants, and `/grants clear` withdraws them.

Git runs outside the sandbox when it is in `sandbox.excludedCommands`, and its read commands then run any program git's own configuration names, such as an external diff, a textconv or clean filter, or a signing program, and read any repository a `-C` option names. The plugin trusts git's configuration as the classifier does when it allows `git diff`, so the sandbox should not let commands write git's configuration files.

## Install

```
/plugin install preallow --marketplace Entwining/mods
```

## Modes

The plugin starts in `shadow` mode: it decides every call but only logs the decision, one JSON line per call, to `~/.claude/preallow/<session-id>.jsonl`. The log holds each checked command's text (up to 2,000 characters), each recorded grant with its quote, and why each output was or would have been withheld (never the output), and stays on this machine until you delete the folder. Compare the log with what the classifier did before changing the `mode` option in `/config`: `reads` allows read-only commands and still only logs granted actions, and `enforce` allows both.

## Known gaps

- An authorization that waits on a condition the agent checks itself, such as "push it if the tests pass", is often not recorded, so those pushes still go to the classifier.
- When the remote's default branch is unknown (no `refs/remotes/origin/HEAD`), every branch is treated as the default branch for force pushes and deletions.
- An answer that relays someone else's request, in a code block or in prose, can be approved with "ok" like a proposal of the agent's own; only lines it quotes with `>` are left out.
- The credential check knows a fixed list of formats (`hooks/secrets.ts`); a credential in any other format, such as a password of letters only or a value under a name the list does not know, passes unchecked.
- For a read moved to the background while it runs, the plugin withholds the result but cannot check what the task reports when it finishes.

## License

MIT
