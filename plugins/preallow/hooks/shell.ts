// A deliberately small shell reader. It accepts the plain command lines agents
// write (words, quotes, `&&`, `||`, `;`, `|`, simple redirections, command
// substitutions, which it hands back for judging) and refuses everything else
// whose effect cannot be read off the text: heredocs, subshells, groups,
// `case`, functions, background jobs. Loops and conditionals are flattened
// into the commands they run, since every one of them may run. A refusal sends the call to
// the classifier, so missing syntax costs an allow, never a wrong verdict.

export type Parameter = { name: string; isQuoted: boolean; hasOperator: boolean };

export type Word = {
  text: string;
  // The word holds an expansion, so its runtime value is unknown.
  isDynamic: boolean;
  // Command substitutions inside the word, as source text; each runs before
  // the segment does, so the classifier judges them too.
  substitutions: string[];
  // Parameter expansions inside the word, in order.
  parameters: Parameter[];
  // What makes the word's first character: written text, a written `-`, the
  // first parameter expansion, or a substitution, glob, or brace expansion.
  head: 'literal' | 'dash' | 'parameter' | 'expansion';
  // No value the word can take at run time is an option or more than one
  // word: it starts with written text other than `-`, or with a loop variable
  // whose values do not, and any other expansion in it is quoted or such a
  // variable. Static words are option-safe; their text is what runs.
  isOptionSafe: boolean;
};

export type Redirect = {
  op: string;
  target?: Word;
};

export type Segment = {
  assignments: Word[];
  argv: Word[];
  redirects: Redirect[];
  // The operator joining the segment to the one written before it.
  after?: '&&' | '||' | ';' | '|';
};

export type ParseResult =
  | { isParsed: true; segments: Segment[] }
  | { isParsed: false; reason: string };

type Token =
  | { kind: 'word'; word: Word }
  | { kind: 'op'; op: '&&' | '||' | ';' | '|' }
  | { kind: 'redirect'; op: string; isDuplication: boolean };

const NAME_START = /[A-Za-z_]/;
const SPECIAL_PARAMETER = /[0-9?#@*$!-]/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

class Refusal extends Error {}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let text = '';
  let isDynamic = false;
  let hasWord = false;
  let isQuoted = false;
  let isInDoubleQuotes = false;
  let substitutions: string[] = [];
  let parameters: Parameter[] = [];
  let head: Word['head'] | undefined;
  let i = 0;

  const literal = (written: string) => {
    if (written !== '') head ??= written.startsWith('-') ? 'dash' : 'literal';
    text += written;
  };

  const flush = () => {
    if (!hasWord) return;
    if (
      !isQuoted &&
      (text === '{' ||
        text === '}' ||
        text === '[[' ||
        text === ']]' ||
        text === 'case' ||
        text === 'function')
    ) {
      throw new Refusal(`unsupported shell keyword ${text}`);
    }
    tokens.push({
      kind: 'word',
      word: {
        text,
        isDynamic,
        substitutions,
        parameters,
        head: head ?? 'literal',
        isOptionSafe: !isDynamic,
      },
    });
    text = '';
    isDynamic = false;
    hasWord = false;
    isQuoted = false;
    substitutions = [];
    parameters = [];
    head = undefined;
  };

  // Reads `$(...)` or a backtick substitution starting at `i`, keeping quotes
  // and nesting balanced, and records its inner source.
  const readSubstitution = () => {
    if (source[i] === '`') {
      const end = source.indexOf('`', i + 1);
      if (end === -1 || source.slice(i + 1, end).includes('\\'))
        throw new Refusal('backtick substitution');
      substitutions.push(source.slice(i + 1, end));
      i = end + 1;
    } else {
      if (source[i + 2] === '(') throw new Refusal('arithmetic expansion');
      let depth = 1;
      let j = i + 2;
      while (depth > 0) {
        const d = source[j];
        if (d === undefined) throw new Refusal('unterminated substitution');
        if (d === "'") {
          const end = source.indexOf("'", j + 1);
          if (end === -1) throw new Refusal('unterminated quote');
          j = end + 1;
          continue;
        }
        if (d === '"') {
          j += 1;
          while (source[j] !== '"') {
            if (source[j] === undefined) throw new Refusal('unterminated quote');
            j += source[j] === '\\' ? 2 : 1;
          }
          j += 1;
          continue;
        }
        if (d === '\\') {
          j += 2;
          continue;
        }
        if (d === '(') depth += 1;
        if (d === ')') depth -= 1;
        j += 1;
      }
      substitutions.push(source.slice(i + 2, j - 1));
      i = j;
    }
    text += '$(...)';
    head ??= 'expansion';
    isDynamic = true;
    hasWord = true;
  };

  // Parameter expansions are read as a closed set: a name, alone or followed
  // by a default, trim, or replace operator. Subscripts, zsh flags such as
  // `${(e)X}`, bash transforms such as `${X@P}`, indirection, and substring
  // offsets can evaluate a variable's value as code or arithmetic.
  const readDollar = () => {
    const next = source[i + 1];
    if (next === '(') {
      readSubstitution();
      return;
    }
    if (next === "'" || next === '"' || next === '[') throw new Refusal('quoting expansion');
    hasWord = true;
    if (next === '{') {
      const name = /^#?(?:[A-Za-z_][A-Za-z0-9_]*|[0-9?#@*$-])/.exec(source.slice(i + 2))?.[0];
      if (name === undefined) throw new Refusal('parameter expansion');
      const rest = source.slice(i + 2 + name.length);
      if (
        !(rest.startsWith('}') || (!name.startsWith('#') && /^(?::?[-+=?]|[#%/^,])/.test(rest)))
      ) {
        throw new Refusal('parameter expansion');
      }
      text += `\${${name}`;
      parameters.push({
        name: name.replace(/^#/, ''),
        isQuoted: isInDoubleQuotes,
        hasOperator: !rest.startsWith('}') || name.startsWith('#'),
      });
      head ??= 'parameter';
      isDynamic = true;
      i += 2 + name.length;
      return;
    }
    if (next !== undefined && NAME_START.test(next)) {
      const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i + 1))![0];
      if (source[i + 1 + name.length] === '[') throw new Refusal('subscript');
      text += `$${name}`;
      parameters.push({ name, isQuoted: isInDoubleQuotes, hasOperator: false });
      head ??= 'parameter';
      isDynamic = true;
      i += 1 + name.length;
      return;
    }
    if (next !== undefined && SPECIAL_PARAMETER.test(next)) {
      parameters.push({ name: next, isQuoted: isInDoubleQuotes, hasOperator: false });
      head ??= 'parameter';
      isDynamic = true;
      text += '$';
    } else {
      literal('$');
    }
    i += 1;
  };

  while (i < source.length) {
    const c = source[i]!;
    const next = source[i + 1];

    if (c === '\\' && next === '\n') {
      i += 2;
      continue;
    }
    if (c === ' ' || c === '\t') {
      flush();
      i += 1;
      continue;
    }
    if (c === '\n') {
      flush();
      tokens.push({ kind: 'op', op: ';' });
      i += 1;
      continue;
    }
    if (c === '#' && !hasWord) {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === "'") {
      const end = source.indexOf("'", i + 1);
      if (end === -1) throw new Refusal('unterminated quote');
      literal(source.slice(i + 1, end));
      hasWord = true;
      isQuoted = true;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      hasWord = true;
      isQuoted = true;
      isInDoubleQuotes = true;
      i += 1;
      while (true) {
        const d = source[i];
        if (d === undefined) throw new Refusal('unterminated quote');
        if (d === '"') {
          i += 1;
          isInDoubleQuotes = false;
          break;
        }
        if (d === '`') {
          readSubstitution();
          continue;
        }
        if (d === '\\') {
          const escaped = source[i + 1];
          if (escaped === undefined) throw new Refusal('unterminated quote');
          if ('$`"\\'.includes(escaped)) literal(escaped);
          else if (escaped !== '\n') literal(`\\${escaped}`);
          i += 2;
          continue;
        }
        if (d === '$') {
          readDollar();
          continue;
        }
        literal(d);
        i += 1;
      }
      continue;
    }
    if (c === '\\') {
      if (next === undefined) throw new Refusal('trailing escape');
      literal(next);
      hasWord = true;
      isQuoted = true;
      i += 2;
      continue;
    }
    if (c === '$') {
      readDollar();
      continue;
    }
    if (c === '`') {
      readSubstitution();
      continue;
    }
    if (c === '(' || c === ')') throw new Refusal('subshell');
    // Globs and brace expansion turn one written word into others at run
    // time, such as `{-print,-delete}` into two options. A lone `[` is the
    // test command, not a pattern.
    const isPattern =
      c === '*' ||
      c === '?' ||
      (c === '[' && /^[^\s;&|<>]*\]/.test(source.slice(i + 1))) ||
      (c === '{' && /^[^\s;&|<>}]*(,|\.\.)[^\s;&|<>}]*\}/.test(source.slice(i + 1)));
    if (c === '&') {
      flush();
      if (next === '&') {
        tokens.push({ kind: 'op', op: '&&' });
        i += 2;
        continue;
      }
      if (next === '>') {
        const isAppend = source[i + 2] === '>';
        tokens.push({ kind: 'redirect', op: isAppend ? '&>>' : '&>', isDuplication: false });
        i += isAppend ? 3 : 2;
        continue;
      }
      throw new Refusal('background job');
    }
    if (c === '|') {
      flush();
      if (next === '|') {
        tokens.push({ kind: 'op', op: '||' });
        i += 2;
        continue;
      }
      if (next === '&') throw new Refusal('stderr pipe');
      tokens.push({ kind: 'op', op: '|' });
      i += 1;
      continue;
    }
    if (c === ';') {
      flush();
      if (next === ';') throw new Refusal('case terminator');
      tokens.push({ kind: 'op', op: ';' });
      i += 1;
      continue;
    }
    if (c === '<' || c === '>') {
      // A file descriptor number written right before the operator belongs to it.
      let fd = '';
      if (hasWord && !isQuoted && !isDynamic && /^[0-9]+$/.test(text)) {
        fd = text;
        text = '';
        hasWord = false;
        head = undefined;
      }
      flush();
      if (next === '(') throw new Refusal('process substitution');
      if (c === '<') {
        if (next === '<' || next === '&' || next === '>')
          throw new Refusal('heredoc or descriptor input');
        tokens.push({ kind: 'redirect', op: `${fd}<`, isDuplication: false });
        i += 1;
        continue;
      }
      if (next === '&') {
        let j = i + 2;
        let target = '';
        while (j < source.length && /[0-9-]/.test(source[j]!)) target += source[j++];
        if (target === '' || target === '-') throw new Refusal('descriptor redirection');
        tokens.push({ kind: 'redirect', op: `${fd}>&${target}`, isDuplication: true });
        i = j;
        continue;
      }
      const isAppend = next === '>';
      const isClobber = next === '|';
      tokens.push({ kind: 'redirect', op: `${fd}${isAppend ? '>>' : '>'}`, isDuplication: false });
      i += isAppend || isClobber ? 2 : 1;
      continue;
    }
    if (isPattern) {
      head ??= 'expansion';
      isDynamic = true;
      text += c;
    } else {
      literal(c);
    }
    hasWord = true;
    i += 1;
  }
  flush();
  return tokens;
}

const OPENERS = new Set(['if', 'while', 'until']);
const PREFIXES = new Set(['then', 'do', 'else', 'elif', '!']);
const CLOSERS = new Set(['fi', 'done']);

// Removes compound-command keywords so each command they hold is a segment of
// its own. A `for` header becomes an assignment of its word list, keeping any
// substitution in it for judging; a redirection on `done` or `fi` becomes one
// on a no-op, so it is still judged.
function flatten(segments: Segment[], isUnconditional: boolean[]): ParseResult {
  const flat: Segment[] = [];
  // The loop variables bound around each flat segment, innermost last.
  const loopsAround: Loop[][] = [];
  // Whether each flat segment always runs: unconditional and outside any compound command.
  const alwaysRuns: boolean[] = [];
  const open: Array<Loop | undefined> = [];
  const word = (text: string): Word => ({
    text,
    isDynamic: false,
    substitutions: [],
    parameters: [],
    head: 'literal',
    isOptionSafe: true,
  });
  for (const [index, segment] of segments.entries()) {
    let argv = segment.argv;
    while (
      argv.length > 0 &&
      !argv[0]!.isDynamic &&
      (OPENERS.has(argv[0]!.text) || PREFIXES.has(argv[0]!.text) || argv[0]!.text === 'for')
    ) {
      const keyword = argv[0]!.text;
      if (segment.assignments.length > 0)
        return { isParsed: false, reason: `assignment before ${keyword}` };
      if (keyword === 'for') {
        const name = argv[1];
        if (
          name === undefined ||
          !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name.text) ||
          argv[2]?.text !== 'in'
        ) {
          return { isParsed: false, reason: 'for loop form' };
        }
        const items = argv.slice(3);
        flat.push({
          assignments: [
            {
              ...word(`${name.text}=`),
              isDynamic: true,
              isOptionSafe: false,
              substitutions: items.flatMap((item) => item.substitutions),
            },
          ],
          argv: [],
          redirects: [],
        });
        loopsAround.push(open.filter((loop) => loop !== undefined));
        alwaysRuns.push(false);
        open.push({ name: name.text, items, header: flat.length - 1 });
        argv = [];
        break;
      }
      if (OPENERS.has(keyword)) open.push(undefined);
      argv = argv.slice(1);
    }
    if (argv.length === 1 && !argv[0]!.isDynamic && CLOSERS.has(argv[0]!.text)) {
      if (open.length === 0 || segment.assignments.length > 0)
        return { isParsed: false, reason: `unbalanced ${argv[0]!.text}` };
      open.pop();
      if (segment.redirects.length > 0) {
        flat.push({ assignments: [], argv: [word('true')], redirects: segment.redirects });
        loopsAround.push(open.filter((loop) => loop !== undefined));
        alwaysRuns.push(false);
      }
      continue;
    }
    if (argv.length > 1 && !argv[0]!.isDynamic && CLOSERS.has(argv[0]!.text))
      return { isParsed: false, reason: 'closer with arguments' };
    if (argv.length === 0 && segment.assignments.length === 0) {
      if (segment.redirects.length > 0)
        return { isParsed: false, reason: 'redirection without a command' };
      continue;
    }
    // After a keyword such as `do`, leading `NAME=value` words are assignments again.
    let assignments = segment.assignments;
    if (argv !== segment.argv) {
      const firstCommand = argv.findIndex((arg) => !ASSIGNMENT.test(arg.text));
      const count = firstCommand === -1 ? argv.length : firstCommand;
      assignments = [...assignments, ...argv.slice(0, count)];
      argv = argv.slice(count);
    }
    flat.push({ ...segment, assignments, argv });
    loopsAround.push(open.filter((loop) => loop !== undefined));
    alwaysRuns.push(open.length === 0 && isUnconditional[index]!);
  }
  if (open.length !== 0) return { isParsed: false, reason: 'unclosed compound command' };
  if (flat.length === 0) return { isParsed: false, reason: 'empty command' };
  return { isParsed: true, segments: markOptionSafe(flat, loopsAround, alwaysRuns) };
}

type Loop = { name: string; items: Word[]; header: number };

// Absolute paths in any session, set by the environment rather than the command.
const ENVIRONMENT_PATHS = new Set(['HOME', 'TMPDIR', 'PWD']);

// Marks the dynamic words whose values are known not to be options. A
// variable's value is known where exactly one binding in the command sets it:
// a loop header's words inside its body, or a written value assigned by a
// segment that always runs, after that segment.
function markOptionSafe(flat: Segment[], loopsAround: Loop[][], alwaysRuns: boolean[]): Segment[] {
  const bindings = new Map<string, number>();
  const bind = (name: string) => bindings.set(name, (bindings.get(name) ?? 0) + 1);
  for (const segment of flat) {
    if (segment.argv.length === 0)
      for (const assignment of segment.assignments)
        bind(assignment.text.slice(0, assignment.text.indexOf('=')));
    if (segment.argv[0]?.text === 'read') for (const arg of segment.argv.slice(1)) bind(arg.text);
  }
  const assigned = new Map<string, { index: number; value: string }>();
  for (const [index, segment] of flat.entries()) {
    if (segment.argv.length > 0 || !alwaysRuns[index]) continue;
    for (const assignment of segment.assignments) {
      const name = assignment.text.slice(0, assignment.text.indexOf('='));
      if (!assignment.isDynamic && bindings.get(name) === 1)
        assigned.set(name, { index, value: assignment.text.slice(name.length + 1) });
    }
  }

  return flat.map((segment, index) => {
    const safety = new Map<string, { isQuotedSafe: boolean; isUnquotedSafe: boolean }>();
    for (const name of ENVIRONMENT_PATHS)
      if (!bindings.has(name)) safety.set(name, { isQuotedSafe: true, isUnquotedSafe: true });
    for (const [name, { index: at, value }] of assigned) {
      if (at >= index) continue;
      const isQuotedSafe = !value.startsWith('-');
      safety.set(name, {
        isQuotedSafe,
        isUnquotedSafe: isQuotedSafe && value !== '' && !/[\s*?[]/.test(value),
      });
    }
    for (const loop of loopsAround[index]!) {
      if (bindings.get(loop.name) !== 1) continue;
      // A glob item starting with written text yields paths that start with it.
      const isQuotedSafe = loop.items.every((item) =>
        item.isDynamic
          ? item.head === 'literal' &&
            item.substitutions.length === 0 &&
            item.parameters.length === 0
          : !item.text.startsWith('-'),
      );
      const isUnquotedSafe =
        isQuotedSafe &&
        loop.items.every(
          (item) => !item.isDynamic && item.text !== '' && !/[\s*?[]/.test(item.text),
        );
      safety.set(loop.name, { isQuotedSafe, isUnquotedSafe });
    }
    const mark = (word: Word): Word => {
      if (!word.isDynamic) return word;
      const isOptionSafe =
        word.substitutions.length === 0 &&
        (word.head === 'literal' || word.head === 'parameter') &&
        word.parameters.every((parameter, position) => {
          const known = safety.get(parameter.name);
          if (position === 0 && word.head === 'parameter') {
            return (
              !parameter.hasOperator &&
              known !== undefined &&
              (parameter.isQuoted ? known.isQuotedSafe : known.isUnquotedSafe)
            );
          }
          return parameter.isQuoted || (!parameter.hasOperator && known?.isUnquotedSafe === true);
        });
      return { ...word, isOptionSafe };
    };
    return {
      ...segment,
      argv: segment.argv.map(mark),
      redirects: segment.redirects.map((redirect) =>
        redirect.target === undefined ? redirect : { ...redirect, target: mark(redirect.target) },
      ),
    };
  });
}

type SplitResult =
  | { isParsed: true; segments: Segment[]; isUnconditional: boolean[] }
  | { isParsed: false; reason: string };

// Splits a command line into segments, noting which ones always run in the
// shell itself: not after `&&` or `||`, and not inside a pipeline.
function split(source: string): SplitResult {
  let tokens: Token[];
  try {
    tokens = tokenize(source);
  } catch (error) {
    if (error instanceof Refusal) return { isParsed: false, reason: error.message };
    throw error;
  }

  const segments: Segment[] = [];
  const isUnconditional: boolean[] = [];
  let current: Segment = { assignments: [], argv: [], redirects: [] };
  let pendingOp: '&&' | '||' | ';' | '|' | undefined;
  let opBefore: typeof pendingOp;

  for (let k = 0; k < tokens.length; k += 1) {
    const token = tokens[k]!;
    if (token.kind === 'op') {
      const isEmpty = current.argv.length === 0 && current.assignments.length === 0;
      if (current.argv.length === 0 && current.redirects.length > 0) {
        return { isParsed: false, reason: 'redirection without a command' };
      }
      if (isEmpty) {
        // Only `;` may stand next to an empty segment (a trailing `;` or a blank line).
        if (token.op !== ';' || (pendingOp !== undefined && pendingOp !== ';')) {
          return { isParsed: false, reason: `operator ${token.op} without a command` };
        }
      } else {
        segments.push(opBefore === undefined ? current : { ...current, after: opBefore });
        isUnconditional.push((opBefore === undefined || opBefore === ';') && token.op !== '|');
        opBefore = token.op;
        current = { assignments: [], argv: [], redirects: [] };
      }
      pendingOp = token.op;
      continue;
    }
    if (token.kind === 'redirect') {
      if (token.isDuplication) {
        current.redirects.push({ op: token.op });
        continue;
      }
      const target = tokens[k + 1];
      if (target?.kind !== 'word')
        return { isParsed: false, reason: 'redirection without a target' };
      current.redirects.push({ op: token.op, target: target.word });
      k += 1;
      continue;
    }
    if (current.argv.length === 0 && ASSIGNMENT.test(token.word.text)) {
      current.assignments.push(token.word);
      continue;
    }
    current.argv.push(token.word);
  }

  if (current.argv.length > 0 || current.assignments.length > 0) {
    if (current.argv.length === 0 && current.redirects.length > 0)
      return { isParsed: false, reason: 'redirection without a command' };
    segments.push(opBefore === undefined ? current : { ...current, after: opBefore });
    isUnconditional.push(opBefore === undefined || opBefore === ';');
  } else if (current.redirects.length > 0) {
    return { isParsed: false, reason: 'redirection without a command' };
  } else if (pendingOp !== undefined && pendingOp !== ';') {
    return { isParsed: false, reason: `trailing ${pendingOp}` };
  }
  if (segments.length === 0) return { isParsed: false, reason: 'empty command' };
  return { isParsed: true, segments, isUnconditional };
}

export function parse(source: string): ParseResult {
  const result = split(source);
  return result.isParsed ? flatten(result.segments, result.isUnconditional) : result;
}
