import { randomUUID } from 'node:crypto';

/**
 * P3-BE09 request correlation header (request and response).
 *
 * Input contract: a client may send its own ID, which is kept only when it is
 * a single header value of 8-128 characters from `[A-Za-z0-9._:-]`, starting
 * with a letter or digit (UUIDs, ULIDs and most tracing IDs qualify).
 * Anything else (absent, repeated, too short or long, spaces, control or
 * non-ASCII characters) is replaced by a server-generated UUID v4.
 *
 * The ID correlates log lines and audit rows; it is never an authentication
 * or authorization input, and a client-chosen value is not trusted evidence.
 */
export const REQUEST_ID_HEADER = 'X-Request-ID';

export const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

/** The client-supplied value when it satisfies the input contract, else null. */
export function acceptRequestId(value: unknown): string | null {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value)
    ? value
    : null;
}

/** The authoritative request ID: the accepted client value or a new UUID v4. */
export function resolveRequestId(value: unknown): string {
  return acceptRequestId(value) ?? randomUUID();
}
