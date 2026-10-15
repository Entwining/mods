import { describe, expect, test } from 'claude-code/testing';

import { parseVerdict } from '../hooks/verdict.ts';

describe('parseVerdict', () => {
  test('only a reply ending with a JSON object answering allow allows', () => {
    expect(parseVerdict('{"reason":"r","verdict":"allow"}')).toEqual({
      verdict: 'allow',
      reason: 'r',
    });
    for (const reply of [
      '```json\n{"reason":"r","verdict":"allow"}\n```',
      'Verdict: {"verdict":"allow"}',
      '{"reason":"uses {x} and }","verdict":"allow"}',
    ])
      expect(parseVerdict(reply).verdict).toBe('allow');
    for (const reply of [
      '',
      'allow',
      '{"verdict":"allow"} and more',
      '{"verdict":"allow"}\n```\nand more',
      '{"verdict":"allow"}\n{"verdict":"review"}',
      '{"verdict":"ALLOW"}',
      '{"verdict":"review"}',
      '{"verdict":["allow"]}',
    ])
      expect(parseVerdict(reply).verdict).toBe('pass');
  });

  test('a reply that states different verdicts passes, whichever comes last', () => {
    for (const reply of [
      'First {"verdict":"review"}, then on reflection {"reason":"r","verdict":"allow"}',
      '```json\n{"verdict":"check","check":[{"path":"/w/a"}]}\n```\n{"verdict": "allow"}',
    ])
      expect(parseVerdict(reply).verdict).toBe('pass');
    expect(
      parseVerdict('Draft {"verdict":"allow"}, final {"reason":"r","verdict":"allow"}').verdict,
    ).toBe('allow');
  });

  test('a check must name between one and four paths or refs', () => {
    expect(
      parseVerdict(
        '{"reason":"r","verdict":"check","check":[{"path":"/w/a"},{"repo":"/w","ref":"origin/x"}]}',
      ),
    ).toEqual({
      verdict: 'check',
      reason: 'r',
      check: [{ path: '/w/a' }, { repo: '/w', ref: 'origin/x' }],
    });
    const path = { path: '/w/a' };
    for (const check of [
      undefined,
      [],
      [path, path, path, path, path],
      [{ path: '' }],
      [{ ref: 'main' }],
      [{ path: '/w/a', ref: 'main' }],
      [{ path: '/w/a', repo: '/w' }],
      [{ path: '/w/a', repo: '/w', ref: 'main' }],
      [{ repo: '/w', ref: '--all' }],
      ['/w/a'],
    ])
      expect(parseVerdict(JSON.stringify({ verdict: 'check', check })).verdict).toBe('pass');
  });
});
