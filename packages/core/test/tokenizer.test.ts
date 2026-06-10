import { describe, expect, it } from 'vitest';
import { isSingleExpression, tokenize } from '../src/expression/tokenizer';

describe('expression tokenizer', () => {
  it('plain string → single text token', () => {
    expect(tokenize('hello world')).toEqual([{ kind: 'text', text: 'hello world' }]);
  });

  it('empty string → no tokens', () => {
    expect(tokenize('')).toEqual([]);
  });

  it('splits text and expressions', () => {
    expect(tokenize('Hi {{ $json.name }}!')).toEqual([
      { kind: 'text', text: 'Hi ' },
      { kind: 'expr', code: '$json.name', raw: '{{ $json.name }}' },
      { kind: 'text', text: '!' },
    ]);
  });

  it('multiple expressions', () => {
    const tokens = tokenize('{{ $json.a }}-{{ $json.b }}');
    expect(tokens).toHaveLength(3);
    expect(tokens[0]).toMatchObject({ kind: 'expr', code: '$json.a' });
    expect(tokens[1]).toMatchObject({ kind: 'text', text: '-' });
    expect(tokens[2]).toMatchObject({ kind: 'expr', code: '$json.b' });
  });

  it('unclosed {{ stays literal text', () => {
    expect(tokenize('oops {{ $json.a')).toEqual([{ kind: 'text', text: 'oops {{ $json.a' }]);
  });

  it('isSingleExpression detects whole-template expression', () => {
    expect(isSingleExpression(tokenize('{{ $json.n }}'))).toBe(true);
    expect(isSingleExpression(tokenize('x {{ $json.n }}'))).toBe(false);
    expect(isSingleExpression(tokenize('plain'))).toBe(false);
  });

  it('handles fa/RTL text around expressions', () => {
    const tokens = tokenize('سلام {{ $json.name }} عزیز');
    expect(tokens).toEqual([
      { kind: 'text', text: 'سلام ' },
      { kind: 'expr', code: '$json.name', raw: '{{ $json.name }}' },
      { kind: 'text', text: ' عزیز' },
    ]);
  });
});
