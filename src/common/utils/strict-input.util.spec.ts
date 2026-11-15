import {
  toBigIntIdStringIfSafeInteger,
  toNumberIfNumericString,
} from './strict-input.util';

describe('toNumberIfNumericString', () => {
  it.each([
    ['5', 5],
    ['0', 0],
    ['-3', -3],
    ['12.50', 12.5],
  ])('converts canonical decimal string %p', (input, expected) => {
    expect(toNumberIfNumericString(input)).toBe(expected);
  });

  it('keeps JSON numbers unchanged', () => {
    expect(toNumberIfNumericString(7.25)).toBe(7.25);
  });

  it.each([
    ['empty string', ''],
    ['whitespace', '   '],
    ['padded number', ' 5'],
    ['exponent', '1e3'],
    ['hex', '0x10'],
    ['trailing dot', '5.'],
    ['word', 'abc'],
    ['boolean true', true],
    ['boolean false', false],
    ['null', null],
    ['array', [5]],
    ['object', { value: 5 }],
  ])('leaves %s unchanged for the validator to reject', (_label, input) => {
    expect(toNumberIfNumericString(input)).toBe(input);
  });
});

describe('toBigIntIdStringIfSafeInteger', () => {
  it('normalizes a positive safe integer to a string', () => {
    expect(toBigIntIdStringIfSafeInteger(5)).toBe('5');
    expect(toBigIntIdStringIfSafeInteger(Number.MAX_SAFE_INTEGER)).toBe(
      '9007199254740991',
    );
  });

  it('keeps string ids unchanged', () => {
    expect(toBigIntIdStringIfSafeInteger('9223372036854775807')).toBe(
      '9223372036854775807',
    );
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fraction', 1.5],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
    ['NaN', Number.NaN],
    ['boolean', true],
    ['array', [1]],
  ])('leaves %s unchanged for the validator to reject', (_label, input) => {
    expect(toBigIntIdStringIfSafeInteger(input)).toBe(input);
  });
});
