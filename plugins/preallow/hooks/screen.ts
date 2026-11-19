// What the output of a call the plugin allowed must not put in front of the
// model. The judge decides before the call runs and cannot see what it will
// print, and the classifier, which weighs that, never saw the call.

import type { EngineInterface, ToolCallResult } from 'claude-code';

import type { Finding } from './gitleaks.ts';
import { findSecrets, LINE_BREAK, redact } from './withhold.ts';

// What the model reads beside a result the plugin redacted. The call was made,
// so a rerun repeats its effects, such as a message sent or a second server started.
const REDACTED =
  'The call already ran. preallow replaced each value it detected as a possible credential with "[redacted by preallow: <kind>]", where <kind> names the pattern that matched; a marker is not a usable value. Continue with the rest of the output. Refer to a credential by where it is kept, such as an environment variable or a file, not by its value, and run no call to reveal a redacted value; if the task needs the value itself, ask the user to look at it outside this conversation. Running the same call again with identical input repeats its effects and leaves it to the auto-mode classifier.';

// What the model reads in place of a withheld output.
export const WITHHELD = 'The call was made, and preallow withheld its output:';
const RERUN = 'Running it again repeats its effects, and leaves it to the auto-mode classifier.';

export function rerunWarning(output: unknown): string {
  const { backgroundTaskId } = (output ?? {}) as { backgroundTaskId?: unknown };
  if (backgroundTaskId === undefined) return RERUN;
  // The task id goes back to the model even when the rest of the output cannot.
  const recovery =
    typeof backgroundTaskId === 'string' && findSecrets(backgroundTaskId).length === 0
      ? `Check task ${JSON.stringify(backgroundTaskId)} before starting another run.`
      : 'Ask the user to inspect /tasks before starting another run.';
  return `The task may still be running in the background. Withholding its output did not stop it. ${recovery}`;
}

const mapStrings = (value: unknown, change: (text: string) => string): unknown =>
  typeof value === 'string'
    ? change(value)
    : Array.isArray(value)
      ? value.map((item) => mapStrings(item, change))
      : typeof value === 'object' && value !== null
        ? Object.fromEntries(
            Object.entries(value).map(([k, v]) => [change(k), mapStrings(v, change)]),
          )
        : value;

// Every place a found value appears in the text, as a copy the shapes do not
// find beside it is the same credential.
function copies(text: string, values: ReadonlyMap<string, string>): Finding[] {
  const found: Finding[] = [];
  for (const [value, kind] of values)
    for (let at = text.indexOf(value); at !== -1; at = text.indexOf(value, at + value.length))
      found.push({ kind, start: at, end: at + value.length });
  return found;
}

// How another text shows a value: a value across lines by the runs on its
// lines, since a key in a Read result has line numbers between them and one in
// JSON has escaped line breaks; any other value whole.
function parts(value: string): string[] {
  const lines = value.split(new RegExp(LINE_BREAK));
  const runs =
    lines.length > 1 ? lines.flatMap((line) => line.match(/[A-Za-z0-9+/]{16,}/g) ?? []) : [];
  return runs.length > 0 ? runs : [value];
}

export type Screened =
  | undefined
  // `error` is what kept the plugin from redacting, when something failed.
  | { withheld: string; error?: string }
  | { redacted: ToolCallResult; kinds: string[]; inSavedOutput: boolean };

// What the model may read of the output of a call the plugin allowed: nothing
// to change, the result with each credential-shaped value redacted, or why it
// must be withheld whole. The model reads the core's `text`, or a hook's own
// result, which carries none, and any context beside it.
export async function screen($: EngineInterface, answer: ToolCallResult): Promise<Screened> {
  const values = new Map<string, string>();
  const kinds = new Set<string>();
  const add = (value: string, kind: string) => {
    for (const part of parts(value)) values.set(part, kind);
  };

  // The full output a large result leaves in a file, which the model can read
  // later without the plugin; the result shows its start, so each value found
  // there counts for the result too.
  const { persistedOutputPath } = (answer.result ?? {}) as { persistedOutputPath?: unknown };
  let saved: { path: string; text: string; found: Finding[] } | undefined;
  if (typeof persistedOutputPath === 'string') {
    try {
      const text = await $.fs.read(persistedOutputPath);
      saved = { path: persistedOutputPath, text, found: findSecrets(text) };
    } catch (error) {
      return { withheld: 'its full output could not be read to scan it', error: String(error) };
    }
    for (const { kind, start, end } of saved.found) add(saved.text.slice(start, end), kind);
  }

  const text = answer.text ?? JSON.stringify(answer.result) ?? '';
  const shown = findSecrets(text);
  for (const { kind, start, end } of shown) add(text.slice(start, end), kind);

  // The record is scanned too, since line numbers or JSON escapes in the text
  // can hide a shape the record holds. Core's text is all the model reads, so
  // a value counts only where that text shows it, by its runs or, on lines
  // too narrow for runs, line by line, and not in a field such as the file an
  // Edit result keeps. Every value is found before any is redacted, so that
  // each copy of it, wherever it comes, is redacted or withholds the output.
  const held = new Map<string, Finding[]>();
  if (answer.isError !== true)
    mapStrings(answer.result, (leaf) => {
      const found = findSecrets(leaf).filter(({ start, end }) => {
        if (answer.text === undefined) return true;
        const value = leaf.slice(start, end);
        return (
          parts(value).some((part) => values.has(part) || text.includes(part)) ||
          value.split(new RegExp(LINE_BREAK)).every((line) => text.includes(line.trim()))
        );
      });
      held.set(leaf, found);
      for (const { kind, start, end } of found) add(leaf.slice(start, end), kind);
      return leaf;
    });

  // The file is redacted where it lies, once every value is known. Only a
  // file the engine wrote for this session is rewritten: a result is a tool's
  // or a hook's to fill, and could name any file the user keeps.
  let inSavedOutput = false;
  if (saved !== undefined) {
    const found = [...saved.found, ...copies(saved.text, values)];
    if (found.length > 0) {
      for (const { kind } of found) kinds.add(kind);
      const withheld = `its full output in a file holds what looks like a credential (${found[0]!.kind})`;
      const [session, folder] = saved.path.split('/').slice(-3, -1);
      if (session !== (await $.session.id()) || folder !== 'tool-results')
        return { withheld, error: "preallow: not in the session's tool-results directory" };
      try {
        await $.fs.write(saved.path, redact(saved.text, found));
      } catch (error) {
        return { withheld, error: String(error) };
      }
      inSavedOutput = true;
    }
  }

  // Core keeps whole the context a hook below attached.
  for (const entry of answer.context ?? []) {
    const [first] = [...findSecrets(entry), ...copies(entry, values)];
    if (first !== undefined)
      return {
        withheld: `a hook's note beside it holds what looks like a credential (${first.kind})`,
      };
  }

  // An error's text is all the model reads of it.
  if (answer.isError === true) {
    for (const { kind } of shown) kinds.add(kind);
    if (kinds.size === 0) return undefined;
    return {
      redacted: { deny: `${redact(text, [...shown, ...copies(text, values)])}\n\n${REDACTED}` },
      kinds: [...kinds],
      inSavedOutput,
    };
  }

  const leaves: string[] = [];
  const result = mapStrings(answer.result, (leaf) => {
    const found = [...held.get(leaf)!, ...copies(leaf, values)];
    for (const { kind } of found) kinds.add(kind);
    leaves.push(leaf);
    return redact(leaf, found);
  });
  // The core renders its text from the record, so a value only the text holds
  // cannot be redacted from it.
  for (const [value, kind] of values)
    if (text.includes(value) && !leaves.some((leaf) => leaf.includes(value)))
      return {
        withheld: `its text shows what looks like a credential (${kind}) that its result does not hold`,
      };
  if (kinds.size === 0) return undefined;

  return {
    redacted: { result, context: [...(answer.context ?? []), REDACTED] },
    kinds: [...kinds],
    inSavedOutput,
  };
}
