import { describe, expect, test } from 'claude-code/testing';
import { findSecret } from '../hooks/secrets.ts';

// Values are built at run time, so no scanner takes the source for a leak.
const RANDOM = 'q7Rk2Vx9Lm4Np8Ts3Wz6Yb1Hc5';

describe('findSecret', () => {
  const found: Array<[string, string]> = [
    ['private key', `-----BEGIN OPENSSH ${'PRIVATE KEY'}-----`],
    ['API key', `key: ghp_${'x'.repeat(36)}`],
    ['API key', `sk-ant-api03-${RANDOM}`],
    ['API key', `AKIA${'ABCDEFGH23456789'}`],
    ['JSON web token', `eyJ${RANDOM}.eyJ${RANDOM}.${RANDOM}`],
    ['URL credential', `proxy=http://user:${RANDOM.slice(0, 10)}@10.0.0.1:3128`],
    ['auth header', `Authorization: Basic ${RANDOM}`],
    ['bearer token', `curl -H "x: Bearer ya29.${RANDOM}"`],
    ['secret assignment', `DB_PASSWORD="${RANDOM}"`],
    ['private key', `-----BEGIN PGP ${'PRIVATE KEY'} BLOCK-----`],
    ['API key', `AIza${RANDOM}${'x'.repeat(9)}`],
    ['API key', `hf_${'abcdefghij'.repeat(4)}`],
    ['secret assignment', `aws_secret_access_key = ${RANDOM}`],
    ['secret assignment', `SERVICE_KEY=${RANDOM}`],
    ['secret assignment', `"token": "${RANDOM}.${RANDOM}"`],
    ['secret assignment', `the token is token=${RANDOM}.`],
    ['netrc password', `machine example.com login u password ${'hunter'}`],
    ['API key', `npm_${'aB3'.repeat(12)}`],
    ['API key', `glrt-${RANDOM}`],
    ['API key', `SG.${RANDOM.slice(0, 22)}.${RANDOM}${RANDOM.slice(0, 17)}`],
    ['private key', `PuTTY-User-Key-File-3: ssh-ed25519`],
    ['private key', `AGE-SECRET-KEY-1${RANDOM.toUpperCase()}`],
    ['webhook URL', `https://hooks.slack.com/services/T0/B0/${RANDOM}`],
    ['secret assignment', `SERVICE_KEY: ${RANDOM}`],
    ['secret assignment', `DefaultEndpointsProtocol=https;AccountKey=${RANDOM}==;`],
    ['netrc password', `default\n  login u\n  password ${'hunter'}`],
    ['netrc password', `machine example.com\n  password ${'hunter'} login u`],
    ['registry credential', `{"auths": {"r.example.com": {"auth": "${'dTpw'.repeat(5)}"}}}`],
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
  ];
  for (const [name, run] of [
    ['word characters and hyphens', 'a-'.repeat(500_000)],
    ['blank lines', '\n'.repeat(100_000)],
    ['indented blank lines', '  \n'.repeat(50_000)],
  ] as const) {
    test(`a long run of ${name} scans in linear time`, () => {
      const start = performance.now();
      findSecret(run);
      expect(performance.now() - start).toBeLessThan(2000);
    });
  }

  for (const text of clean) {
    test(`no secret: ${text}`, () => {
      expect(findSecret(text)).toBeUndefined();
    });
  }
});
