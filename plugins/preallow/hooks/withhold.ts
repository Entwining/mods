// What the output of a call the plugin allowed must not put in front of the
// model. The judge decides before the call runs and cannot see what it will
// print, and the classifier, which weighs that, never saw the call.

import type { EngineInterface, ToolCallResult } from 'claude-code';

import { type Finding, findLeaks } from './gitleaks.ts';

// Every quantifier that could start at each character of a long run is
// bounded or stops at the end of its line, so a scan stays linear on a large
// output within the hook's budget.

// A generated value: letters and digits both, without shell or template
// syntax, so a placeholder such as `Bearer ${token}` or `replace-with-your-key`
// does not match. Where code assigns a bare value, a dot makes it a property
// path such as `req.headers.token`; a quoted value or a token sent in a
// header may hold dots, and a sentence may end right after a value. The
// `secret` group is what gets redacted, so the name before it stays readable.
function value(min: number, hasDots = false): string {
  const char = hasDots ? '[A-Za-z0-9._~+/=-]' : '[A-Za-z0-9_~+/=-]';
  return String.raw`(?<secret>(?=${char}{0,256}\d)(?=${char}{0,256}[A-Za-z])${char}{${min},})(?!\w|\.\w)`;
}

// A variable or key name for a secret, such as `DB_PASSWORD`, `apiKey`, or
// `aws_secret_access_key`.
const SECRET_NAME = String.raw`\b[\w-]{0,40}(?:token|secret|passw(?:or)?d|credential|api[_-]?key|private[_-]?key)[\w-]{0,40}`;

// The `=` or `:` before a value, which starts on the same line, or on a later
// one only after a quote, as when a formatter wraps a long string: otherwise
// an empty `API_KEY=` would take the name on the next line for its value.
const ASSIGNMENT = String.raw`[:=](?:\s*["']|[ \t]*)`;

const LINE_BREAK = String.raw`(?:\r\n?|\n|\\r(?:\\n)?|\\n)`;
// The rest of a key past the 40 body characters its shape needs, where no end
// marker closes it: each line after that is one base64 run, so a line of
// text such as `Private-MAC: ...` stays.
const KEY_LINES = String.raw`[A-Za-z0-9+/=]*(?:[ \t]*${LINE_BREAK}{1,2}[ \t]*[A-Za-z0-9+/=]+(?=[ \t]*(?:[\r\n\\"']|$)))*`;

// A key needs its body, not only the words that name its format, so text
// about a format, this file's included, is not taken for a key. A key's
// newlines may be escaped, as in JSON.
const SECRET_SHAPES: ReadonlyArray<[string, RegExp]> = [
  // PEM and OpenPGP armor, then within 200 characters, past any headers, 40
  // characters of its base64 body, counted across lines since parsers accept
  // any width, any line ending, and blanks ending a line. The rest of the key
  // runs to its end marker, whatever starts its lines, such as line numbers,
  // looked for within the length of an 8192-bit key with numbered lines.
  [
    'private key',
    new RegExp(
      String.raw`-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----[\s\S]{0,200}?(?:\s|\\[rn])(?:[A-Za-z0-9+/](?:[ \t]{0,64}(?:[\r\n]|\\[rn]){1,2})?){40}(?:[\s\S]{0,10000}?-----END[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----|${KEY_LINES})`,
    ),
  ],
  // A PuTTY key file's private part.
  [
    'private key',
    new RegExp(String.raw`\bPrivate-Lines: \d{1,3}(?:\s|\\[rn]){1,4}[A-Za-z0-9+/]{40}${KEY_LINES}`),
  ],
  // An age identity: its Bech32 body.
  ['private key', /AGE-SECRET-KEY-1[QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L]{58}/],
  // Providers that share the `sk-` prefix in formats gitleaks does not know.
  ['API key', /\bsk-[A-Za-z0-9_-]{20,}/],
  ['JSON web token', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  [
    'URL credential',
    new RegExp(String.raw`\b[a-z][a-z0-9+.-]{0,30}://[^\s:/@]{1,256}:${value(8)}@`),
  ],
  ['webhook URL', /hooks\.slack\.com\/(?:services|workflows)\/[A-Za-z0-9/]{20,}/],
  [
    'auth header',
    new RegExp(
      String.raw`\b(?:authorization|x-api-key|x-auth-token)["']?\s*${ASSIGNMENT}(?:(?:bearer|basic|token)\s+)?${value(16, true)}`,
      'i',
    ),
  ],
  ['bearer token', new RegExp(String.raw`\bbearer\s+${value(20, true)}`, 'i')],
  // A session cookie, such as `sessionid=...` or `connect.sid=...`, whose
  // value may be percent-encoded. A bare UUID is left out: tools print
  // session ids that grant nothing.
  [
    'session cookie',
    new RegExp(
      String.raw`(?:sess|(?<![a-z])sid)[\w.-]{0,40}=(?<secret>(?![\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}(?![%\w./+=~-]))(?=[%\w./+=~-]{0,256}\d)(?=[%\w./+=~-]{0,256}[a-z])[%\w./+=~-]{16,})`,
      'i',
    ),
  ],
  [
    'secret assignment',
    new RegExp(String.raw`${SECRET_NAME}["']?\s*${ASSIGNMENT}${value(16)}`, 'i'),
  ],
  [
    'secret assignment',
    new RegExp(String.raw`${SECRET_NAME}["']?\s*[:=]\s*(["'])${value(16, true)}\1`, 'i'),
  ],
  // An environment variable named for a key, such as `SERVICE_KEY=...`.
  ['secret assignment', new RegExp(String.raw`\b[A-Z0-9_]{0,40}_KEY\s*${ASSIGNMENT}${value(16)}`)],
  // Azure storage connection strings.
  ['secret assignment', new RegExp(String.raw`\bAccountKey=${value(16)}`)],
  [
    'netrc password',
    /^[ \t]*(?:machine\s+\S+|default)\s[\s\S]{0,200}?\bpassword\s+(?<secret>\S+)/m,
  ],
  ['registry credential', /"auth"\s*:\s*"(?<secret>[A-Za-z0-9+/]{16,}={0,2})"/],
];

const SHAPES = SECRET_SHAPES.map(
  ([kind, shape]) => [kind, new RegExp(shape.source, `${shape.flags}dg`)] as const,
);

// Every credential-shaped value in the text: the shapes above, in order, then
// gitleaks' rules for providers' token formats.
export function findSecrets(text: string): Finding[] {
  const found: Finding[] = [];
  for (const [kind, shape] of SHAPES) {
    for (const match of text.matchAll(shape)) {
      const [start, end] = match.indices!.groups?.secret ?? match.indices![0]!;
      found.push({ kind, start, end });
    }
  }
  return [...found, ...findLeaks(text)];
}

// Each value gives way to a marker naming its kind, keeping the value's line
// breaks so the lines after it keep their numbers, as a Read result counts them.
export function redact(text: string, found: readonly Finding[]): string {
  let out = '';
  let at = 0;
  for (const { kind, start, end } of [...found].sort((a, b) => a.start - b.start)) {
    if (start >= at) {
      out += `${text.slice(at, start)}[redacted by preallow: ${kind}]`;
      at = start;
    }
    if (end > at) {
      out += text.slice(at, end).replaceAll(/[^\n]/g, '');
      at = end;
    }
  }
  return out + text.slice(at);
}

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

const holds = (kind: string) => `it holds what looks like a credential (${kind})`;

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

// What the model may read of the output of a call the plugin allowed: nothing
// to change, the result with each credential-shaped value redacted, or why it
// must be withheld whole. The model reads the core's `text`, or a hook's own
// result, which carries none, and any context beside it.
export async function screen(
  $: EngineInterface,
  answer: ToolCallResult,
): Promise<undefined | { withheld: string } | { redacted: ToolCallResult; kinds: string[] }> {
  // The full output a large result leaves in a file, which the model can read
  // later without the plugin; the plugin cannot redact the engine's file.
  const { persistedOutputPath } = (answer.result ?? {}) as { persistedOutputPath?: unknown };
  if (typeof persistedOutputPath === 'string') {
    let saved: string;
    try {
      saved = await $.fs.read(persistedOutputPath);
    } catch {
      return { withheld: 'its full output could not be read to scan it' };
    }
    const [first] = findSecrets(saved);
    if (first !== undefined) return { withheld: holds(first.kind) };
  }

  const text = answer.text ?? JSON.stringify(answer.result) ?? '';
  const shown = findSecrets(text);

  const values = new Map<string, string>();
  const add = (value: string, kind: string) => {
    for (const part of parts(value)) values.set(part, kind);
  };
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

  // Core keeps whole the context a hook below attached.
  for (const entry of answer.context ?? []) {
    const [first] = [...findSecrets(entry), ...copies(entry, values)];
    if (first !== undefined) return { withheld: holds(first.kind) };
  }

  // An error's text is all the model reads of it.
  if (answer.isError === true) {
    if (shown.length === 0) return undefined;
    return {
      redacted: { deny: `${redact(text, [...shown, ...copies(text, values)])}\n\n${REDACTED}` },
      kinds: [...new Set(shown.map(({ kind }) => kind))],
    };
  }

  const leaves: string[] = [];
  const kinds = new Set<string>();
  const result = mapStrings(answer.result, (leaf) => {
    const found = [...held.get(leaf)!, ...copies(leaf, values)];
    for (const { kind } of found) kinds.add(kind);
    leaves.push(leaf);
    return redact(leaf, found);
  });
  // The core renders its text from the record, so a value only the text holds
  // cannot be redacted from it.
  for (const [value, kind] of values)
    if (!leaves.some((leaf) => leaf.includes(value))) return { withheld: holds(kind) };
  if (kinds.size === 0) return undefined;

  return {
    redacted: { result, context: [...(answer.context ?? []), REDACTED] },
    kinds: [...kinds],
  };
}
