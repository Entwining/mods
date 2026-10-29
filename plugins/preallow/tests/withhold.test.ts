import { describe, expect, test } from 'claude-code/testing';
import { rules } from '../hooks/gitleaks.generated.ts';
import { findSecrets, redact } from '../hooks/withhold.ts';

// Values are built at run time, so no scanner takes the source for a leak.
const RANDOM = 'q7Rk2Vx9Lm4Np8Ts3Wz6Yb1Hc5';
const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const BECH32 = 'QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L';
const DIGITS = '1234567890';
const HEX = '0123456789abcdef';
// A value spread evenly over its alphabet, so it passes the entropy check of
// gitleaks' rules as a generated token does.
const mixed = (n: number, alphabet = B62) =>
  Array.from({ length: n }, (_, i) => alphabet[(i * 7) % alphabet.length]).join('');

describe('findSecrets', () => {
  const found: Array<[string, string]> = [
    ['private key', `-----BEGIN OPENSSH ${'PRIVATE KEY'}-----\n${mixed(70)}\n`],
    ['API key', `sk-ant-api03-${RANDOM}`],
    ['JSON web token', `eyJ${RANDOM}.eyJ${RANDOM}.${RANDOM}`],
    ['URL credential', `proxy=http://user:${RANDOM.slice(0, 10)}@10.0.0.1:3128`],
    ['auth header', `Authorization: Basic ${RANDOM}`],
    ['auth header', `x-api-key: ${RANDOM}.${RANDOM}`],
    ['bearer token', `curl -H "x: Bearer ya29.${RANDOM}"`],
    ['secret assignment', `DB_PASSWORD="${RANDOM}"`],
    ['secret assignment', `const apiKey =\n  "${RANDOM}`],
    ['private key', `-----BEGIN PGP ${'PRIVATE KEY'} BLOCK-----\nVersion: v1\n\n${mixed(64)}`],
    ['private key', `-----BEGIN SM2 ${'PRIVATE KEY'}-----\n${mixed(64)}`],
    ['private key', `-----BEGIN ${'PRIVATE KEY'}-----\n${`${mixed(8)}\n`.repeat(8)}`],
    ['private key', `-----BEGIN ${'PRIVATE KEY'}-----\r${mixed(32)}\r${mixed(32)}\r`],
    ['private key', `-----BEGIN ${'PRIVATE KEY'}-----\r\n${mixed(32)} \r\n${mixed(32)} \r\n`],
    ['private key', `{"key": "-----BEGIN ${'PRIVATE KEY'}-----\\n${mixed(32)}\\n${mixed(32)}\\n"}`],
    ['private key', `{"key": "-----BEGIN ${'PRIVATE KEY'}-----\\r${mixed(64)}\\r"}`],
    ['secret assignment', `aws_secret_access_key = ${RANDOM}`],
    ['secret assignment', `SERVICE_KEY=${RANDOM}`],
    ['secret assignment', `"token": "${RANDOM}.${RANDOM}"`],
    ['secret assignment', `the token is token=${RANDOM}.`],
    ['netrc password', `machine example.com login u password ${'hunter'}`],
    ['private key', `Private-Lines: 1\n${mixed(48)}\nPrivate-MAC: 0`],
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
    ['slack-bot-token', `xoxb-${DIGITS}-${DIGITS}${mixed(24)}`],
    ['slack-webhook-url', `https://hooks.slack.com/triggers/${mixed(44)}`],
    [
      'aws-amazon-bedrock-api-key-short-lived',
      `${'bedrock-api-key-'}YmVkcm9jay5hbWF6b25hd3MuY29t${mixed(40)}`,
    ],
    ['stripe-access-token', `sk_live_${mixed(24)}`],
    ['curl-auth-user', `curl -u admin:${mixed(12)} https://example.com`],
    ['kubernetes-secret-yaml', `kind: Secret\ndata:\n  cert: ${mixed(24)}`],
    ['npm-access-token', `The token is npm_${mixed(36)}.`],
    ['atlassian-api-token', `ATATT3${mixed(186)}`],
    ['sourcegraph-access-token', `sgp_${mixed(16, HEX)}_${mixed(40, HEX)}`],
    // A legacy Sourcegraph token has no prefix; only its name tells it from a
    // commit hash.
    ['secret assignment', `SRC_ACCESS_TOKEN=${mixed(40, HEX)}`],
  ];
  for (const [kind, text] of found) {
    test(`${kind}: ${text}`, () => {
      expect(findSecrets(text)[0]?.kind).toBe(kind);
    });
  }

  const clean = [
    'const token = req.headers.authorization',
    'const apiToken = credentialsStore2024.current',
    'const apiKey = process.env.OPENAI_API_KEY_VALUE',
    'ANTHROPIC_API_KEY = "replace-with-your-key"',
    'Authorization: Bearer ${token}',
    'DATABASE_URL=postgres://postgres:postgres@localhost/db',
    'password: string',
    'token_count = 1234567890123456789',
    'const cacheKey = "user123abc456def789"',
    'The default timeout applies; see the password reset guide.',
    `sessionId=${['3f2a9c4e', '7b1d', '4e8a', '9c2f', '5d6e7a8b9c0d'].join('-')}`,
    'session_timeout=3600',
    // Empty assignments, each followed by a name of letters and digits.
    'API_TOKEN=\nAWS_S3_REGION_2=\nSERVICE_KEY=\nS3_BUCKET_NAME_2024=\nAUTHORIZATION=\nS3_ACCESS_KEY_ID2=\n',
    `considered=${RANDOM}`,
    'const PASSWORD_MISSING = "password_missing";',
    // A hostname's dots match only dots.
    `see hooks.slack.com: https://hooksXslackYcom/triggers/${mixed(44)}`,
    // A format named without a key's body.
    `-----BEGIN OPENSSH ${'PRIVATE KEY'}----- files are read by ssh-add`,
    `-----BEGIN OPENSSH ${'PRIVATE KEY'}-----\nPaste the base64 body of your key here, keeping its line breaks.\n-----END OPENSSH ${'PRIVATE KEY'}-----`,
    `PuTTY-User-Key-File-3: ssh-ed25519\nPrivate-Lines: 1`,
    `${'AGE-SECRET-KEY'}-1${'[QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L]{58}'}`,
    `${'bedrock-api-key-'}YmVkcm9jay5hbWF6b25hd3MuY29t`,
    // Too uniform for gitleaks' rule, whose entropy is taken from the value
    // alone; a known example key; a stopword, also in a rule's secret group;
    // and a Secret in the document after the data.
    `ghp_${'x'.repeat(36)}`,
    'curl -u aaa:aaaaaaaaaa https://example.com',
    `AKIA${'IOSFODNN7'}EXAMPLE`,
    `hf_${'ABCDEFGHIJKLMNOPQRSTUVWXYZ'}abcdefgh`,
    `sonar.login=${'abcdefghijklmnopqrstuvwxyz'}0123456789abcd`,
    `data:\n  color: ${'Ymx1ZQ'.repeat(3)}\n---\napiVersion: v1\nkind: Secret\ntype: Opaque`,
    `Sourcegraph search, commit ${mixed(40, HEX)}`,
  ];
  for (const [name, run] of [
    ['word characters and hyphens', 'a-'.repeat(500_000)],
    ['blank lines', '\n'.repeat(100_000)],
    ['indented blank lines', '  \n'.repeat(50_000)],
    ['netrc machine lines', 'machine a\n'.repeat(100_000)],
    ['secret names', 'A_KEY='.repeat(100_000)],
    ['cookie names', 'sess'.repeat(250_000)],
    ['key armor', `-----BEGIN ${'PRIVATE KEY'}-----\n${'A\n'.repeat(39)}`.repeat(9_500)],
    [
      'key armor cut off before its end',
      `-----BEGIN ${'PRIVATE KEY'}-----\n${'A'.repeat(40)}\n`.repeat(15_000),
    ],
    ['PuTTY private lines', `Private-Lines: 1\n${'A'.repeat(39)}\n`.repeat(17_000)],
  ] as const) {
    test(`a long run of ${name} scans in linear time`, () => {
      const start = performance.now();
      findSecrets(run);
      expect(performance.now() - start).toBeLessThan(2000);
    });
  }

  test("an output holding every gitleaks rule's keyword before long runs, and no secret, scans within the hook's budget", () => {
    const keywords = [...new Set(rules.flatMap((rule) => rule.keywords))];
    for (const run of ['.', 'a.', ' ']) {
      const unit = keywords.map((k) => `${k}${run.repeat(400)}`).join(' ');
      const start = performance.now();
      expect(findSecrets(unit.repeat(Math.ceil(1_000_000 / unit.length)))).toEqual([]);
      expect(performance.now() - start).toBeLessThan(2000);
    }
  });

  for (const text of clean) {
    test(`nothing found: ${text}`, () => {
      expect(findSecrets(text)).toEqual([]);
    });
  }
});

describe('redact', () => {
  const redacted = (text: string) => redact(text, findSecrets(text));

  test('each value gives way to a marker, keeping its line breaks and what surrounds it', () => {
    const body = Array.from({ length: 3 }, (_, i) => mixed(64 - i));
    const pem = `-----BEGIN ${'PRIVATE KEY'}-----\n${body.join('\n')}\n-----END ${'PRIVATE KEY'}-----`;
    expect(redacted(`a\n${pem}\nTOKEN=${RANDOM} b`)).toBe(
      `a\n[redacted by preallow: private key]${'\n'.repeat(5)}TOKEN=[redacted by preallow: secret assignment] b`,
    );
    const escaped = JSON.stringify({ key: pem });
    expect(redacted(escaped)).toBe('{"key":"[redacted by preallow: private key]"}');
  });

  test('a key without its end marker runs through its last line of base64, and no further', () => {
    const body = `${mixed(64)}\n${mixed(20)}`;
    expect(redacted(`-----BEGIN ${'PRIVATE KEY'}-----\n${body}\nOutput truncated.`)).toBe(
      '[redacted by preallow: private key]\n\n\nOutput truncated.',
    );
    const putty = `Private-Lines: 2\n${body}\nPrivate-MAC: ${mixed(64, HEX)}`;
    expect(redacted(putty)).toBe(
      `[redacted by preallow: private key]\n\n\nPrivate-MAC: ${mixed(64, HEX)}`,
    );
    expect(redacted(`${'AGE-SECRET-KEY'}-1${mixed(58, BECH32)}\nREADME\nDone`)).toBe(
      '[redacted by preallow: private key]\nREADME\nDone',
    );
  });

  test('a gitleaks rule whose groups hold parts of its token has the whole token redacted', () => {
    const uuid = `${mixed(8, HEX)}-${'a1b2-'.repeat(3)}${mixed(12, HEX)}`;
    const webhook = `https://example.webhook.office.com/webhookb2/${uuid}@${uuid}/IncomingWebhook/${mixed(32, HEX)}/${uuid}`;
    expect(redacted(`url: ${webhook}`)).toBe(
      'url: [redacted by preallow: microsoft-teams-webhook]',
    );
    expect(redacted(`${'ZXlKaGJHY2lPaU'}${mixed(48)} b`)).toBe(
      '[redacted by preallow: jwt-base64] b',
    );
  });

  test("a gitleaks rule's match keeps the name before its secret", () => {
    expect(redacted(`OKTA = 00${mixed(40)}`)).toBe(
      'OKTA = [redacted by preallow: okta-access-token]',
    );
  });

  test('values that overlap give way to one marker', () => {
    // One shape takes the value up to the dot, another the whole quoted value.
    expect(redacted(`"token": "${RANDOM}==.${RANDOM}"`)).toBe(
      '"token": "[redacted by preallow: secret assignment]"',
    );
  });
});
