/**
 * Shared helpers for the public, paginated discovery endpoints
 * (`GET /services/public/search`, `GET /providers/public/search`).
 */

export const SEARCH_KEYWORD_MAX_LENGTH = 100;
export const SEARCH_KEYWORD_MAX_TERMS = 8;
export const SEARCH_LOCATION_MAX_LENGTH = 100;

export const SEARCH_DEFAULT_LIMIT = 20;
export const SEARCH_MAX_LIMIT = 50;
export const SEARCH_MAX_PAGE = 1000;

/**
 * Splits a keyword into distinct whitespace-separated terms. Every term must
 * match (AND), each one against any of the searchable fields (OR), so
 * "groom paw" finds "Paw Spa — Full grooming" regardless of word order.
 *
 * Terms are de-duplicated case-insensitively; an absent or blank keyword
 * yields no terms (no keyword filter).
 */
export function tokenizeSearchKeyword(keyword: string | undefined): string[] {
  if (keyword === undefined) {
    return [];
  }

  const seen = new Set<string>();
  const terms: string[] = [];

  for (const term of keyword.trim().split(/\s+/)) {
    const key = term.toLowerCase();

    if (term !== '' && !seen.has(key)) {
      seen.add(key);
      terms.push(term);
    }
  }

  return terms;
}

/**
 * Builds a "contains" pattern for ILIKE. `%`, `_` and `\` in user input are
 * escaped so they match literally (PostgreSQL's default LIKE escape
 * character is backslash). The pattern is always bound as a query
 * parameter, never interpolated into SQL.
 */
export function toContainsPattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

export interface PaginationMeta {
  page: number;
  limit: number;
  totalItems: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export interface PaginatedResult<TItem, TQuery> {
  items: TItem[];
  meta: PaginationMeta;
  query: TQuery;
}

export function toPageOffset(page: number, limit: number): number {
  return (page - 1) * limit;
}

/**
 * A page past the end is not an error: it returns no items with accurate
 * totals, so a client holding a stale URL can recover.
 */
export function buildPaginationMeta(
  page: number,
  limit: number,
  totalItems: number,
): PaginationMeta {
  const totalPages = Math.ceil(totalItems / limit);

  return {
    page,
    limit,
    totalItems,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
  };
}

/** Trims a string query value; a blank value is treated as absent. */
export function toTrimmedOptionalString(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();

  return trimmed === '' ? undefined : trimmed;
}
