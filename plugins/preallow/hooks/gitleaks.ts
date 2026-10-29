// The gitleaks rules that `bun run gitleaks` writes, applied
// to text the way gitleaks applies them to a file: a rule runs only when the
// text holds one of its keywords, and a match counts unless its secret is too
// uniform for the rule or an allowlist covers it.

import * as ruleset from './gitleaks.generated.ts';

type Allowlist = typeof ruleset.allowlist;

const compile = (list: Allowlist) => ({ ...list, regexes: list.regexes.map((r) => new RegExp(r)) });

const allowlist = compile(ruleset.allowlist);
const rules = ruleset.rules.map((rule) => ({
  ...rule,
  regex: new RegExp(rule.regex, 'dg'),
  allowlists: [allowlist, ...rule.allowlists.map(compile)],
}));

// Shannon entropy in bits per character.
function entropy(text: string): number {
  const counts = new Map<string, number>();
  for (const c of text) counts.set(c, (counts.get(c) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) bits -= (n / text.length) * Math.log2(n / text.length);
  return bits;
}

// A credential-shaped value's place in a text, and its kind: the name of a
// shape in `withhold.ts`, or the id of a gitleaks rule.
export type Finding = { kind: string; start: number; end: number };

export function findLeaks(text: string): Finding[] {
  const lower = text.toLowerCase();
  const found: Finding[] = [];
  for (const rule of rules) {
    if (!rule.keywords.some((k) => lower.includes(k))) continue;
    for (const match of text.matchAll(rule.regex)) {
      // The secret is the rule's secret group, else the first group that
      // matched, as gitleaks takes it.
      const group = rule.secretGroup > 0 ? rule.secretGroup : match.findIndex((g, i) => i > 0 && g);
      const [start, end] = match.indices![group] ?? match.indices![0]!;
      const secret = text.slice(start, end);
      if (rule.entropy > 0 && entropy(secret) <= rule.entropy) continue;
      const allowed = rule.allowlists.some(
        (list) =>
          list.regexes.some((r) => r.test(list.regexTarget === 'match' ? match[0] : secret)) ||
          list.stopwords.some((word) => secret.toLowerCase().includes(word)),
      );
      if (!allowed) found.push({ kind: rule.id, start, end });
    }
  }
  return found;
}
