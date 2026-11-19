import { describe, expect, test } from 'claude-code/testing';
import { auto } from './session.ts';
import { world } from './world.ts';

const RANDOM = 'q7Rk2Vx9Lm4Np8Ts3Wz6Yb1Hc5';
const OTHER = 'h4Jm9Qw2Zr7Tk5Vd8Xn3Lc6Pf0';
const JWT = ['eyJ', 'eyJ', ''].map((start) => `${start}${'x'.repeat(12)}`).join('.');
const SAVED = '/home/u/.claude/projects/p/s1/tool-results/t1.txt';
// A file the user keeps, in a folder that only has the engine's names above it.
const ELSEWHERE = '/home/u/s1/tool-results/notes/a.txt';
const MARKER = '[redacted by preallow: secret assignment]';
const bashRecord = (fields: Record<string, unknown>) => ({
  stdout: '',
  stderr: '',
  interrupted: false,
  ...fields,
});

describe('the full output a large result leaves in a file', () => {
  test('a credential is redacted in the file and in the result, wherever either shows a value the other gives away', async ($, on) => {
    // The name that gives the first value away is past what the result
    // shows, as is the whole JSON web token; the name that gives the second
    // away is only in the result.
    const w = world(on, {
      output: `Output too large, saved to ${SAVED}\ntoken=${OTHER}`,
      record: bashRecord({
        stdout: `first ${RANDOM}`,
        stderr: `token=${OTHER}`,
        persistedOutputPath: SAVED,
      }),
      files: new Map([[SAVED, `first ${RANDOM}\npassword=${RANDOM}\n${JWT}\nbare ${OTHER}\n`]]),
    });
    await auto($);
    const result = await $.tool.call({ tool: 'Bash', command: 'ps', tool_use_id: 't1' } as never);
    expect(w.files.get(SAVED)).toBe(
      `first ${MARKER}\npassword=${MARKER}\n[redacted by preallow: JSON web token]\nbare ${MARKER}\n`,
    );
    expect(result.result).toEqual(
      bashRecord({
        stdout: `first ${MARKER}`,
        stderr: `token=${MARKER}`,
        persistedOutputPath: SAVED,
      }),
    );
    expect(result.context).toHaveLength(1);
    expect((await w.logged(2))[1]).toMatchObject({
      event: 'redacted',
      kinds: ['JSON web token', 'secret assignment'],
      inSavedOutput: true,
    });
  });

  test("one that holds no credential is passed on, and one that cannot be rewritten or read, or is not the session's, is withheld with why", async ($, on) => {
    const w = world(on, {
      output: `Output too large, saved to ${SAVED}`,
      record: bashRecord({ persistedOutputPath: SAVED }),
      files: new Map([[SAVED, 'line\n'.repeat(3)]]),
    });
    await auto($);
    const call = (id: string) =>
      $.tool.call({ tool: 'Bash', command: `cat ${id}.log`, tool_use_id: id } as never);
    expect((await call('t1')).text).toBe(w.output);

    const holding = `line\npassword=${RANDOM}\n`;
    w.files.set(SAVED, holding);
    w.readOnly.add(SAVED);
    expect((await call('t2')).deny).toMatch(
      /^preallow: its full output in a file holds .*secret assignment/,
    );
    w.files.delete(SAVED);
    expect((await call('t3')).deny).toContain('could not be read');

    // A result can name any file; one the engine did not write for this
    // session is left as it is.
    w.record = bashRecord({ persistedOutputPath: ELSEWHERE });
    w.files.set(ELSEWHERE, holding);
    expect((await call('t4')).deny).toContain('its full output in a file holds');
    expect(w.files.get(ELSEWHERE)).toBe(holding);

    const withheld = (await w.logged(7)).filter((line) => line.event === 'withheld');
    expect(withheld.map((line) => line.error)).toEqual([
      expect.stringContaining('fs.write'),
      expect.stringContaining('fs.read'),
      expect.stringContaining('tool-results'),
    ]);
  });
});
