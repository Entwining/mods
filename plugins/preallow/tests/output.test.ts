import { describe, expect, test } from 'claude-code/testing';
import { auto, bash, check } from './session.ts';
import { world } from './world.ts';

const RANDOM = 'q7Rk2Vx9Lm4Np8Ts3Wz6Yb1Hc5';
const FAKE_TOKEN = `sk-${RANDOM}`;
const KEY_LINES = Array.from({ length: 4 }, (_, i) => `${'MIIEpAIBAAKCAQEA'.slice(i)}${RANDOM}`);
const KEY = [
  `-----BEGIN RSA ${'PRIVATE KEY'}-----`,
  ...KEY_LINES,
  `-----END RSA ${'PRIVATE KEY'}-----`,
];

describe('output', () => {
  test('a call the plugin allowed has each credential in its output redacted, and runs again under the classifier', async ($, on) => {
    const w = world(on, {
      output: `ok\nTOKEN=${FAKE_TOKEN}`,
      record: { stdout: `ok\nTOKEN=${FAKE_TOKEN}`, stderr: '', interrupted: false },
    });
    await auto($);
    const result = await $.tool.call({
      tool: 'Bash',
      command: 'cat config.json',
      tool_use_id: 't1',
    } as never);
    expect(w.ran).toBe(1);
    expect(result.result).toEqual({
      stdout: 'ok\nTOKEN=[redacted by preallow: API key]',
      stderr: '',
      interrupted: false,
    });
    expect(result.text).toBeUndefined();
    expect(result.ref).toBeUndefined();
    expect(result.context).toHaveLength(1);
    const lines = await w.logged(2);
    expect(lines[1]).toMatchObject({
      event: 'redacted',
      tool_use_id: 't1',
      kinds: ['API key', 'secret assignment'],
    });
    expect(JSON.stringify([result, lines])).not.toContain(FAKE_TOKEN);
    expect((await check($, 'Bash', bash('cat config.json'))).decision).toBe('ask');
    expect((await check($, 'Bash', bash('cat other.json'))).decision).toBe('allow');

    // A failed call's text is all the model reads of it.
    w.callFails = true;
    w.output = `password=${RANDOM}, retried with ${RANDOM}`;
    const failed = await $.tool.call({
      tool: 'Bash',
      command: 'cat secret.json',
      tool_use_id: 't3',
    } as never);
    expect(failed.deny).toContain(
      'password=[redacted by preallow: secret assignment], retried with [redacted by preallow: secret assignment]',
    );
  });

  test('output is passed on when it holds no credential, only a field the model does not read holds one, or the plugin did not allow the call', async ($, on) => {
    const w = world(on, { output: 'version 1.2.3' });
    await auto($);
    const call = (id: string) =>
      $.tool.call({ tool: 'Bash', command: 'cat config.json', tool_use_id: id } as never);
    expect((await call('t1')).text).toBe('version 1.2.3');
    w.callFails = true;
    expect((await call('t2')).text).toBe('version 1.2.3');
    w.callFails = false;
    // An Edit result keeps the file it changed, which its text does not show.
    w.record = { filePath: '/w/app.env', originalFile: `TOKEN=${FAKE_TOKEN}` };
    expect((await call('t4')).result).toEqual(w.record);
    w.record = undefined;
    w.output = `TOKEN=${FAKE_TOKEN}`;
    w.core = { decision: 'allow' };
    expect((await call('t3')).text).toContain(FAKE_TOKEN);
  });

  test('a key shown with line numbers is redacted whole, in a Read record and in Bash output', async ($, on) => {
    const content = `before\n${KEY.join('\n')}\nafter`;
    const numbered = content
      .split('\n')
      .map((line, i) => `${String(i + 1).padStart(6)}\t${line}`)
      .join('\n');
    const w = world(on, { output: numbered, record: { type: 'text', file: { content } } });
    await auto($);
    const result = await $.tool.call({
      tool: 'Read',
      file_path: '/w/key.pem',
      tool_use_id: 't1',
    } as never);
    const redacted = (result.result as { file: { content: string } }).file.content;
    expect(redacted).toBe(`before\n[redacted by preallow: private key]${'\n'.repeat(5)}\nafter`);
    expect(w.ran).toBe(1);

    w.record = { stdout: numbered, stderr: '', interrupted: false };
    const printed = await $.tool.call({
      tool: 'Bash',
      command: 'cat -n key.pem',
      tool_use_id: 't2',
    } as never);
    expect((printed.result as { stdout: string }).stdout).toBe(
      `     1\tbefore\n     2\t[redacted by preallow: private key]${'\n'.repeat(6)}     8\tafter`,
    );
  });

  test('a credential that line numbers hide from the shapes in the text is redacted in the record, with its copies', async ($, on) => {
    const numbered = (content: string) =>
      content
        .split('\n')
        .map((line, i) => `${String(i + 1).padStart(6)}\t${line}`)
        .join('\n');
    const content = `machine example.com login u password ${RANDOM}`;
    // The copy comes before the value the shapes find.
    const w = world(on, {
      output: numbered(content),
      record: { type: 'text', [RANDOM]: 'name', file: { content } },
    });
    await auto($);
    const read = (id: string) =>
      $.tool.call({ tool: 'Read', file_path: `/w/${id}`, tool_use_id: id } as never);
    const marker = '[redacted by preallow: netrc password]';
    expect((await read('t1')).result).toEqual({
      type: 'text',
      [marker]: 'name',
      file: { content: `machine example.com login u password ${marker}` },
    });
    w.context = [`retried with ${RANDOM}`];
    expect((await read('t2')).deny).toMatch(/^preallow: it holds .*netrc password/);
    w.context = undefined;

    // A key wrapped too narrow to give a line its own run of the body.
    const key = `-----BEGIN ${'PRIVATE KEY'}-----\n${'q7Rk2Vx9\n'.repeat(8)}-----END ${'PRIVATE KEY'}-----`;
    w.output = numbered(key);
    w.record = { type: 'text', file: { content: key } };
    expect((await read('t3')).result).toEqual({
      type: 'text',
      file: { content: `[redacted by preallow: private key]${'\n'.repeat(9)}` },
    });
  });

  test('a value found once is redacted where the shapes do not find it', async ($, on) => {
    // The shapes find the value by the name before it, which only the text
    // shows; the record also holds it under another name, and as a name.
    world(on, {
      output: `{"password": "${RANDOM}"}`,
      record: { password: RANDOM, copy: RANDOM, [RANDOM]: 'name' },
    });
    await auto($);
    const result = await $.tool.call({ tool: 'mcp__srv__lookup', tool_use_id: 't1' } as never);
    const marker = '[redacted by preallow: secret assignment]';
    expect(result.result).toEqual({ password: marker, copy: marker, [marker]: 'name' });
  });

  test("output the model would read later, from a file, from a hook's own result, or beside it is scanned, and redacted or withheld", async ($, on) => {
    const w = world(on, {
      output: 'Output too large, saved to /out/t1.txt',
      record: { stdout: '', persistedOutputPath: '/out/t1.txt' },
    });
    await auto($);
    const call = (command: string, id: string) =>
      $.tool.call({ tool: 'Bash', command, tool_use_id: id } as never);
    w.files.set('/out/t1.txt', `line\nTOKEN=${FAKE_TOKEN}\n`);
    expect((await call('cat a.log', 't1')).deny).toContain('API key');
    w.files.set('/out/t1.txt', 'line\n'.repeat(3));
    expect((await call('cat b.log', 't2')).text).toBe('Output too large, saved to /out/t1.txt');
    w.files.delete('/out/t1.txt');
    expect((await call('cat c.log', 't3')).deny).toContain('could not be read');
    w.output = undefined;
    w.record = { stdout: `TOKEN=${FAKE_TOKEN}` };
    expect((await call('cat e.log', 't5')).result).toEqual({
      stdout: 'TOKEN=[redacted by preallow: API key]',
    });
    // A key wrapped too narrow to give a line its own run of the body.
    w.output = `-----BEGIN ${'PRIVATE KEY'}-----\n${'q7Rk2Vx9\n'.repeat(8)}`;
    expect((await call('cat k.log', 't9')).deny).toMatch(/^preallow: it holds .*private key/);
    w.output = `password=${RANDOM}`;
    w.record = undefined;
    w.context = [`retried with ${RANDOM}`];
    expect((await call('cat f.log', 't6')).deny).toMatch(/^preallow: it holds .*secret assignment/);
    w.output = 'ok';
    w.context = [`TOKEN=${FAKE_TOKEN}`];
    expect((await call('cat g.log', 't7')).deny).toMatch(/^preallow: it holds .*API key/);
    // A failed call carries no word from the engine that it ran.
    w.callFails = true;
    expect((await call('cat h.log', 't8')).deny).toMatch(/^The call was made, .*API key/);
  });
});
