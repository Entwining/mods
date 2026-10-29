# Changelog

## 0.0.9 - unreleased

- A judge model call that comes back without a reply, or with an API error that may clear on its own, such as an overloaded server, is made once more two seconds later instead of sending the tool call to the classifier. The judge's 90 seconds now cover all its model calls for one tool call, retries and the call after a check included.
- A call auto mode denied, made again with the same input before you write again, goes to the classifier instead of the judge, which could allow it on the second try. The log records it as `repeated`.
- The judge reads all your kept messages, up to 64,000 characters, for every call, instead of up to 24,000 characters chosen for each call by wording and by the words they share with it, which could leave out a prohibition phrased without the words selection looked for. Your messages open the judge's prompt and are marked for the prompt cache with its instructions, so calls until you write again read both from the cache, also on Bedrock, Vertex, Foundry, or behind a gateway.
- When the judge checks a ref with commits no other ref holds, it is also told how many of them have an equivalent patch in the branch the ref follows or in a remote's default branch, as when a pull request was merged by rebase, so deleting a branch whose work is already merged need not go to the classifier.
- Text that names a private key's format without the key, such as the header of a PEM or PuTTY key file, an age key's prefix, or the fixed start of a short-lived Amazon Bedrock key, is no longer withheld; the key's body has to be there. Reading the plugin's own source was withheld for this.
- The gitleaks rules for Slack webhook and Sidekiq URLs match a dot in their hostnames only where the URL has one, not any character.
- Each `judged` line in the log says in `isAnswered` whether the judge's model answered and, when it did not, why in `failure`, instead of inside `reason`; `retried` lists the failures a call was made again after.

## 0.0.8 - 2026-10-22

- Follow Claude Code's current approval API: leave hosted approvals and asks made by another plugin to their owner. Requires Claude Code 2.1.308 or later.
- Shell and command-monitor calls that request per-command network access stay with Claude Code's classifier, whose approval registers the domain grants. A hook allow approves the command without granting those hosts.

## 0.0.7 - 2026-10-16

- Log lines use new names; files written before this version keep the old ones.
- A call the judge was asked about, or whose input was too long to ask it about, is logged as `judged` instead of `check`, a word that also names the judge asking to look up files.
- The verdict of a call that goes on to the classifier is `review` instead of `pass`, which read as an allow.
- An `ask` left to its decider is logged as `owned`, naming the field in `ownedBy`, instead of `held` and `heldBy`, which looked like `withheld`.
- The engine rejecting the plugin's allow is logged as `rejected` instead of `refused`, which reads as a model's refusal.
- The `denied`, `rejected`, and `withheld` lines give their reason in `reason`, as `judged` lines do, instead of `denial`, `refusal`, and `why`. A `withheld` reason calls the credential scan a scan, as in `scanning it failed`, where it said `checking it failed`.
- What the judge asked to check is logged in `checks` instead of `checked`, which read as done: the list is there also when the checks could not run.
- The README no longer says a `denied` line means the classifier denied the call: auto mode can deny without a classifier verdict.

## 0.0.6 - 2026-10-16

- The judge's instructions are marked for the prompt cache, so a call soon after another can read them from the cache instead of paying for them in full.
- Each `check` line in the log records the `model` and `effort` settings the judge ran on and, in `usage`, the token counts of each model call it made.

## 0.0.5 - 2026-10-16

- A call moved to the background keeps its hand-off when its initial output passes the credential check, so the agent can follow the running task. A withheld hand-off or failed check preserves a checked task ID when available and warns against starting another run before checking the existing task.
- Installation instructions cover the shell command, interactive scope selection, and manual or automatic plugin updates.

## 0.0.4 - 2026-10-15

- The credential check also knows the gitleaks rules that find a provider's token by the provider's name beside it, such as Okta and Cohere tokens.

## 0.0.3 - 2026-10-15

- An `ask` from the read block (`permissions.blockReadsOutsideWorkingDirectories`), which asks you rather than the classifier, and one put to a host that answers the session's asks are left to them, as Claude Code 2.1.300 marks them. Before, the judge could allow a read the read block meant to ask you about.
- The judge reads a call's whole input instead of its first and last 8,000 characters, since the call runs with all of it; a call whose input passes 100,000 characters goes to the classifier without asking the judge.
- After withholding an output, the plugin tells the agent that the call was made and that running it again repeats its effects.
- The credential check knows the token formats of gitleaks' provider rules, such as Shopify, DigitalOcean, and Vault tokens and `curl -u` logins, in place of most of its own list, and no longer withholds a token too uniform to be real, such as `ghp_` followed by x's.
- A message the plugin's store fails to save no longer deletes other conversations' words.
- The judge reads, for each call, your first and newest messages, then those that set a limit, then those that share the most words with the call, instead of the newest that fit, so a prohibition given early or in the middle of a long message still reaches it. Each conversation keeps up to 64,000 characters of your words instead of 24,000.
- The 50 kept conversations fit the plugin's store even when their text is mostly characters that JSON escapes, and a conversation always keeps its newest message.
- The log records `held` for each `ask` left to its decider, naming the field that marked it, and `withheld` also when checking an output failed; every line carries the Claude Code version in `engine`. A `denied` line now comes from Claude Code's `PermissionDenied` event instead of the wording of the denial.

## 0.0.2 - 2026-10-15

preallow is now one model judge for every tool. It replaces the read-only command list, the push and merge grants, `/grants`, and the `mode` setting; disabling the plugin turns it off.

- The judge allows a call that is a reversible step of the task you gave, or an irreversible effect you explicitly asked for, and leaves the rest to the classifier. Pushes, new branches, and pull requests on your own repositories count as steps toward a goal you set, and so does loosening permission settings for the task.
- It sends back any call that would leak personal or company information or tokens, or that does what you told the agent not to do, whatever else allows it. Making something readable by others counts as publishing even when its visibility can be switched back.
- When whether a call can be undone turns on files or git refs, the judge first checks them with read-only queries and decides again.
- Your words come from what you type and from your answers to the agent's questions, where a chosen option covers only the action and target it states, while your notes and typed text count like a message you typed. They are kept per conversation, so a resumed conversation keeps them and `/clear` starts without them.
- Calls of tools whose verdict the engine keeps (a subagent's report to its parent, a question to you, a plan for your approval) are left to the engine without a judge call, so a subagent's report reaches its parent in auto mode.
- The `model` and `effort` settings choose what the judge runs on and are passed to the model client as you write them; left empty, the judge runs on `opus` at medium effort.
- Output withholding for credential-shaped values covers every call the plugin allows, checks a result another plugin's hook gave and notes added beside the result, and also recognizes session cookies.
- The log records `denied` when the classifier denies a call the judge passed, `reserved` and `refused` for tools whose verdict the engine keeps, `background` for calls run in the background, the core's reason on each `check` line, and why the judge got no reply.

## 0.0.1 - 2026-10-14

First release: the read-only lane with credential-shaped output withheld, grants for pushes and merges read from your own messages, `/grants`, and the `shadow`, `reads`, and `enforce` modes.
