// What the output of a call the plugin allowed must not put in front of the
// model. The judge decides before the call runs and cannot see what it will
// print, and the classifier, which weighs that, never saw the call.

// Every quantifier that could start at each character of a long run is
// bounded or stops at the end of its line, so a scan stays linear on a large
// output within the hook's budget.

// A generated value: letters and digits both, without shell or template
// syntax, so a placeholder such as `Bearer ${token}` or `replace-with-your-key`
// does not match. Where code assigns a bare value, a dot makes it a property
// path such as `req.headers.token`; a quoted value or a token sent in a
// header may hold dots, and a sentence may end right after a value.
function value(min: number, hasDots = false): string {
  const char = hasDots ? '[A-Za-z0-9._~+/=-]' : '[A-Za-z0-9_~+/=-]';
  return String.raw`(?=${char}{0,256}\d)(?=${char}{0,256}[A-Za-z])${char}{${min},}(?!\w|\.\w)`;
}

// A variable or key name for a secret, such as `DB_PASSWORD`, `apiKey`, or
// `aws_secret_access_key`.
const SECRET_NAME = String.raw`\b[\w-]{0,40}(?:token|secret|passw(?:or)?d|credential|api[_-]?key|private[_-]?key)[\w-]{0,40}`;

const SECRET_SHAPES: ReadonlyArray<[string, RegExp]> = [
  [
    'private key',
    /-----BEGIN [A-Z ]{0,20}PRIVATE KEY(?: BLOCK)?-----|PuTTY-User-Key-File-\d|AGE-SECRET-KEY-1/,
  ],
  [
    'API key',
    /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}|glpat-[A-Za-z0-9_-]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|[sr]k_(?:live|test)_[A-Za-z0-9]{20,}|(?:AKIA|ASIA)[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|hf_[A-Za-z]{34,}|npm_[A-Za-z0-9]{36}|glrt-[A-Za-z0-9_-]{20,}|dapi[a-f0-9]{32}|SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43})/,
  ],
  ['JSON web token', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  [
    'URL credential',
    new RegExp(String.raw`\b[a-z][a-z0-9+.-]{0,30}://[^\s:/@]{1,256}:${value(8)}@`),
  ],
  ['webhook URL', /hooks\.slack\.com\/(?:services|workflows)\/[A-Za-z0-9/]{20,}/],
  [
    'auth header',
    new RegExp(
      String.raw`\b(?:authorization|x-api-key|x-auth-token)["']?\s*[:=]\s*["']?(?:(?:bearer|basic|token)\s+)?${value(16, true)}`,
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
      String.raw`(?:sess|(?<![a-z])sid)[\w.-]{0,40}=(?![\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}(?![%\w./+=~-]))(?=[%\w./+=~-]{0,256}\d)(?=[%\w./+=~-]{0,256}[a-z])[%\w./+=~-]{16,}`,
      'i',
    ),
  ],
  [
    'secret assignment',
    new RegExp(String.raw`${SECRET_NAME}["']?\s*[:=]\s*["']?${value(16)}`, 'i'),
  ],
  [
    'secret assignment',
    new RegExp(String.raw`${SECRET_NAME}["']?\s*[:=]\s*(["'])${value(16, true)}\1`, 'i'),
  ],
  // An environment variable named for a key, such as `SERVICE_KEY=...`.
  ['secret assignment', new RegExp(String.raw`\b[A-Z0-9_]{0,40}_KEY\s*[:=]\s*["']?${value(16)}`)],
  // Azure storage connection strings.
  ['secret assignment', new RegExp(String.raw`\bAccountKey=${value(16)}`)],
  ['netrc password', /^[ \t]*(?:machine\s+\S+|default)\s[\s\S]{0,200}?\bpassword\s+\S+/m],
  ['registry credential', /"auth"\s*:\s*"[A-Za-z0-9+/]{16,}={0,2}"/],
];

// The kind of credential-shaped value the output holds, in SECRET_SHAPES order.
export function findSecret(text: string): string | undefined {
  return SECRET_SHAPES.find(([, shape]) => shape.test(text))?.[0];
}
