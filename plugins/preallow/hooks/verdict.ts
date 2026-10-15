// Reading the judge's reply: what counts as an allow, and what a check may
// ask for.

import { MAX_REQUESTS, type FactRequest } from './facts.ts';
import { isRefName } from './git.ts';

export type Reply =
  | { verdict: 'allow' | 'pass'; reason: string }
  | {
      verdict: 'check';
      reason: string;
      check: FactRequest[];
    };

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value !== '';

function factRequest(item: unknown): FactRequest | undefined {
  const { path, repo, ref } = (item ?? {}) as {
    path?: unknown;
    repo?: unknown;
    ref?: unknown;
  };
  if (nonEmpty(path) && repo === undefined && ref === undefined) return { path };
  if (nonEmpty(repo) && isRefName(ref) && path === undefined) return { repo, ref };
  return undefined;
}

// The JSON value that ends the reply, a closing code fence aside: the
// shortest tail that parses. The model sometimes writes a sentence before its
// verdict; a reply with anything else after the verdict does not parse.
function lastValue(text: string): Record<string, unknown> | undefined {
  const body = text.replace(/\s*(?:```\s*)?$/, '');
  let start = body.length;
  while (start > 0) {
    start = body.lastIndexOf('{', start - 1);
    if (start < 0) return undefined;
    try {
      return JSON.parse(body.slice(start));
    } catch {}
  }
  return undefined;
}

const VERDICT_FIELD = /"verdict"\s*:\s*"([^"\\]*)"/g;

// Only a reply that ends with a JSON object answering `allow` allows; one
// answering `check` must list what to check. A reply that states different
// verdicts along the way has not settled on one.
export function parseVerdict(text: string): Reply {
  const reply = lastValue(text);
  if (reply === undefined) return { verdict: 'pass', reason: 'unparsed reply' };
  const stated = new Set(Array.from(text.matchAll(VERDICT_FIELD), (match) => match[1]));
  if (stated.size > 1)
    return { verdict: 'pass', reason: `conflicting verdicts: ${[...stated].join(', ')}` };
  const { verdict, reason, check } = reply;
  const why = typeof reason === 'string' ? reason : `verdict ${String(verdict)}`;
  if (verdict === 'check') {
    const requests = Array.isArray(check) ? check.map(factRequest) : [];
    if (
      requests.length === 0 ||
      requests.length > MAX_REQUESTS ||
      !requests.every((request): request is FactRequest => request !== undefined)
    )
      return { verdict: 'pass', reason: `unusable check: ${why}` };
    return { verdict: 'check', reason: why, check: requests };
  }
  return { verdict: verdict === 'allow' ? 'allow' : 'pass', reason: why };
}
