import { describe, expect, test } from 'claude-code/testing';
import { classify, type Effect } from '../hooks/classify.ts';
import { resolveEffect } from '../hooks/resolve.ts';
import { parse } from '../hooks/shell.ts';

// A repository on branch `feature` whose origin is github.com/o/r, with a
// local tag v1 and a remote-tracking branch `old`.
const BASE: Record<string, string> = {
  'git symbolic-ref --quiet --short HEAD': 'feature',
  'git config --get branch.feature.remote': 'origin',
  'git remote get-url --push --all origin': 'git@github.com:o/r.git',
  'git remote get-url --push --all mirror': 'git@mirror.example.com:o/r.git',
  'git symbolic-ref --quiet --short refs/remotes/origin/HEAD': 'origin/main',
  'git show-ref --verify --quiet refs/heads/feature': '',
  'git show-ref --verify --quiet refs/tags/v1': '',
  'git show-ref --verify --quiet refs/remotes/origin/old': '',
  'gh repo view --json url --jq .url': 'https://github.com/o/r',
  'gh pr view 12 --json number,headRefName --jq "\\(.number) \\(.headRefName)"': '12 topic',
};

function effectOf(command: string): Effect {
  const parsed = parse(command);
  if (!parsed.isParsed) throw new Error(parsed.reason);
  const verdict = classify(parsed.segments[0]!);
  if (verdict.kind !== 'effect') throw new Error(`${command}: ${verdict.kind}`);
  return verdict.effect;
}

function resolve(command: string, extra: Record<string, string> = {}) {
  const table = { ...BASE, ...extra };
  return resolveEffect(effectOf(command), '/repo', async (argv) => table[argv.join(' ')]);
}

describe('resolveEffect', () => {
  test('a push without a remote goes where git sends it', async () => {
    expect(await resolve('git push')).toEqual([
      { class: 'push', repo: 'github.com/o/r', branch: 'feature', isDefaultBranch: false },
    ]);
    expect(
      (await resolve('git push', { 'git config --get branch.feature.pushRemote': 'mirror' }))?.[0]
        ?.repo,
    ).toBe('mirror.example.com/o/r');
    expect(
      (await resolve('git push', { 'git config --get remote.pushDefault': 'mirror' }))?.[0]?.repo,
    ).toBe('mirror.example.com/o/r');
  });

  test('a push goes to the push URL, and to every one of several', async () => {
    expect(
      (
        await resolve('git push origin feature', {
          'git remote get-url --push --all origin': 'git@mirror.example.com:o/r.git',
        })
      )?.[0]?.repo,
    ).toBe('mirror.example.com/o/r');
    expect(
      await resolve('git push origin feature', {
        'git remote get-url --push --all origin':
          'git@github.com:o/r.git\ngit@mirror.example.com:o/r.git',
      }),
    ).toBeUndefined();
  });

  test('a push that may update several branches or another name is not resolved', async () => {
    expect(
      await resolve('git push', { 'git config --get push.default': 'matching' }),
    ).toBeUndefined();
    expect(
      await resolve('git push origin feature', {
        'git config --get-all remote.origin.push': 'refs/heads/*:refs/heads/x/*',
      }),
    ).toBeUndefined();
  });

  test('a short name that is a tag pushes the tag', async () => {
    expect(await resolve('git push origin v1')).toEqual([
      { class: 'tag_push', repo: 'github.com/o/r', tag: 'v1' },
    ]);
  });

  test('pushing tags alongside a branch needs a tag grant too', async () => {
    expect(
      (await resolve('git push --follow-tags origin feature'))?.map((action) => action.class),
    ).toEqual(['tag_push', 'push']);
  });

  test('deleting a tag is no tag push', async () => {
    expect(await resolve('git push origin :refs/tags/v1')).toBeUndefined();
    expect(await resolve('git push --delete origin v1')).toBeUndefined();
  });

  test('deleting a branch resolves only through its remote-tracking ref', async () => {
    expect(await resolve('git push origin --delete old')).toEqual([
      {
        class: 'remote_branch_delete',
        repo: 'github.com/o/r',
        branch: 'old',
        isDefaultBranch: false,
      },
    ]);
    expect(await resolve('git push origin --delete gone')).toBeUndefined();
  });

  test('a merge that deletes the branch also deletes its head branch', async () => {
    expect(await resolve('gh pr merge 12 --squash')).toEqual([
      { class: 'pr_merge', repo: 'github.com/o/r', number: 12 },
    ]);
    expect(await resolve('gh pr merge 12 --squash --delete-branch')).toEqual([
      { class: 'pr_merge', repo: 'github.com/o/r', number: 12 },
      { class: 'remote_branch_delete', repo: 'github.com/o/r', branch: 'topic' },
    ]);
  });
});
