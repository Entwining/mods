import { describe, expect, test } from 'claude-code/testing';

import { gatherFacts } from '../hooks/facts.ts';
import { AFTER, host } from './host.ts';

// How the facts ask git for a ref's upstream and the remotes' default
// branches.
const NAMED = 'for-each-ref --format=%(refname) %(symref) %(upstream)';
const REMOTE_HEADS = 'refs/remotes/*/HEAD';

describe('gatherFacts', () => {
  test('a ref: its commit, what only it holds, and what else holds it', async () => {
    const { h, files } = host({
      'rev-parse --verify --quiet origin/topic^{commit}': { stdout: 'c0ffee\n' },
      'rev-parse --symbolic-full-name origin/topic': { stdout: 'refs/remotes/origin/topic\n' },
      // A remote's HEAD naming the ref holds nothing of its own.
      'for-each-ref --contains c0ffee --format=%(refname) %(symref)': {
        stdout:
          'refs/heads/main \nrefs/remotes/origin/HEAD refs/remotes/origin/topic\nrefs/remotes/origin/topic \n',
      },
      'rev-list c0ffee --not --exclude=refs/remotes/origin/topic --exclude=refs/remotes/origin/HEAD --glob=refs/*':
        { stdout: 'c0ffee\nc0de\n' },
      [`${NAMED} refs/remotes/origin/topic ${REMOTE_HEADS}`]: {
        stdout: 'refs/remotes/origin/topic  \nrefs/remotes/origin/HEAD refs/remotes/origin/main \n',
      },
      'for-each-ref --format=%(refname) refs/remotes/origin/main': {
        stdout: 'refs/remotes/origin/main\n',
      },
      'cherry refs/remotes/origin/main c0ffee': { stdout: '+ c0ffee\n- c0de\n' },
      'rev-parse --path-format=absolute --git-common-dir': { stdout: '/w/.git\n' },
      'rev-parse --verify --quiet gone^{commit}': { exitCode: 1, stdout: '' },
    });
    const { answers } = await gatherFacts(h, [
      { repo: '/w', ref: 'origin/topic' },
      { repo: '/w', ref: 'gone' },
    ]);
    expect(answers).toEqual([
      {
        repo: '/w',
        ref: 'origin/topic',
        exists: true,
        fullName: 'refs/remotes/origin/topic',
        commit: 'c0ffee',
        commitsReachableOnlyFromThisRef: 2,
        ofThoseWithAnEquivalentPatchIn: { 'refs/remotes/origin/main': 1 },
        otherRefsContainingIt: { count: 1, first: ['refs/heads/main'] },
        remoteRefsAsOfLastFetch: new Date(AFTER).toISOString(),
      },
      { repo: '/w', ref: 'gone', exists: false },
    ]);
    const lastFetch = async () =>
      (
        (await gatherFacts(h, [{ repo: '/w', ref: 'origin/topic' }])).answers[0] as Record<
          string,
          unknown
        >
      ).remoteRefsAsOfLastFetch;
    files.delete('/w/.git/FETCH_HEAD');
    expect(await lastFetch()).toBe(new Date(AFTER).toISOString());
    files.delete('/w/.git/worktrees/wt1/FETCH_HEAD');
    expect(await lastFetch()).toBe('no fetch recorded');
  });

  test("a ref's unique commits are compared by patch with the branch it follows and each remote's default branch, as far as they exist", async () => {
    const { h, runs } = host({
      'rev-parse --verify --quiet topic^{commit}': { stdout: 'c0ffee\n' },
      'rev-parse --symbolic-full-name topic': { stdout: 'refs/heads/topic\n' },
      'rev-list c0ffee --not --exclude=refs/heads/topic --glob=refs/*': {
        stdout: 'c0ffee\nc0de\n',
      },
      // Its upstream is gone from the remote, and one remote names no
      // default branch.
      [`${NAMED} refs/heads/topic ${REMOTE_HEADS}`]: {
        stdout: [
          'refs/heads/topic  refs/remotes/origin/topic',
          'refs/remotes/origin/HEAD refs/remotes/origin/main ',
          'refs/remotes/fork/HEAD refs/remotes/fork/trunk ',
          'refs/remotes/mirror/HEAD  ',
          '',
        ].join('\n'),
      },
      'for-each-ref --format=%(refname) refs/remotes/origin/topic refs/remotes/origin/main refs/remotes/fork/trunk':
        { stdout: 'refs/remotes/fork/trunk\nrefs/remotes/origin/main\n' },
      // A commit other refs also hold has its patch there too.
      'cherry refs/remotes/origin/main c0ffee': { stdout: '- 5eed\n- c0ffee\n- c0de\n' },
      'cherry refs/remotes/fork/trunk c0ffee': { stdout: '+ c0ffee\n- c0de\n' },
      // The remote's default branch itself, ahead of every other ref.
      'rev-parse --verify --quiet origin/main^{commit}': { stdout: 'face\n' },
      'rev-parse --symbolic-full-name origin/main': { stdout: 'refs/remotes/origin/main\n' },
      'rev-list face --not --exclude=refs/remotes/origin/main --glob=refs/*': {
        stdout: 'face\n',
      },
      'for-each-ref --format=%(refname) refs/remotes/origin/main': {
        stdout: 'refs/remotes/origin/main\n',
      },
      [`${NAMED} refs/remotes/origin/main ${REMOTE_HEADS}`]: {
        stdout: 'refs/remotes/origin/main  \nrefs/remotes/origin/HEAD refs/remotes/origin/main \n',
      },
    });
    const { answers } = await gatherFacts(h, [
      { repo: '/w', ref: 'topic' },
      { repo: '/w', ref: 'origin/main' },
    ]);
    expect(answers).toMatchObject([
      {
        commitsReachableOnlyFromThisRef: 2,
        ofThoseWithAnEquivalentPatchIn: {
          'refs/remotes/origin/main': 2,
          'refs/remotes/fork/trunk': 1,
        },
      },
      { commitsReachableOnlyFromThisRef: 1, ofThoseWithAnEquivalentPatchIn: {} },
    ]);
    expect(runs.filter(({ argv }) => argv.includes('cherry'))).toHaveLength(2);
  });

  test('a ref whose commits other refs all hold is not compared by patch', async () => {
    const { h, runs } = host({
      'rev-parse --verify --quiet main^{commit}': { stdout: 'c0ffee\n' },
      'rev-parse --symbolic-full-name main': { stdout: 'refs/heads/main\n' },
    });
    const { answers } = await gatherFacts(h, [{ repo: '/w', ref: 'main' }]);
    expect(answers[0]).toMatchObject({ commitsReachableOnlyFromThisRef: 0 });
    expect(answers[0]).not.toHaveProperty('ofThoseWithAnEquivalentPatchIn');
    expect(runs.some(({ argv }) => argv.includes('cherry') || argv.includes(REMOTE_HEADS))).toBe(
      false,
    );
  });
});
