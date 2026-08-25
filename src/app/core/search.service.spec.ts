import { describe, expect, it } from 'vitest';

import { toMatchExpression } from './search.service';

/**
 * The query builder is what stands between whatever someone types and FTS5's
 * expression parser, so a stray syntax character must degrade to a plain
 * search rather than throwing.
 */
describe('toMatchExpression', () => {
  it('makes each word a quoted prefix term so results appear while typing', () => {
    expect(toMatchExpression('load shedding')).toBe('"load"* AND "shedding"*');
  });

  it('keeps a quoted run as a phrase', () => {
    expect(toMatchExpression('"load shedding"')).toBe('"load shedding"');
  });

  it('mixes a phrase with loose terms', () => {
    expect(toMatchExpression('"load shedding" eskom')).toBe('"load shedding" AND "eskom"*');
  });

  it('strips FTS5 syntax rather than letting it reach the parser', () => {
    // A bare "*" or an unbalanced quote would otherwise be a syntax error.
    expect(toMatchExpression('eskom*')).toBe('"eskom"*');
    expect(toMatchExpression('a"b')).toBe('"a"* AND "b"*');
    expect(toMatchExpression('foo:bar')).toBe('"foo"* AND "bar"*');
    expect(toMatchExpression('-tariff')).toBe('"tariff"*');
  });

  it('quotes terms that collide with FTS5 operators', () => {
    // Unquoted, these would be parsed as operators and throw.
    expect(toMatchExpression('NEAR(')).toBe('"NEAR"*');
    expect(toMatchExpression('and or not')).toBe('"and"* AND "or"* AND "not"*');
  });

  it('ignores queries too short to be useful', () => {
    expect(toMatchExpression('')).toBeNull();
    expect(toMatchExpression('a')).toBeNull();
    expect(toMatchExpression('   ')).toBeNull();
    expect(toMatchExpression('**')).toBeNull();
  });

  it('survives punctuation-only input', () => {
    expect(toMatchExpression('()[]{}')).toBeNull();
  });
});
