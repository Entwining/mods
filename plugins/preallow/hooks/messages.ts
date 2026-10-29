// The user's words: the only source of their authorization the judge reads.

import type { EngineInterface } from 'claude-code';

// The user's own messages and answers to the agent's questions as the plugin
// keeps them: the first, which often sets the task, then the newest that fit,
// each clipped to its head and tail; `leftOut` counts the messages between.
// `addTurn` keeps a conversation in this form, so it stays bounded, and the
// judge reads all of it for every call.
export type UserMessages = { turns: readonly string[]; leftOut: number };

export const NO_MESSAGES: UserMessages = { turns: [], leftOut: 0 };

// Marks the user's answer to the agent's question among their words;
// `JUDGE_SYSTEM` names it to say how a chosen option authorizes.
export const ANSWER_PREFIX = "Answer to the agent's question: ";

const TURN_CHARS = 16_000;
const TURNS_CHARS = 64_000;

// The kept messages as the judge reads them, oldest first, with a note where
// the store let messages go.
export function keptMessages({ turns, leftOut }: UserMessages): readonly string[] {
  if (leftOut === 0) return turns;
  const [first, ...rest] = turns;
  return [first!, `[${leftOut} messages left out]`, ...rest];
}

// The head and tail of a long text, where a message usually puts its request
// and its last word.
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

export function addTurn(conversation: UserMessages, text: string): UserMessages {
  const [first, ...rest] = [...conversation.turns, clipTurn(text)];
  let room = TURNS_CHARS - size(first!);

  // Each kept turn also costs the comma that separates it, so many short
  // messages stay within the bound too.
  const newest: string[] = [];
  for (const turn of rest.toReversed()) {
    if (size(turn) + 1 > room) break;
    newest.unshift(turn);
    room -= size(turn) + 1;
  }

  return {
    turns: [first!, ...newest],
    leftOut: conversation.leftOut + rest.length - newest.length,
  };
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
type KeptMessages = UserMessages & { at: number };

export async function userMessages($: EngineInterface): Promise<UserMessages> {
  return (
    ((await $.store.get(`${TURNS_KEY}${await $.session.id()}`)) as KeptMessages | undefined) ??
    NO_MESSAGES
  );
}

async function otherConversations($: EngineInterface, key: string): Promise<string[]> {
  return (await $.store.keys()).filter((other) => other.startsWith(TURNS_KEY) && other !== key);
}

// Least recently written first.
async function byAge($: EngineInterface, keys: readonly string[]): Promise<string[]> {
  const at = new Map<string, number>();
  for (const key of keys) at.set(key, ((await $.store.get(key)) as KeptMessages).at);
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
      const kept: KeptMessages = { ...addTurn(await userMessages($), text), at: Date.now() };

      await $.store.set(key, kept);

      const others = await otherConversations($, key);
      // Ordering them costs a store read each, on every message.
      if (others.length < KEPT_CONVERSATIONS) return;
      const newestFirst = (await byAge($, others)).toReversed();
      for (const old of newestFirst.slice(KEPT_CONVERSATIONS - 1)) await $.store.delete(old);
    });
  return storeTail;
}
