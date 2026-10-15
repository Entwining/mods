// The user's words: the only source of their authorization the judge reads.

import type { EngineInterface } from 'claude-code';

// The user's own messages and answers to the agent's questions as the plugin
// keeps them: the first, which often sets the task, then the newest that fit,
// each clipped to its head and tail; `leftOut` counts the messages between.
// `addTurn` keeps a conversation in this form, so it stays bounded, and
// `selectWords` chooses from it what the judge reads for each call.
export type UserWords = { turns: readonly string[]; leftOut: number };

export const NO_WORDS: UserWords = { turns: [], leftOut: 0 };

// Marks the user's answer to the agent's question among their words;
// `JUDGE_SYSTEM` names it to say how a chosen option authorizes.
export const ANSWER_PREFIX = "Answer to the agent's question: ";

const TURN_CHARS = 16_000;
const TURNS_CHARS = 64_000;

// The head and tail of a long text, which hold a message's request and its
// last word.
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.75);
  const tail = max - head;
  return `${text.slice(0, head)}\n[… ${text.length - max} characters left out …]\n${text.slice(-tail)}`;
}

// A turn's size as JSON text, which is what the store counts against its
// limit: a character JSON escapes counts as up to six, so a kept conversation
// stays bounded whatever it holds.
const size = (turn: string) => JSON.stringify(turn).length;

// A message clipped until its JSON text fits `TURN_CHARS`, so the first
// message always leaves room for the newest.
function clipTurn(text: string): string {
  let max = TURN_CHARS;
  let turn = clip(text, max);
  while (size(turn) > TURN_CHARS) {
    max = Math.floor((max * TURN_CHARS) / size(turn));
    turn = clip(text, max);
  }
  return turn;
}

export function addTurn(words: UserWords, text: string): UserWords {
  const [first, ...rest] = [...words.turns, clipTurn(text)];
  let room = TURNS_CHARS - size(first!);

  // Each kept turn also costs the comma that separates it, so many short
  // messages stay within the bound too.
  const newest: string[] = [];
  for (const turn of rest.toReversed()) {
    if (size(turn) + 1 > room) break;
    newest.unshift(turn);
    room -= size(turn) + 1;
  }

  return { turns: [first!, ...newest], leftOut: words.leftOut + rest.length - newest.length };
}

// Each conversation's words are kept in the store under its session id: a
// resumed conversation runs under the id it had, so its words outlive the
// process, and `/clear` goes on under a new id that holds none.
const TURNS_KEY = 'turns:';
// The conversations written in least recently go first. Each is bounded by
// `TURNS_CHARS`, so this many stay under the store's limit.
const KEPT_CONVERSATIONS = 50;

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

      await $.store.set(key, kept);

      const others = await otherConversations($, key);
      // Ordering them costs a store read each, on every message.
      if (others.length < KEPT_CONVERSATIONS) return;
      const newestFirst = (await byAge($, others)).toReversed();
      for (const old of newestFirst.slice(KEPT_CONVERSATIONS - 1)) await $.store.delete(old);
    });
  return storeTail;
}
