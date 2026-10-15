// The user's words: the only source of their authorization the judge reads.

import type { EngineInterface } from 'claude-code';

// The user's own messages and answers to the agent's questions as the judge
// reads them: the first, which often sets the task, then the newest that fit,
// each clipped to its head and tail; `leftOut` counts the messages between.
// `addTurn` keeps a conversation in this form, so it never holds more than
// the judge reads.
export type UserWords = { turns: readonly string[]; leftOut: number };

export const NO_WORDS: UserWords = { turns: [], leftOut: 0 };

// Marks the user's answer to the agent's question among their words;
// `JUDGE_SYSTEM` names it to say how a chosen option authorizes.
export const ANSWER_PREFIX = "Answer to the agent's question: ";

const TURN_CHARS = 4000;
const TURNS_CHARS = 24_000;

// The head and tail of a long text, which hold a message's request and its
// last word.
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.75);
  const tail = max - head;
  return `${text.slice(0, head)}\n[… ${text.length - max} characters left out …]\n${text.slice(-tail)}`;
}

export function addTurn(words: UserWords, text: string): UserWords {
  const [first, ...rest] = [...words.turns, clip(text, TURN_CHARS)];
  let room = TURNS_CHARS - first!.length;
  const newest: string[] = [];
  for (const turn of rest.toReversed()) {
    if (turn.length > room) break;
    newest.unshift(turn);
    room -= turn.length;
  }
  return { turns: [first!, ...newest], leftOut: words.leftOut + rest.length - newest.length };
}

// Each conversation's words are kept in the store under its session id: a
// resumed conversation runs under the id it had, so its words outlive the
// process, and `/clear` goes on under a new id that holds none.
const TURNS_KEY = 'turns:';
// The conversations written in least recently go first. Each is bounded by
// what the judge reads, but together they can still pass the store's limit,
// so a write the store refuses for its size makes room the same way.
const KEPT_CONVERSATIONS = 50;
const STORE_LIMIT = 4 * 1024 * 1024;

// `at` orders the conversations: the store keeps keys in the order they were
// first set, whatever was written since.
type KeptWords = UserWords & { at: number };

export async function userWords($: EngineInterface): Promise<UserWords> {
  return (
    ((await $.store.get(`${TURNS_KEY}${await $.session.id()}`)) as KeptWords | undefined) ??
    NO_WORDS
  );
}

async function otherConversations($: EngineInterface, key: string): Promise<string[]> {
  return (await $.store.keys()).filter((other) => other.startsWith(TURNS_KEY) && other !== key);
}

// Least recently written first.
async function byAge($: EngineInterface, keys: readonly string[]): Promise<string[]> {
  const at = new Map<string, number>();
  for (const key of keys) at.set(key, ((await $.store.get(key)) as KeptWords).at);
  return keys.toSorted((a, b) => at.get(a)! - at.get(b)!);
}

// The store with `value` under `key`, in UTF-8 bytes of JSON text, which are
// never fewer than the characters the store may count instead.
async function storeBytes($: EngineInterface, key: string, value: unknown): Promise<number> {
  const entries: Record<string, unknown> = {};
  for (const other of await $.store.keys()) entries[other] = await $.store.get(other);
  entries[key] = value;
  return new TextEncoder().encode(JSON.stringify(entries)).length;
}

let storeTail: Promise<void> = Promise.resolve();

// Writes one at a time, so a message is never lost to a concurrent write: a
// lost prohibition would let through a call the user ruled out. Each write
// replaces the conversation's words whole, so the judge reads them as they
// were before the message or after it, and a write the store refuses leaves
// them as they were.
export function remember($: EngineInterface, text: string): Promise<void> {
  storeTail = storeTail
    .catch(() => {})
    .then(async () => {
      const key = `${TURNS_KEY}${await $.session.id()}`;
      const kept: KeptWords = { ...addTurn(await userWords($), text), at: Date.now() };
      for (;;) {
        try {
          await $.store.set(key, kept);
          break;
        } catch (error) {
          // A refusal while the store is under half its limit has another
          // cause, which dropping conversations would not cure.
          const [oldest] = await byAge($, await otherConversations($, key));
          if (oldest === undefined || (await storeBytes($, key, kept)) < STORE_LIMIT / 2)
            throw error;
          await $.store.delete(oldest);
        }
      }
      const newestFirst = (await byAge($, await otherConversations($, key))).toReversed();
      for (const old of newestFirst.slice(KEPT_CONVERSATIONS - 1)) await $.store.delete(old);
    });
  return storeTail;
}
