# Changelog

## 0.0.2 - 2026-10-15

preallow is now one model judge for every tool. It replaces the read-only command list, the push and merge grants, `/grants`, and the `mode` setting; disabling the plugin turns it off.

- The judge allows a call that is a reversible step of the task you gave, or an irreversible effect you explicitly asked for, and leaves the rest to the classifier. Pushes, new branches, and pull requests on your own repositories count as steps toward a goal you set, and so does loosening permission settings for the task.
- It sends back any call that would leak personal or company information or tokens, or that does what you told the agent not to do, whatever else allows it. Making something readable by others counts as publishing even when its visibility can be switched back.
- When whether a call can be undone turns on files or git refs, the judge first checks them with read-only queries and decides again.
- Your words come from what you type and from your answers to the agent's questions, where a chosen option covers only the action and target it states and your notes and typed text count in full. They are kept per conversation, so a resumed conversation keeps them and `/clear` starts without them.
- Calls of tools whose verdict the engine keeps (a subagent's report to its parent, a question to you, a plan for your approval) are left to the engine without a judge call, so a subagent's report reaches its parent in auto mode.
- The `model` and `effort` settings choose what the judge runs on and are passed to the model client as you write them; left empty, the judge runs on `opus` at medium effort.
- Output withholding for credential-shaped values covers every call the plugin allows, checks a result another plugin's hook gave and notes added beside the result, and also recognizes session cookies.
- The log records `denied` when the classifier denies a call the judge passed, `reserved` and `refused` for tools whose verdict the engine keeps, the core's reason on each `check` line, and why the judge got no reply.

## 0.0.1 - 2026-10-14

First release: the read-only lane with credential-shaped output withheld, grants for pushes and merges read from your own messages, `/grants`, and the `shadow`, `reads`, and `enforce` modes.
