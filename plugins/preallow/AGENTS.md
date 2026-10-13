# preallow

The README states what the plugin allows and what it leaves to the classifier; keep it in step with the code.

- The plugin only loosens. `tool.check` turns the core's `ask` into `allow` or returns the core's answer unchanged; it never touches an `allow`, a `deny`, a settings rule, or another hook's ask. Every hook falls back to `next(e)` when it throws or runs past its time, so a defect sends calls to the classifier rather than allowing them. The `tool.call` hook runs after the tool: when its check throws, its fallback withholds an enforced read's output, but a scan still running when its time ends may leave the output shown unchecked, so every pattern in `hooks/secrets.ts` stays linear in the output's length.
- When a case is uncertain (unread shell syntax, a target that cannot be pinned down, a directory the shell may not be in), pass it to the classifier instead of guessing.
- A grant needs the user's own words: its quote must appear verbatim in the message or in the answer the message approved, and must name the action. Do not widen what counts as the user's words.
- `$.state` reads within one dispatch see one moment. A hook that reads grants waits for `grantQueue` before its first read, and every change to grants goes through `enqueue` so it applies in message order.
- `EXTRACTION_SYSTEM` and `withdraws` decide what a user's words authorize. Check a change to either against real messages kept outside this repository, on messages not used while writing the change, and compare grant and withdrawal rates before and after.
