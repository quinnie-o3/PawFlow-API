import {
  buildPaginationMeta,
  toContainsPattern,
  tokenizeSearchKeyword,
  toPageOffset,
  toTrimmedOptionalString,
} from './public-search.util';

describe('tokenizeSearchKeyword', () => {
  it('returns no terms for an absent or blank keyword', () => {
    expect(tokenizeSearchKeyword(undefined)).toEqual([]);
    expect(tokenizeSearchKeyword('   ')).toEqual([]);
  });

  it('splits on any whitespace run and trims the ends', () => {
    expect(tokenizeSearchKeyword('  paw \t spa\n groom ')).toEqual([
      'paw',
      'spa',
      'groom',
    ]);
  });

  it('removes case-insensitive duplicates, keeping the first spelling', () => {
    expect(tokenizeSearchKeyword('Spa spa SPA paw')).toEqual(['Spa', 'paw']);
  });

  it('keeps Vietnamese terms intact', () => {
    expect(tokenizeSearchKeyword('cắt tỉa lông')).toEqual([
      'cắt',
      'tỉa',
      'lông',
    ]);
  });
});

describe('toContainsPattern', () => {
  it('wraps a plain term in % wildcards', () => {
    expect(toContainsPattern('groom')).toBe('%groom%');
  });

  it('escapes LIKE wildcards so they match literally', () => {
    expect(toContainsPattern('50%')).toBe(String.raw`%50\%%`);
    expect(toContainsPattern('x_y')).toBe(String.raw`%x\_y%`);
  });

  it('escapes the escape character itself', () => {
    expect(toContainsPattern(String.raw`a\b`)).toBe(String.raw`%a\\b%`);
  });

  it('leaves SQL metacharacters untouched (values are always bound)', () => {
    expect(toContainsPattern("'; DROP TABLE services; --")).toBe(
      "%'; DROP TABLE services; --%",
    );
  });
});

describe('toPageOffset', () => {
  it('converts a 1-based page to a row offset', () => {
    expect(toPageOffset(1, 20)).toBe(0);
    expect(toPageOffset(3, 20)).toBe(40);
  });
});

describe('buildPaginationMeta', () => {
  it('describes an empty result', () => {
    expect(buildPaginationMeta(1, 20, 0)).toEqual({
      page: 1,
      limit: 20,
      totalItems: 0,
      totalPages: 0,
      hasNextPage: false,
      hasPreviousPage: false,
    });
  });

  it('rounds the page count up and flags neighbours', () => {
    expect(buildPaginationMeta(2, 10, 21)).toEqual({
      page: 2,
      limit: 10,
      totalItems: 21,
      totalPages: 3,
      hasNextPage: true,
      hasPreviousPage: true,
    });
  });

  it('has no next page on an exact last page', () => {
    expect(buildPaginationMeta(2, 10, 20)).toMatchObject({
      totalPages: 2,
      hasNextPage: false,
    });
  });

  it('keeps accurate totals for a page past the end', () => {
    expect(buildPaginationMeta(9, 10, 20)).toMatchObject({
      page: 9,
      totalItems: 20,
      totalPages: 2,
      hasNextPage: false,
      hasPreviousPage: true,
    });
  });
});

describe('toTrimmedOptionalString', () => {
  it('trims strings and treats blank ones as absent', () => {
    expect(toTrimmedOptionalString('  spa ')).toBe('spa');
    expect(toTrimmedOptionalString('   ')).toBeUndefined();
    expect(toTrimmedOptionalString('')).toBeUndefined();
  });

  it('returns non-strings unchanged for the validators to reject', () => {
    expect(toTrimmedOptionalString(['a', 'b'])).toEqual(['a', 'b']);
    expect(toTrimmedOptionalString(5)).toBe(5);
  });
});
