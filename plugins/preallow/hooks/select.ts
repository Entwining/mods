// Which of the user's kept words the judge reads for one call. A long
// conversation does not fit the judge's prompt, and a cut by age alone loses a
// prohibition given early or in the middle of a long message. Leaving out a
// limit the user set lets through a call they ruled out, while leaving out a
// permission only sends the call to the classifier, so after the first and
// newest messages the judge reads those that set a limit, then those that
// share the most words with the call.

import type { UserWords } from './words.ts';

const VIEW_CHARS = 24_000;
const MESSAGE_CHARS = 4000;
const PIECE_CHARS = MESSAGE_CHARS / 8;

const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });

// The words of a text, lowercased. The segmenter splits Chinese into words as
// well as English, so `别` is a word in `先别动` but not in `区别`; it keeps a
// name such as `billing.ts` whole and reads the call's JSON escapes as
// letters, so those are broken first.
function words(text: string): string[] {
  const list: string[] = [];
  const broken = text.toLowerCase().replaceAll(/\\[nrt]|[._]/g, ' ');
  for (const { segment, isWordLike } of segmenter.segment(broken))
    if (isWordLike) list.push(segment);
  return list;
}

// Wording that rules something out, then wording that narrows what the agent
// may do, in English and Chinese, matched against a text's words joined by
// spaces.
const PROHIBITION =
  / (?:don['’]?t|do not|never|must not|mustn['’]?t|should not|shouldn['’]?t|cannot|can['’]?t|won['’]?t|no longer|不要|别|禁止|不许|不准|不能|不可|不 可以|不得|严禁|勿) /;
const RESTRICTION = / (?:no|not|only|stop|avoid|without|except|unless|只|只能|仅|除了) /;

function limit(text: string): number {
  const spaced = ` ${words(text).join(' ')} `;
  if (PROHIBITION.test(spaced)) return 2;
  return RESTRICTION.test(spaced) ? 1 : 0;
}

// How much a text shares with the call: each shared word counts more the
// fewer of the user's messages hold it, so a path or a name outweighs a
// word every message uses.
type Relevance = (text: string) => number;

const terms = (text: string) => new Set(words(text).filter((word) => word.length > 1));

function relevance(call: string, turns: readonly string[]): Relevance {
  const callTerms = terms(call);
  const holding = new Map<string, number>();
  for (const turn of turns)
    for (const term of terms(turn))
      if (callTerms.has(term)) holding.set(term, (holding.get(term) ?? 0) + 1);
  return (text) => {
    let score = 0;
    for (const term of terms(text))
      if (callTerms.has(term)) score += Math.log(1 + turns.length / (holding.get(term) ?? 1));
    return score;
  };
}

// The order in which texts are taken: those that rule something out, then
// those that narrow what the agent may do, then by how much they share with
// the call, then the later first.
function ranked(texts: readonly string[], relevant: Relevance): number[] {
  const rank = texts.map((text, i) => ({ i, limit: limit(text), score: relevant(text) }));
  return rank
    .toSorted((a, b) => b.limit - a.limit || b.score - a.score || b.i - a.i)
    .map(({ i }) => i);
}

const omitted = (chars: number) => `[… ${chars} characters left out …]`;

// A long message cut to its head and tail, which hold its request and its
// last word, and the pieces between that set a limit or name what the call
// touches. A sentence longer than a piece, such as a pasted log line, is
// split, so the part of it that sets a limit fits on its own.
function excerpt(text: string, relevant: Relevance): string {
  if (text.length <= MESSAGE_CHARS) return text;
  const head = text.slice(0, MESSAGE_CHARS / 2);
  const tail = text.slice(-MESSAGE_CHARS / 8);
  const middle = text
    .slice(head.length, -tail.length)
    .split(/(?<=\n|[.!?。！？;；])/)
    .flatMap((sentence) =>
      Array.from({ length: Math.ceil(sentence.length / PIECE_CHARS) }, (_, k) =>
        sentence.slice(k * PIECE_CHARS, (k + 1) * PIECE_CHARS),
      ),
    );
  // A taken piece, and the tail, may need a note before it of what was left
  // out.
  const note = omitted(text.length).length + 2;
  let room = MESSAGE_CHARS - head.length - tail.length - note;
  const taken = new Set<number>();
  for (const i of ranked(middle, relevant)) {
    if (limit(middle[i]!) === 0 && relevant(middle[i]!) === 0) break;
    if (middle[i]!.length + note > room) continue;
    taken.add(i);
    room -= middle[i]!.length + note;
  }

  const parts = [head];
  let gap = 0;
  middle.forEach((piece, i) => {
    if (taken.has(i)) {
      if (gap > 0) parts.push(`\n${omitted(gap)}\n`);
      parts.push(piece);
      gap = 0;
    } else {
      gap += piece.length;
    }
  });
  if (gap > 0) parts.push(`\n${omitted(gap)}\n`);
  parts.push(tail);
  return parts.join('');
}

const omittedMessages = (count: number) => `[${count} messages left out]`;

// The messages the judge reads for a call, oldest first, with a note where
// messages are left out, within `VIEW_CHARS` together.
export function selectWords({ turns, leftOut }: UserWords, call: string): string[] {
  if (turns.length === 0) return [];
  const relevant = relevance(call, turns);
  const views = turns.map((turn) => excerpt(turn, relevant));
  const last = turns.length - 1;
  // A message taken may need a note before it, none longer than this one.
  const note = omittedMessages(turns.length + leftOut).length;
  const cost = (i: number) => views[i]!.length + note;

  // The first and newest always; then the rest in rank while they fit.
  const chosen = new Set([0, last]);
  let room = VIEW_CHARS - cost(0) - (last > 0 ? cost(last) : 0);
  for (const i of ranked(turns, relevant)) {
    if (chosen.has(i) || cost(i) > room) continue;
    chosen.add(i);
    room -= cost(i);
  }

  const messages: string[] = [];
  // Messages the store already let go sit between the first and the rest.
  let gap = 0;
  views.forEach((view, i) => {
    if (i === 1) gap += leftOut;
    if (chosen.has(i)) {
      if (gap > 0) messages.push(omittedMessages(gap));
      messages.push(view);
      gap = 0;
    } else {
      gap++;
    }
  });
  return messages;
}
