import { describe, expect, test } from 'claude-code/testing';
import { rules } from '../hooks/gitleaks.generated.ts';
import { findSecret } from '../hooks/withhold.ts';
import { auto, bash, check } from './session.ts';
import { world } from './world.ts';

// Values are built at run time, so no scanner takes the source for a leak.
const RANDOM = 'q7Rk2Vx9Lm4Np8Ts3Wz6Yb1Hc5';
const FAKE_TOKEN = `sk-${RANDOM}`;
// A value spread evenly over its alphabet, as uniform as a generated token.
const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const mixed = (n: number, alphabet = B62) =>
  Array.from({ length: n }, (_, i) => alphabet[(i * 7) % alphabet.length]).join('');

describe('findSecret', () => {
  const found: Array<[string, string]> = [
    ['private key', `-----BEGIN OPENSSH ${'PRIVATE KEY'}-----`],
    ['API key', `sk-ant-api03-${RANDOM}`],
    ['JSON web token', `eyJ${RANDOM}.eyJ${RANDOM}.${RANDOM}`],
    ['URL credential', `proxy=http://user:${RANDOM.slice(0, 10)}@10.0.0.1:3128`],
    ['auth header', `Authorization: Basic ${RANDOM}`],
    ['auth header', `x-api-key: ${RANDOM}.${RANDOM}`],
    ['bearer token', `curl -H "x: Bearer ya29.${RANDOM}"`],
    ['secret assignment', `DB_PASSWORD="${RANDOM}"`],
    ['private key', `-----BEGIN PGP ${'PRIVATE KEY'} BLOCK-----`],
    ['secret assignment', `aws_secret_access_key = ${RANDOM}`],
    ['secret assignment', `SERVICE_KEY=${RANDOM}`],
    ['secret assignment', `"token": "${RANDOM}.${RANDOM}"`],
    ['secret assignment', `the token is token=${RANDOM}.`],
    ['netrc password', `machine example.com login u password ${'hunter'}`],
    ['private key', `PuTTY-User-Key-File-3: ssh-ed25519`],
    ['private key', `AGE-SECRET-KEY-1${RANDOM.toUpperCase()}`],
    ['webhook URL', `https://hooks.slack.com/services/T0/B0/${RANDOM}`],
    ['secret assignment', `SERVICE_KEY: ${RANDOM}`],
    ['secret assignment', `DefaultEndpointsProtocol=https;AccountKey=${RANDOM}==;`],
    ['netrc password', `default\n  login u\n  password ${'hunter'}`],
    ['netrc password', `machine example.com\n  password ${'hunter'} login u`],
    ['registry credential', `{"auths": {"r.example.com": {"auth": "${'dTpw'.repeat(5)}"}}}`],
    ['session cookie', `Cookie: theme=dark; sessionid=${RANDOM}`],
    ['session cookie', `curl -b 'connect.sid=s%3A${RANDOM}.${RANDOM}' https://example.com`],
    ['session cookie', `Set-Cookie: PHPSESSID=${RANDOM.toLowerCase()}; Path=/`],
    ['github-pat', `key: ghp_${mixed(36)}`],
    ['aws-access-token', `AKIA${mixed(16, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567')}`],
    ['slack-bot-token', `xoxb-1234567890-1234567890${mixed(24)}`],
    ['stripe-access-token', `sk_live_${mixed(24)}`],
    ['curl-auth-user', `curl -u admin:${mixed(12)} https://example.com`],
    ['kubernetes-secret-yaml', `kind: Secret\ndata:\n  cert: ${mixed(24)}`],
    ['npm-access-token', `The token is npm_${mixed(36)}.`],
    ['atlassian-api-token', `ATATT3${mixed(186)}`],
  ];
  for (const [kind, text] of found) {
    test(`${kind}: ${text}`, () => {
      expect(findSecret(text)).toBe(kind);
    });
  }

  const clean = [
    'const token = req.headers.authorization',
    'const secretToken = settings.v2.signingKeyName',
    'const apiToken = credentialsStore2024.current',
    'const apiKey = process.env.OPENAI_API_KEY_VALUE',
    'ANTHROPIC_API_KEY = "replace-with-your-key"',
    'Authorization: Bearer ${token}',
    'DATABASE_URL=postgres://postgres:postgres@localhost/db',
    'password: string',
    'token_count = 1234567890123456789',
    'const cacheKey = "user123abc456def789"',
    'token = config.tokens2024.primary',
    'The default timeout applies; see the password reset guide.',
    `sessionId=${['3f2a9c4e', '7b1d', '4e8a', '9c2f', '5d6e7a8b9c0d'].join('-')}`,
    'session_timeout=3600',
    `considered=${RANDOM}`,
    // Too uniform for gitleaks' rule, whose entropy is taken from the value
    // alone; a known example key; a stopword; and a Secret in the document
    // after the data.
    `ghp_${'x'.repeat(36)}`,
    'curl -u aaa:aaaaaaaaaa https://example.com',
    `AKIA${'IOSFODNN7'}EXAMPLE`,
    `hf_${'ABCDEFGHIJKLMNOPQRSTUVWXYZ'}abcdefgh`,
    `data:\n  color: ${'Ymx1ZQ'.repeat(3)}\n---\napiVersion: v1\nkind: Secret\ntype: Opaque`,
  ];
  for (const [name, run] of [
    ['word characters and hyphens', 'a-'.repeat(500_000)],
    ['blank lines', '\n'.repeat(100_000)],
    ['indented blank lines', '  \n'.repeat(50_000)],
    ['netrc machine lines', 'machine a\n'.repeat(100_000)],
    ['secret names', 'A_KEY='.repeat(100_000)],
    ['cookie names', 'sess'.repeat(250_000)],
  ] as const) {
    test(`a long run of ${name} scans in linear time`, () => {
      const start = performance.now();
      findSecret(run);
      expect(performance.now() - start).toBeLessThan(2000);
    });
  }

  test("an output holding every gitleaks rule's keyword before long runs, and no secret, scans within the hook's budget", () => {
    const keywords = [...new Set(rules.flatMap((rule) => rule.keywords))];
    for (const run of ['.', 'a.', ' ']) {
      const unit = keywords.map((k) => `${k}${run.repeat(400)}`).join(' ');
      const start = performance.now();
      expect(findSecret(unit.repeat(Math.ceil(1_000_000 / unit.length)))).toBeUndefined();
      expect(performance.now() - start).toBeLessThan(2000);
    }
  });

  for (const text of clean) {
    test(`no secret: ${text}`, () => {
      expect(findSecret(text)).toBeUndefined();
    });
  }
});

describe('output', () => {
  test('a call the plugin allowed has its output withheld when it holds a credential, and runs again under the classifier', async ($, on) => {
    const w = world($, on, { output: `TOKEN=${FAKE_TOKEN}` });
    await auto($);
    const result = await $.tool.call({
      tool: 'Bash',
      command: 'cat config.json',
      tool_use_id: 't1',
    } as never);
    expect(w.ran).toBe(1);
    expect(result.deny).toContain('API key');
    expect(result.deny).toMatch(/^preallow: it holds/);
    expect(JSON.stringify(result)).not.toContain(FAKE_TOKEN);
    const lines = await w.logged(2);
    expect([lines[1]!.event, lines[1]!.why]).toEqual([
      'withheld',
      'it holds what looks like a credential (API key)',
    ]);
    expect(JSON.stringify(lines)).not.toContain(FAKE_TOKEN);
    expect((await check($, 'Bash', bash('cat config.json'))).decision).toBe('ask');
    expect((await check($, 'Bash', bash('cat other.json'))).decision).toBe('allow');

    // A failed call carries no word from the engine that it ran.
    w.callFails = true;
    const failed = await $.tool.call({
      tool: 'Bash',
      command: 'cat secret.json',
      tool_use_id: 't3',
    } as never);
    expect(failed.deny).toMatch(/^The call was made, .*API key/);
  });

  test('output is passed on when it holds no credential, or the plugin did not allow the call', async ($, on) => {
    const w = world($, on, { output: 'version 1.2.3' });
    await auto($);
    const call = (id: string) =>
      $.tool.call({ tool: 'Bash', command: 'cat config.json', tool_use_id: id } as never);
    expect((await call('t1')).text).toBe('version 1.2.3');
    w.output = `TOKEN=${FAKE_TOKEN}`;
    w.core = { decision: 'allow' };
    expect((await call('t2')).text).toContain(FAKE_TOKEN);
  });

  test("output the model would read later, from a file, from a hook's own result, or beside it is checked or withheld", async ($, on) => {
    const w = world($, on, {
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
    w.record = { stdout: '', backgroundTaskId: 'b1' };
    expect((await call('cat d.log', 't4')).deny).toContain('background');
    w.output = undefined;
    w.record = { stdout: `TOKEN=${FAKE_TOKEN}` };
    expect((await call('cat e.log', 't5')).deny).toContain('API key');
    w.output = 'ok';
    w.record = undefined;
    w.context = [`TOKEN=${FAKE_TOKEN}`];
    expect((await call('cat f.log', 't6')).deny).toContain('API key');
  });

  test('a check that fails withholds the output instead of showing it', async ($, on) => {
    const w = world($, on, {
      record: {
        get backgroundTaskId(): string {
          throw new Error('unreadable record');
        },
      },
    });
    await auto($);
    const call = (id: string) =>
      $.tool.call({ tool: 'Bash', command: 'cat a.log', tool_use_id: id } as never);
    expect((await call('t1')).deny).toMatch(/^The call was made, .* checking it failed/);
    expect((await w.logged(2))[1]).toMatchObject({ event: 'withheld', why: 'checking it failed' });
    expect((await check($, 'Bash', bash('cat a.log'))).decision).toBe('ask');
  });
});
