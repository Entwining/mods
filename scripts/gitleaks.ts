// Writes `plugins/preallow/hooks/gitleaks.generated.ts`: the rules of a
// gitleaks release that preallow's withholding check applies after its own
// shapes, with each regex rewritten from Go's syntax to JavaScript's. It is a
// module, not JSON, because a hooks module may import only code.

const VERSION = 'v8.30.1';
const SOURCE = `https://raw.githubusercontent.com/gitleaks/gitleaks/${VERSION}`;
const OUT = new URL('../plugins/preallow/hooks/gitleaks.generated.ts', import.meta.url);

// The assignment that gitleaks' rules for a value under a keyword, such as
// `cohere_key = ...`, share. The alternatives that hold it are left out:
// written for Go's linear-time engine, they backtrack for seconds over a
// megabyte of crafted output, past the hook's budget; they include
// `generic-api-key`, which matches code such as `apiKey = process.env.KEY`;
// and preallow's own shapes cover a value under a credential's name.
const ASSIGNMENT = String.raw`(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)`;

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

// The alternatives at the top level of a regex `toJs` wrote, each of which
// carries its own flags.
function alternatives(js: string): string[] {
  const parts = [''];
  let depth = 0;
  for (let i = 0; i < js.length; i++) {
    let c = js[i]!;
    if (c === '\\') {
      c += js[++i];
    } else if (c === '[') {
      let j = i + 1;
      while (js[j] !== ']') j += js[j] === '\\' ? 2 : 1;
      c = js.slice(i, j + 1);
      i = j;
    } else if (c === '(') {
      depth++;
    } else if (c === ')') {
      depth--;
    }
    if (c === '|' && depth === 0) parts.push('');
    else parts[parts.length - 1] += c;
  }
  return parts;
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
  .flatMap((rule) => {
    // A rule without a regex matches file paths, not text.
    if (rule.regex === undefined) return [];
    const kept = alternatives(toJs(rule.regex)).filter((regex) => !regex.includes(ASSIGNMENT));
    if (kept.length === 0) return [];
    return [{ ...rule, regex: kept.join('|').replaceAll(TOKEN_END, String.raw`(?![\w-])`) }];
  })
  .map((rule) => {
    if (rule.secretGroup !== undefined)
      throw new Error(`hooks/gitleaks.ts reads no secret group, which ${rule.id} sets`);
    return rule;
  })
  .map((rule) => ({
    id: rule.id,
    regex: rule.regex,
    keywords: (rule.keywords ?? []).map((k) => k.toLowerCase()),
    entropy: rule.entropy ?? 0,
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
