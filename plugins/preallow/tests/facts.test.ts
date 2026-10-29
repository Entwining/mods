import { describe, expect, test } from 'claude-code/testing';

import { auto, bash, check, promptOf, say } from './session.ts';
import { world } from './world.ts';

describe('facts through the judge', () => {
  const CHECK = JSON.stringify({
    reason: 'whether the reset discards uncommitted work',
    verdict: 'check',
    check: [{ path: '/w' }, { repo: '/w', ref: 'origin/topic' }],
  });

  test('the judge decides again with what the checks found', async ($, on) => {
    const w = world(on, {
      replies: [CHECK],
      git: {
        'rev-parse --show-toplevel': { exitCode: 0, stdout: '/w\n' },
        'status --porcelain=v1 -z --untracked-files=all --ignored=matching -- /w': {
          exitCode: 0,
          stdout: ' M src/a.ts\0',
        },
        'rev-parse --verify --quiet origin/topic^{commit}': { exitCode: 1, stdout: '' },
      },
      files: new Map([['/w', '']]),
    });
    await auto($);
    await say($, 'start over from main');
    expect((await check($, 'Bash', bash('git reset --hard origin/main'))).decision).toBe('allow');
    expect(w.modelCalls).toHaveLength(2);
    expect(promptOf(w, 0).facts).toBeUndefined();
    expect(promptOf(w, 1).facts!.answers).toMatchObject([
      { path: '/w', exists: true, git: { uncommittedChanges: { count: 1, first: ['src/a.ts'] } } },
      { repo: '/w', ref: 'origin/topic', exists: false },
    ]);
    const [line] = await w.logged(1);
    expect(line!.checks).toEqual([{ path: '/w' }, { repo: '/w', ref: 'origin/topic' }]);
    expect(line!.facts).toEqual(promptOf(w, 1).facts);
  });
});
