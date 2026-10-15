# Changelog

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
