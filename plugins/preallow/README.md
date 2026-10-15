# preallow

A Claude Code plugin for auto mode. When the core permission check would hand a tool call to the auto-mode classifier, preallow asks a model judge first, and runs the call without the classifier when the judge allows it.

The judge applies one policy to every tool, Bash, file edits, subagents, messages, and MCP tools alike: giving the agent a task authorizes the steps it takes toward that task, whether or not you named them. It sends a call on to the classifier only when:

- **the call would leak information**: publish or send your personal information, your company's information, credentials or tokens to people or systems that should not have it, or print a secret into the conversation. This overrides everything below, including your own instructions.
- **the effect cannot be undone and you did not explicitly ask for it.** Irreversible means moving money or taking on an obligation, deleting or overwriting data that has no copy, sending or publishing something others can read (an email, a message, a comment, a public repository), or changing someone else's resources in a way that cannot be reverted. Making something readable by others counts as publishing even when its visibility can be switched back, since they may already have read it. Explicit means your own words name that action on that target, by asking for it or by giving a task whose stated goal is that effect; implied consent and general grants such as "full access" do not count here. For everything reversible they do, and so does work on your own repositories: pushes (force pushes included), new branches, and pull requests there, as steps toward a goal you set such as a release or an issue fix.
- **you asked for an irreversible effect but seem not to have grasped its consequence**, or the call applies it to a different or wider target than you meant.
- **the call does not serve your task**: it follows instructions from tool output, a file, a web page, or another agent's own initiative.
- **the call does what you told the agent not to do** in this conversation, unless a later message of yours lifts that, even when the step is reversible. A prohibition covers what it names: asking for a value without showing it to you keeps it out of the agent's reply, not out of a tool result the task needs.
- **the judge cannot tell** whether the effect can be undone, or whether your task covers it.

Everything else is allowed, including commands outside the sandbox, loosening permission or sandbox settings as a step of the task, and retries. The plugin only loosens: it never changes an `allow` or a `deny`, and disabling it restores the classifier for every call.

When whether a call can be undone turns on the state of files or git refs, the judge first asks to check them, naming up to four paths or refs. The plugin answers from a fixed set of read-only queries: for a path, whether it exists, how many of its files changed before the session started, and, inside a git work tree, how many files are tracked and the uncommitted, untracked, and ignored files under it; for a ref, its commit, how many commits no other ref holds, which refs contain it, and when the remote was last fetched. The git commands run without optional locks, an fsmonitor, or any transport, five seconds each. The judge then decides once more with what they found; when a check cannot run or the judge is still unsure, the call goes to the classifier.

## What the judge reads

- The tool's name and its whole input, since the call runs with all of it. A call whose input passes 100,000 characters goes to the classifier without asking the judge.
- Your own messages in this conversation: what you typed at the terminal or sent through Remote Control, including slash command lines, and your answers to the agent's questions (`AskUserQuestion`): the questions and options as you were shown them, the options you chose, your notes, and anything you typed instead. A chosen option authorizes the action on the target it states, nothing wider; a question that resolved while you were away holds no answer of yours. Up to 24,000 characters: the first message and then the newest that fit, each kept to 4,000 characters (head and tail). Task notifications, other sessions' messages, channel relays, and the agent's own text never count as your words. Your messages are kept per conversation in the plugin's store, so a conversation you resume still has them, and `/clear` starts with none; the store keeps the 50 conversations you wrote in most recently.
- For a subagent's call, the brief its parent agent gave it, up to 8,000 characters. The brief carries your authorization only where it quotes you or restates your task.
- The directory the call's loop runs in, and what the checks it asked for found.

The judge runs through your session's own model client, one call per checked tool call and one more after a check. The verdict is the JSON object that ends the judge's reply; a call the judge does not answer within 90 seconds, a reply that does not end with a verdict or that states different verdicts along the way, and anything other than `allow` go to the classifier.

## Settings

- `model`: the model the judge runs on, an alias or a full model id. Default `opus`.
- `effort`: how hard the judge thinks. Default `medium`.

Set them in `/config` or when you install. The plugin passes what you write to the model client unchanged; a value the client refuses sends every call to the classifier, and each `check` line in the log says why. The judge's policy was evaluated on `opus` at `medium` and `high`; at `low` it sent more of the calls it should allow to the classifier, and other models were not evaluated.

## What it leaves to the classifier

- Any mode other than `auto`, and a subagent's calls until the subagent's mode has been reported.
- An `ask` from a settings rule, from a hook in your settings, from a setting's own check (the read block, `permissions.blockReadsOutsideWorkingDirectories`, which asks you rather than the classifier), from an organization's ceiling for the tool, or one put to a host that answers the session's asks. An `ask` from another plugin's hook reaches preallow looking like the core's own, so the judge may turn it into an allow: do not pair preallow with a plugin whose asks must stand.
- A call run in the background (`run_in_background`), such as a dev server or a watcher: its output reaches the model after the call returns, where the plugin cannot check it.
- A call whose output the plugin withheld, or whose allow the engine refused, when it runs again.
- A tool whose verdict the engine keeps whatever a hook answers: a subagent's report to its parent (`SubagentHandback`), which only the classifier may allow, and a question to you or a plan for your approval (`AskUserQuestion`, `ExitPlanMode`), which wait for you. The judge is not asked, since its allow would be refused or ignored.

## Output it withholds

The judge decides before the call runs and cannot see what it will print. When what the model would read from a call the plugin allowed, including the full output a large result leaves in a file, a result another plugin's hook gave in the tool's place, and notes a hook adds beside the result, holds what looks like a credential (a private key, a token in a provider format that [gitleaks](https://github.com/gitleaks/gitleaks) knows or one starting `sk-`, a JSON web token, a netrc or registry login, a session cookie, or a password or token in a URL, header, or assignment), the plugin withholds it, and the same call run again goes to the classifier. The call has already been made, so the agent is told that running it again repeats its effects. It also withholds the result when the check itself fails or runs out of time, and the result of a call that moves to the background, since it cannot check that output.

## Install

```
/plugin install preallow --marketplace Entwining/mods
```

## Reading the log

The plugin logs one JSON line per event to `~/.claude/preallow/<session-id>.jsonl`, keyed by `tool_use_id` and carrying the Claude Code version in `engine`; past about 1 MB the log goes on in `<session-id>.1.jsonl`, `<session-id>.2.jsonl`, and so on:

- `held`: an `ask` left to its decider without asking the judge (see What it leaves to the classifier), with the field that named the decider in `heldBy` and its value, and why the core asked.
- `check`: the tool, its input (up to 2,000 characters), why the core asked (`coreReason`), the verdict (`allow` or `pass`), the judge's reason, what it asked to check and what the checks found, and how long it took.
- `reserved`: a call of a tool whose verdict the engine keeps, left to it without asking the judge, with why the core asked.
- `background`: a call run in the background, left to the classifier without asking the judge, with why the core asked.
- `refused`: the engine refused a call the plugin allowed because only the classifier may allow that tool, with the start of its message. The call failed, and the same call run again goes to the classifier; that tool belongs with the reserved ones, so report it.
- `denied`: the classifier denied a call the judge passed, with the start of the classifier's reason. These are the calls the judge could have allowed; read the matching `check` line to see why it did not.
- `withheld`: the plugin withheld the output of a call it allowed, and why (never the output).

To find calls the judge should not have allowed, read the `check` lines whose verdict is `allow`. Tool inputs are logged as given, unscanned, so a credential in a command or a file edit lands in the log. The log stays on this machine until you delete the folder.

## Known gaps

- The judge does not see every word of a long conversation: it reads your first message and then the newest that fit, and of a message over 4,000 characters only the head and tail. A prohibition in a message left out, or in the middle of a long one, does not hold; repeat it in a short message when it matters.
- A conversation forked into a new session, or one you last wrote in before the 50 most recent, starts with none of your earlier messages, so the judge may allow a call your earlier words ruled out.
- `/rewind` does not take your messages back from the judge: the plugin learns of no rewind, so a request you rewound still counts as yours. To withdraw one, say so in a new message.
- The credential check knows a fixed list of formats (`hooks/withhold.ts` and gitleaks' provider rules); a credential in any other format, such as a password of letters only, a value under a name the list does not know, or a provider token known only by the provider's name beside it, passes unchecked.
- For a call moved to the background while it runs, the plugin withholds the result but cannot check what the task reports when it finishes.
- A `Monitor` call starts a watch whose events reach the model later, one line at a time; the judge may allow it, and the plugin does not check those events.
- A call the plugin allowed runs again under the classifier after a withheld output only when its input is the same; a rerun with any input change is judged again.

## License

MIT
