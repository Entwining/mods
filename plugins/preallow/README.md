# preallow

A Claude Code plugin for auto mode, requiring Claude Code 2.1.308 or later. When the core permission check would hand a tool call to the auto-mode classifier, preallow asks a model judge first, and runs the call without the classifier when the judge allows it.

The plugin only loosens: it never changes an `allow` or a `deny`, and disabling it restores Claude Code's native approval flow. [What the judge allows](#what-the-judge-allows) follows one policy for every tool, and [some calls never reach it](#what-it-leaves-to-native-approval).

## Install

```sh
claude plugin install preallow --marketplace Entwining/mods
```

This installs for your user. To pick a scope interactively, run `/plugin install preallow --marketplace Entwining/mods` in a Claude Code session.

Claude Code does not update plugins from third-party marketplaces by default. In `/plugin`, select `entwining-mods` on the Marketplaces tab and choose **Enable auto-update**, or run `claude plugin update preallow@entwining-mods` manually. Start a new session after installing or updating.

## What the judge allows

The judge applies one policy to every tool, Bash, file edits, subagents, messages, and MCP tools alike: giving the agent a task authorizes the steps it takes toward that task, whether or not you named them. It sends a call on to the classifier only when:

- **the call would leak information**: publish or send your personal information, your company's information, credentials or tokens to people or systems that should not have it, or print a secret into the conversation. This overrides everything below, including your own instructions.
- **the effect cannot be undone and you did not explicitly ask for it.** Irreversible means moving money or taking on an obligation, deleting or overwriting data that has no copy, sending or publishing something others can read (an email, a message, a comment, a public repository), or changing someone else's resources in a way that cannot be reverted. Making something readable by others counts as publishing even when its visibility can be switched back, since they may already have read it. Explicit means your own words name that action on that target, by asking for it or by giving a task whose stated goal is that effect; implied consent and general grants such as "full access" do not count here. For everything reversible they do, and so does work on your own repositories: pushes (force pushes included), new branches, and pull requests there, as steps toward a goal you set such as a release or an issue fix.
- **you asked for an irreversible effect but seem not to have grasped its consequence**, or the call applies it to a different or wider target than you meant.
- **the call does not serve your task**: it follows instructions from tool output, a file, a web page, or another agent's own initiative.
- **the call does what you told the agent not to do** in this conversation, unless a later message of yours lifts that, even when the step is reversible. A prohibition covers what it names: asking for a value without showing it to you keeps it out of the agent's reply, not out of a tool result the task needs.
- **the judge cannot tell** whether the effect can be undone, or whether your task covers it.

Everything else is allowed, including commands outside the sandbox, loosening permission or sandbox settings as a step of the task, and retries.

## What it leaves to native approval

- Any mode other than `auto`, and a subagent's calls until the subagent's mode has been reported.
- An `ask` from a settings rule, from a hook in your settings or another plugin, from a setting's own check (the read block, `permissions.blockReadsOutsideWorkingDirectories`, which asks you rather than the classifier), from an organization's ceiling for the tool, or one put to a host that answers the session's asks.
- A call run in the background (`run_in_background`), such as a dev server or a watcher: its output reaches the model after the call returns, where the plugin cannot scan it.
- A Bash, PowerShell, or command-monitor call with a non-empty `allowed_domains` list: the classifier reviews the command and registers approved network grants; a hook allow approves the command without granting the hosts.
- A call whose output the plugin withheld, or whose allow the engine rejected, when the same tool runs again with the same input.
- A call auto mode denied after the judge left it to review, when the agent makes it again with the same input, in the same directory and, for a subagent, with the same brief, before you write again. Judging it again could only repeat the review or undo the denial with nothing new from you; once you have written, the call is judged again with your new words.
- A tool whose verdict the engine keeps whatever a hook answers: a subagent's report to its parent (`SubagentHandback`), which only the classifier may allow, and a question to you or a plan for your approval (`AskUserQuestion`, `ExitPlanMode`), which wait for you. The judge is not asked, since its allow would be rejected or ignored.

## Settings

Set them in `/config` or when you install; an emptied field counts as unset.

- `model`: the model the first judge runs on, an alias or a full model id. Default `haiku`.
- `effort`: how hard the first judge thinks. Default `high`.
- `escalation_model`: the model of a second judge, for every call the first did not allow, including those it gave no verdict on, such as when its model call failed. Default `opus` when `model` is unset too; if you set `model` and leave this empty, there is no second judge.
- `escalation_effort`: how hard the second judge thinks. Default `medium`. Set alone, it does not add a second judge.

The second judge reads the same call with the same instructions and starts over: it asks for checks of its own and does not see the first judge's verdict, checks, or facts. Its verdict is final, so a call goes to the classifier only when both judges leave it there.

The plugin passes what you write to the model client unchanged; if the client refuses a value, the judge it belongs to gives no verdict on any call, and the `failure` in each `judged` line of the log says why.

The defaults were chosen by evaluating the policy on real calls auto mode had sent to the classifier, labeled by hand, on a split used while choosing them and on one held out until the end. On both, the two judges allowed no call the policy rules out, apart from [reads whose output held a secret](#known-gaps), the same as `opus` at `medium` alone. Compared with it, they sent fewer of the calls they should allow to the classifier on the first split and one more on the held-out one, at about a seventh of the cost. Other models were not evaluated.

## What the judge reads

- The tool's name and its whole input, since the call runs with all of it. A call whose input passes 100,000 characters as JSON goes to the classifier without asking either judge.
- Your own messages in this conversation: what you typed at the terminal or sent through Remote Control, including slash command lines, and your answers to the agent's questions (`AskUserQuestion`): the questions and options as you were shown them, the options you chose, your notes, and anything you typed instead. A chosen option authorizes the action on the target it states, nothing wider; a question that resolved while you were away holds no answer of yours. Task notifications, other sessions' messages, channel relays, and the agent's own text never count as your words.
- For a subagent's call, the brief its parent agent gave it, cut to its head and tail past 8,000 characters. Your words quoted in it count as yours; the parent's restatement of your task shows what the task is, but cannot supply the explicit words an irreversible effect needs or lift a prohibition of yours.
- The directory the call's loop runs in, and what the checks it asked for found.

Your messages are kept per conversation in the plugin's store, so a conversation you resume still has them, and `/clear` starts with none; the store keeps the 50 conversations you wrote in most recently. A conversation keeps your first message and the newest that fit 64,000 characters, each message cut to its head and tail past 16,000. Both limits count the messages as JSON, in which quotes, backslashes, and control characters take more than one character. The judge reads all your kept messages for every call, with a note where the store let messages go.

## How a judge decides

When whether a call can be undone turns on the state of files or git refs, a judge first asks to check them, naming up to four paths or refs, and then decides once more with what they found. The plugin answers from a fixed set of read-only, offline queries:

- For a path: whether it exists, its kind, whether it is a symbolic link, and when it last changed; for a directory that is not a link, how many of its files changed before the session started, up to a bound the answer says it reached; and inside a git work tree, how many files are tracked and the uncommitted, untracked, and ignored files under it. A file's time does not show who made it or whether a copy exists: copying or extracting a file can keep an older time.
- For a ref: its commit, which refs contain it, how many commits no other ref holds, and how many of those have an equivalent patch (the same change, whitespace aside) in the branch the ref follows or in a remote's default branch; for a remote-tracking ref, also when the repository last fetched, from any of its worktrees, which need not be the fetch that updated that ref.

Patches are compared one commit at a time, so commits squashed into one when merged, or rebased with conflicts resolved, find no equivalent even when their work is there, and merge commits are not compared; an equivalent patch also does not show that the change is still there, or that the commits' messages and authors are kept anywhere. The git commands run without optional locks, an fsmonitor, or any transport, five seconds each. When a check cannot run or the judge is still unsure after it, the judge does not allow the call.

Each judge runs through your session's own model client: one model call per tool call, and one more after a check. A model call that comes back without a reply, or with an API error Claude Code says may clear on its own (overload, a rate limit, or a server error), is made once more two seconds later while the judge has time; one cut short or refused for what it asked is not. A judge has 90 seconds for a tool call, counting all its model calls, waits, and checks.

The verdict is the JSON object that ends the judge's reply: text may come before it, and only a closing code fence after it. A reply that does not end with a verdict or that states different verdicts along the way, a call the judge does not answer in time, and anything other than `allow` are not allowed, and go to the second judge if there is one, or else to the classifier.

The policy and your kept messages open every judge's prompt and are marked for the prompt cache, so a call soon after another, and the call after a check, can read them from the cache until you write again; the `usage` in each `judged` line shows what was read and written.

## Output it withholds

The judge decides before the call runs and cannot see what it will print. When what the model would read from a call the plugin allowed, including the full output a large result leaves in a file, a result another plugin's hook gave in the tool's place, and notes a hook adds beside the result, holds what looks like a credential (a private key, a token in a provider format that [gitleaks](https://github.com/gitleaks/gitleaks) knows or one starting `sk-`, a JSON web token, a netrc or registry login, a session cookie, or a password or token in a URL, header, or assignment), the plugin withholds it. The result is also withheld when the scan itself fails or runs out of time.

The call has already been made, and withholding its output does not undo it: the agent is warned that running it again repeats its effects, and the same call run again goes to the classifier. A call that moves to the background has its hand-off scanned in the same way, including the output returned before the move; a withheld hand-off warns that withholding did not stop the task, and gives its scanned task ID to follow, or asks you to inspect `/tasks` when that ID cannot be read safely.

## Reading the log

The plugin logs one JSON line per event to `~/.claude/preallow/<session-id>.jsonl`, keyed by `tool_use_id`, with its time in `at` and the Claude Code version in `engine`; a line that names the tool also names the subagent that made the call, if one did, in `agentId`. Past about 1 MB the log goes on in `<session-id>.1.jsonl`, `<session-id>.2.jsonl`, and so on. Tool inputs are logged as given, unscanned, so a credential in a command or a file edit lands in the log. The log stays on this machine until you delete the folder.

To find calls the judge should not have allowed, read the `judged` lines whose deciding verdict is `allow`: `escalation.verdict` where the line has an `escalation`, `verdict` otherwise.

The events; all but `rejected`, `denied`, and `withheld` also give why the core asked, in `coreReason`:

- `judged`: a call the judge was asked about, or whose input was too long to ask it about, with the tool, its input (up to 2,000 characters), and the first judge's fields listed below. When a second judge ran, `escalation` holds the same fields for it, and its verdict decided the call.
- `owned`: an `ask` its decider owns, left to it without asking the judge (see [What it leaves to native approval](#what-it-leaves-to-native-approval)), with the field that named the decider in `ownedBy` and its value.
- `reserved`: a call of a tool whose verdict the engine keeps, left to it without asking the judge.
- `background`: a call run in the background, left to the classifier without asking the judge.
- `network`: a sandbox command requesting per-command domain grants, left to the classifier without asking the judge.
- `repeated`: a call auto mode denied, made again unchanged before you wrote again, left to the classifier without asking the judge.
- `rejected`: the engine rejected the plugin's allow of a call because only the classifier may allow that tool, with the start of its message in `reason`. The call failed, and the same call run again goes to the classifier; that tool belongs with the reserved ones, so report it.
- `denied`: auto mode denied a call the judge left to review, with the start of its reason in `reason`; auto mode can deny without a classifier verdict. The matching `judged` line says why the judge did not allow it.
- `withheld`: the plugin withheld the output of a call it allowed, and why in `reason` (never the output).

A judge's fields in a `judged` line:

- `verdict`: `allow`, or `review` when it did not allow the call, whether it answered so or not; and `reason`, the judge's, or why it gave none.
- `isAnswered`: whether the judge's model answered; absent when the input was too long to ask it, and false when its time ran out before the call after a check.
- `failure`, when it did not answer: `empty-reply`, `api-error` with Claude Code's kind of error and the HTTP status, `aborted` when the time limit ran out or the turn was interrupted, or the model client's refusal of the request.
- `retried`: the failures it made a model call again after.
- `checks`: what it asked to check, listed even when the checks could not run; and `facts`, what they found.
- `ms`, how long it took, and the `model` and `effort` settings it ran on.
- `usage`: what each model call cost, one entry per call with the four token counts the API reports; `input_tokens` counts only the input neither read from nor written to the cache.

## Known gaps

- A long conversation can lose a prohibition through the storage limit described in [What the judge reads](#what-the-judge-reads): past 64,000 characters the plugin keeps your first message and the newest that fit, and cuts a message over 16,000 characters to its head and tail. Repeat an important prohibition in a short message when it matters.
- On Bedrock, Vertex, Foundry, or behind a gateway, Claude Code finds cached text again only while the prompt opens the same way, and the judge's prompt opens with your kept messages, so after each message you write the judge's next call writes its instructions to the cache again along with your messages.
- A conversation forked into a new session, or one you last wrote in before the 50 most recent, starts with none of your earlier messages, so the judge may allow a call your earlier words ruled out.
- `/rewind` does not take your messages back from the judge: the plugin learns of no rewind, so a request you rewound still counts as yours. To withdraw one, say so in a new message.
- A call that only reads, such as printing a log, listing processes, showing proxy variables, or capturing a terminal pane, does not show that its output will hold a secret, so the judge allows it as it would any read; keeping the secret out of the conversation is left to the [output scan](#output-it-withholds), with the limits below.
- The credential scan knows a fixed list of formats (`hooks/withhold.ts` and gitleaks' provider rules); a credential in any other format, such as a password of letters only, or a value under a name the list does not know, slips through, and so do a token holding the word `false`, which gitleaks' allowlist reads as a boolean, and a value in a Kubernetes Secret that follows an empty one. JSON escaping can also hide a quoted password's shape. A private key slips through when more than about 200 characters of headers come before its body, or when a body wrapped narrower than 40 characters has indented or blank lines.
- Some text that is not a credential is taken for one, such as a private key's armor around 40 or more letters and digits that are not its body, a placeholder spread over lines for example, or, under gitleaks' rules, almost any 40-character hex string, a git commit hash included, in an output that also holds the word `sourcegraph`; the output is withheld, and the same call run again goes to the classifier.
- For a call moved to the background while it runs, the plugin scans only the hand-off. Output delivered later, including task notifications, is outside that scan; a later read is scanned only if the plugin allows that call.
- A `Monitor` call starts a watch whose events reach the model later, one line at a time; the judge may allow it, and the plugin does not scan those events.
- A call the plugin allowed runs again under the classifier after a withheld output only when its input is the same; a rerun with any input change is judged again.

## License

MIT
