import { describe, expect, test } from 'claude-code/testing';
import { classify } from '../hooks/classify.ts';
import { parse } from '../hooks/shell.ts';

function kinds(command: string): string[] | string {
  const parsed = parse(command);
  if (!parsed.isParsed) return `refused: ${parsed.reason}`;
  return parsed.segments.map((segment) => {
    const result = classify(segment);
    return result.kind === 'effect' ? `effect:${result.effect.kind}` : result.kind;
  });
}

describe('parse refuses what it cannot read', () => {
  for (const command of [
    'echo $((1 + 2))',
    'echo $(unterminated',
    'diff <(ls a) <(ls b)',
    'cat <<EOF\nx\nEOF',
    'sleep 5 &',
    '(cd x && ls)',
    '{ ls; }',
    "echo $'a\\nb'",
    'echo "unterminated',
    'ls &&',
    'ls | | wc',
    'cat <<<word',
    'echo ${X@P}',
    'echo "${(e)X}"',
    'echo ${!X}',
    'echo ${X:$Y}',
    'echo ${X[$Y]}',
    'echo "$X[1]"',
  ]) {
    test(command, () => {
      expect(parse(command).isParsed).toBe(false);
    });
  }
});

describe('parse reads plain command lines', () => {
  test('operators, quotes and continuations', () => {
    const parsed = parse('git log --oneline -5 && rg -n \'a b\' src | head -3; \\\n echo "x y"');
    expect(parsed.isParsed).toBe(true);
    if (!parsed.isParsed) return;
    expect(parsed.segments.map((segment) => segment.argv.map((word) => word.text))).toEqual([
      ['git', 'log', '--oneline', '-5'],
      ['rg', '-n', 'a b', 'src'],
      ['head', '-3'],
      ['echo', 'x y'],
    ]);
  });

  test('descriptor numbers attach to their redirection', () => {
    const parsed = parse('git status 2>&1 >/dev/null');
    expect(parsed.isParsed).toBe(true);
    if (!parsed.isParsed) return;
    expect(parsed.segments[0]!.argv.map((word) => word.text)).toEqual(['git', 'status']);
    expect(parsed.segments[0]!.redirects.map((redirect) => redirect.op)).toEqual(['2>&1', '>']);
  });

  test('parameter expansions mark the word dynamic, single quotes do not', () => {
    const parsed = parse('echo "$HOME" \'$HOME\' $1');
    expect(parsed.isParsed).toBe(true);
    if (!parsed.isParsed) return;
    expect(parsed.segments[0]!.argv.map((word) => word.isDynamic)).toEqual([
      false,
      true,
      false,
      true,
    ]);
  });

  test('a trailing semicolon or blank line is fine', () => {
    expect(kinds('ls;\n')).toEqual(['read']);
  });

  test('compound commands must balance', () => {
    expect(parse('for f in a; do ls').isParsed).toBe(false);
    expect(parse('ls; done').isParsed).toBe(false);
    expect(parse('case x in a) ls;; esac').isParsed).toBe(false);
  });

  test('a redirection needs a command', () => {
    expect(parse('> out.txt').isParsed).toBe(false);
    expect(parse('X=1 > out.txt').isParsed).toBe(false);
  });
});

describe('classify', () => {
  const cases: Array<[string, string[] | string]> = [
    ['ls -la && cat README.md | head -20', ['read', 'read', 'read']],
    ['rg --pre cat foo', ['unknown']],
    ['find . -name x -delete', ['unknown']],
    ['find . -name "*.ts" -type f', ['read']],
    ["sed -n '10,20p' file", ['read']],
    ["sed -i '' s/a/b/ file", ['unknown']],
    ["sed 's/a/b/w out' file", ['unknown']],
    ['echo hi > out.txt', ['unknown']],
    ['echo hi > /dev/null 2>&1', ['read']],
    ['sort -o out in', ['unknown']],
    ['ps aux', ['read']],
    ['ps -ax -o pid,command', ['read']],
    ['ps eww', ['unknown']],
    ['ps -E -p 1', ['unknown']],
    ['ps -axE', ['unknown']],
    ['uniq in out', ['unknown']],
    ['FOO=1 ls', ['unknown']],
    ['LANG=C ls', ['read']],
    ['git -c core.pager=x log', ['unknown']],
    ['git -C ../other status', ['read']],
    ['git branch', ['read']],
    ['git branch --contains HEAD -a', ['read']],
    ['git branch new-feature', ['unknown']],
    ['git branch -D old', ['unknown']],
    ['git tag -l "v*"', ['read']],
    ['git tag v1.0', ['unknown']],
    ['git config --get user.email', ['read']],
    ['git config user.email x@y', ['unknown']],
    ['git fetch --upload-pack=evil origin', ['unknown']],
    ['git grep -Ovim foo', ['unknown']],
    ['git diff --no-index /outside/repo/file /dev/null', ['unknown']],
    ['git diff --ext-diff', ['unknown']],
    ['git stash list', ['read']],
    ['git stash pop', ['unknown']],
    ['git checkout main', ['unknown']],
    ['git push --dry-run origin main', ['unknown']],
    ['git push origin feature', ['effect:push']],
    ['git push --no-verify origin feature', ['unknown']],
    ['gh pr view 12 --json title', ['read']],
    ['gh pr merge 12 --squash', ['effect:pr_merge']],
    ['gh pr merge 12 --admin', ['unknown']],
    ['gh pr comment 12 --body-file /tmp/x', ['unknown']],
    ['gh release create v1.0 --notes x', ['unknown']],
    ['gh auth token', ['unknown']],
    ["gh api 'repos/o/r/pulls?per_page=100' --jq '.[].number'", ['read']],
    ['gh api -X POST repos/o/r/issues', ['unknown']],
    ['gh api repos/o/r/issues -f title=x', ['unknown']],
    ["gh api graphql -f query='query { viewer { login } }'", ['read']],
    ["gh api graphql -f query='mutation { x }'", ['unknown']],
    ['glab mr view 3', ['read']],
    ['glab mr merge 3', ['effect:pr_merge']],
    ['cd ../x && git status', ['cd', 'read']],
    ['curl https://example.com', ['unknown']],
    ['env', ['unknown']],
    ['echo $(whoami) `date`', ['read']],
    ['echo "$(git log --format="%h" -1)"', ['read']],
    ['echo $(rm -rf x)', ['unknown']],
    ['echo $(echo $(rm -rf x))', ['unknown']],
    ['d=$(mktemp -d "$TMPDIR/x.XXXX")', ['assignment']],
    ['gh pr comment 1 --body "$(cat notes.md)"', ['unknown']],
    ['git push origin $(git branch --show-current)', ['unknown']],
    ['for f in a b $(ls); do wc -l "$f"; done | sort', ['assignment', 'read', 'read']],
    ['for f in a b; do rm "$f"; done', ['assignment', 'unknown']],
    ['if [ -f x ]; then cat x; else echo none; fi', ['read', 'read', 'read']],
    ['git log | while read l; do echo "$l"; done > out', ['read', 'read', 'read', 'unknown']],
    ['if ! git diff --quiet; then git push origin main; fi', ['read', 'effect:push']],
    ['find . ! -name "*.md"', ['read']],
    ['H=/opt/x; ls $H/lib', ['assignment', 'read']],
    ['PATH=/tmp/evil:$PATH; ls', ['unknown', 'read']],
    ['HOME=/tmp/x; git status', ['unknown', 'read']],
    ['/bin/ls -la', ['read']],
    ['/opt/x/bin/ls', ['unknown']],
    ['command -v jq', ['read']],
    ['command -v jq > out', ['unknown']],
    ['fd -e ts -x rm', ['unknown']],
    ['echo "${X:-default}" ${#X} ${X%.ts} ${X//a/b}', ['read']],
    ['cat < notes.md', ['read']],
    ['cat < /dev/tcp/example.com/80', ['unknown']],
    ['cat < $F', ['unknown']],
    ['git push origin feature < /dev/tcp/example.com/80', ['unknown']],
    // Words the shell expands into others reach option-checked programs only written out.
    ['find . {-print,-delete}', ['unknown']],
    ['find . $(echo -delete)', ['unknown']],
    ['find . -name *.ts', ['unknown']],
    ['ls *.ts {a,b}', ['read']],
    ['git log -1 HEAD@{1}', ['read']],
    ['mkdir -p x', ['unknown']],
    ['tree -o x .', ['unknown']],
    ['xxd in out', ['unknown']],
    ['sort -r in', ['read']],
    ['sort -o/tmp/x in', ['unknown']],
    ['sort -ro x in', ['unknown']],
    ['sort --out=x in', ['unknown']],
    ['fd -Hx rm', ['unknown']],
    ['file README.md', ['read']],
    ['file -C -m x', ['unknown']],
    ["printf '%s\\n' a", ['read']],
    ['printf -v PATH /x', ['unknown']],
    ['read -r PATH', ['unknown']],
    ['git diff --no-ext-diff', ['read']],
    ['git log --out=x', ['unknown']],
    ['git config get user.email', ['read']],
    ['git config --list --file x', ['unknown']],
    ['git config --blob HEAD:x --list', ['unknown']],
    ['git blame --contents x HEAD -- f', ['unknown']],
    ['git fetch origin', ['read']],
    ['git fetch https://example.com/x.git', ['unknown']],
    ['gh api -X POST -X GET repos/o/r', ['read']],
    ['gh api -X GET -X POST repos/o/r', ['unknown']],
    ['gh api -XPOST repos/o/r', ['unknown']],
    ["gh api graphql -fquery='mutation { x }'", ['unknown']],
    ['gh api graphql -f query="$(cat q.graphql)"', ['unknown']],
    ["gh api graphql -f query='query { a }' -f query='mutation { b }'", ['unknown']],
    ['gh pr merge --admin=true 12', ['unknown']],
    ['gh pr merge --match-head-commit abc 12', ['effect:pr_merge']],
    ['gh pr merge feature-branch', ['unknown']],
    ['gh pr merge 12 --subject x', ['unknown']],
    // A dynamic word may reach an option-checked program when it cannot become an option.
    ['for d in a b; do find "$d" -name x; done', ['assignment', 'read']],
    ['for d in a -delete; do find . "$d"; done', ['assignment', 'unknown']],
    ['for d in a b; do find . $d; done', ['assignment', 'read']],
    ['for s in \'a b\' c; do rg "$s" x; done', ['assignment', 'read']],
    ["for s in 'a -b' c; do rg $s x; done", ['assignment', 'unknown']],
    ['for f in src/*.ts; do rg -n x "$f"; done', ['assignment', 'read']],
    ['for f in *; do rg x "$f"; done', ['assignment', 'unknown']],
    ['for d in a b; do d=-x; find . "$d"; done', ['assignment', 'assignment', 'unknown']],
    ['rg x "$d"; for d in a; do true; done', ['unknown', 'assignment', 'read']],
    ['rg x "$TMPDIR/a"', ['read']],
    ['rg x "$OTHER"', ['unknown']],
    ['rg x "/tmp/$OTHER"', ['read']],
    ['rg x /tmp/$OTHER', ['unknown']],
    ['rg x "${X:--delete}"', ['unknown']],
    ['rg x "$@"', ['unknown']],
    ['for b in main; do git push origin "$b"; done', ['assignment', 'unknown']],
    ['S=/repo/docs; rg x $S/a', ['assignment', 'read']],
    ['S=-x; rg x "$S"', ['assignment', 'unknown']],
    ['rg x "$S"; S=/repo', ['unknown', 'assignment']],
    ['true && S=/repo; rg x "$S"', ['read', 'assignment', 'unknown']],
    ['S=/repo; S=-x; rg x "$S"', ['assignment', 'assignment', 'unknown']],
    ["S='a b'; rg x $S", ['assignment', 'unknown']],
  ];
  for (const [command, expected] of cases) {
    test(command, () => {
      expect(kinds(command)).toEqual(expected);
    });
  }
});
