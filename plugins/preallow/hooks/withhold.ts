// The credential shapes the output scan looks for, and how a found value is
// redacted.

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

export const LINE_BREAK = String.raw`(?:\r\n?|\n|\\r(?:\\n)?|\\n)`;
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
