// Writes `plugins/preallow/hooks/gitleaks.generated.ts`: the rules of a
// gitleaks release that preallow's withholding scan applies after its own
// shapes, with each regex rewritten from Go's syntax to JavaScript's. It is a
// module, not JSON, because a hooks module may import only code.

const VERSION = 'v8.30.1';
const SOURCE = `https://raw.githubusercontent.com/gitleaks/gitleaks/${VERSION}`;
const OUT = new URL('../plugins/preallow/hooks/gitleaks.generated.ts', import.meta.url);

// The name before a value under a keyword, such as `cohere_key` in
// `cohere_key = ...`. gitleaks matches it only to show it in a finding (its
// source calls it "just an ignore group"); in JavaScript's backtracking engine
// it takes seconds over a megabyte of crafted output, past the hook's budget,
// against milliseconds without it.
const IDENTIFIER = String.raw`[\w.-]{0,50}?`;

// Rules that flag ordinary code: `generic-api-key`, and
// `hashicorp-tf-password` outside the Terraform files gitleaks applies it to,
// match labels such as `PASSWORD = "password_missing"`. preallow's own shapes
// cover a value under a credential's name.
const LEFT_OUT = new Set(['generic-api-key', 'hashicorp-tf-password']);

// How gitleaks ends a provider token, consuming the character after it since
// Go's engine has no lookahead. That misses a token followed by a full stop,
// a comma, a bracket, a colon, or `@`, and takes the separator a following
// match may start with, so it becomes a lookahead for any character a token
// cannot continue with.
const TOKEN_END = String.raw`(?:[\x60'"\s;]|\\[nr]|$)`;

const POSIX: Record<string, string> = { alnum: 'A-Za-z0-9', alpha: 'A-Za-z', digit: '0-9' };

// Go applies an inline flag such as `(?i)` to the rest of its group, across
// alternatives; JavaScript only has the scoped form `(?i:...)`, so each one
// opens a scoped group that is closed and reopened at every `|` and closed
// with the enclosing group.
function toJs(go: string): string {
  const src = go.replaceAll('(?P<', '(?<');
  const flagGroups: string[][] = [[]];
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === '\\') {
      out += src[i + 1] === 'z' ? '$' : c + src[i + 1];
      i++;
    } else if (c === '[') {
      let j = i + 1;
      if (src[j] === '^') j++;
      if (src[j] === ']') j++;
      while (src[j] !== ']') {
        if (src.startsWith('[:', j)) j = src.indexOf(':]', j) + 1;
        else if (src[j] === '\\') j++;
        j++;
      }
      out += src.slice(i, j + 1).replaceAll(/\[:(\w+):\]/g, (_, name: string) => {
        if (POSIX[name] === undefined) throw new Error(`no class for [:${name}:] in ${go}`);
        return POSIX[name];
      });
      i = j;
    } else if (c === '(') {
      const flags = /^\(\?([a-z]+)\)/.exec(src.slice(i));
      if (flags === null) {
        flagGroups.push([]);
        out += c;
      } else {
        flagGroups.at(-1)!.push(flags[1]!);
        out += `(?${flags[1]}:`;
        i += flags[0].length - 1;
      }
    } else if (c === ')') {
      out += ')'.repeat(flagGroups.pop()!.length + 1);
    } else if (c === '|') {
      const open = flagGroups.at(-1)!;
      out += `${')'.repeat(open.length)}|${open.map((f) => `(?${f}:`).join('')}`;
    } else {
      out += c;
    }
  }
  out += ')'.repeat(flagGroups[0]!.length);
  new RegExp(out);
  return out;
}

type GoAllowlist = {
  condition?: string;
  regexTarget?: string;
  regexes?: string[];
  stopwords?: string[];
};

// An allowlisted literal is a key gitleaks knows to be public, but it reads as
// a leaked key in this public repository and to secret scanners; leaving it
// out only withholds an output that prints one.
const isLiteral = (regex: string) => !/[[\](){}.*+?^$|]/.test(regex.replaceAll(/\\./g, ''));

// preallow scans text, not files, so path conditions never apply.
function allowlist(list: GoAllowlist) {
  const regexTarget = list.regexTarget ?? 'secret';
  if (regexTarget !== 'secret' && regexTarget !== 'match')
    throw new Error(`hooks/gitleaks.ts reads no allowlist target ${regexTarget}`);
  if (list.condition !== undefined && list.condition !== 'OR')
    throw new Error(`hooks/gitleaks.ts reads no allowlist condition ${list.condition}`);
  return {
    regexTarget,
    regexes: (list.regexes ?? []).filter((r) => !isLiteral(r)).map(toJs),
    stopwords: list.stopwords ?? [],
  };
}

const fetchText = async (path: string) => {
  const response = await fetch(`${SOURCE}/${path}`);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.text();
};

const config = Bun.TOML.parse(await fetchText('config/gitleaks.toml')) as {
  allowlist: GoAllowlist;
  rules: Array<{
    id: string;
    regex?: string;
    keywords?: string[];
    entropy?: number;
    secretGroup?: number;
    allowlists?: GoAllowlist[];
  }>;
};

const rules = config.rules
  .flatMap((rule) =>
    // A rule without a regex matches file paths, not text.
    rule.regex === undefined || LEFT_OUT.has(rule.id) ? [] : [{ ...rule, regex: rule.regex }],
  )
  .map((rule) => ({
    id: rule.id,
    regex: toJs(rule.regex.replaceAll(IDENTIFIER, '')).replaceAll(TOKEN_END, String.raw`(?![\w-])`),
    keywords: (rule.keywords ?? []).map((k) => k.toLowerCase()),
    entropy: rule.entropy ?? 0,
    secretGroup: rule.secretGroup ?? 0,
    allowlists: (rule.allowlists ?? [])
      .map(allowlist)
      .filter((list) => list.regexes.length > 0 || list.stopwords.length > 0),
  }));

const source = `https://github.com/gitleaks/gitleaks/blob/${VERSION}/config/gitleaks.toml`;
const license = (await fetchText('LICENSE')).trim();
await Bun.write(
  OUT,
  `// Written by \`bun run gitleaks\` from ${source}; do not edit.

/*
${license}
*/

export const allowlist = ${JSON.stringify(allowlist(config.allowlist))};

export const rules = ${JSON.stringify(rules)};
`,
);
