import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { HttpException, HttpStatus, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  loadTurnstileConfig,
  TURNSTILE_TOKEN_MAX_LENGTH,
  type TurnstileAction,
  type TurnstileConfig,
} from './turnstile.config';

/** Injection token for the HTTP client (tests inject a stub; default: global fetch). */
export const TURNSTILE_FETCH = Symbol('TURNSTILE_FETCH');
export type TurnstileFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Public error codes (also in docs/phase3/bot-protection.md). Cloudflare's own
 * `error-codes` are logged, never returned.
 */
export type BotProtectionErrorCode =
  | 'TURNSTILE_REQUIRED'
  | 'TURNSTILE_INVALID'
  | 'TURNSTILE_EXPIRED'
  | 'TURNSTILE_UNAVAILABLE';

const MESSAGES: Record<BotProtectionErrorCode, string> = {
  TURNSTILE_REQUIRED: 'Bot verification is required',
  TURNSTILE_INVALID: 'Bot verification failed; please complete the challenge again',
  TURNSTILE_EXPIRED: 'Bot verification expired or was already used; please complete the challenge again',
  TURNSTILE_UNAVAILABLE: 'Bot verification is temporarily unavailable; please try again shortly',
};

/** Seconds a client should wait before retrying after a verification-service failure. */
export const TURNSTILE_UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

export class BotProtectionException extends HttpException {
  constructor(readonly code: BotProtectionErrorCode) {
    const unavailable = code === 'TURNSTILE_UNAVAILABLE';
    const status = unavailable ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.FORBIDDEN;
    super(
      {
        statusCode: status,
        error: unavailable ? 'Service Unavailable' : 'Forbidden',
        message: MESSAGES[code],
        code,
        ...(unavailable ? { retryAfterSeconds: TURNSTILE_UNAVAILABLE_RETRY_AFTER_SECONDS } : {}),
      },
      status,
    );
  }
}

export type TurnstileVerification =
  | { verified: false; skipped: true }
  | { verified: true; skipped: false; hostname: string; action: string | null; challengeTs: string | null };

interface SiteverifyResponse {
  success: boolean;
  errorCodes: string[];
  hostname: string | null;
  action: string | null;
  challengeTs: string | null;
  testingKey: boolean;
}

/** Retryable = the provider could not give a verdict (network, timeout, 5xx, garbage). */
class TransientSiteverifyError extends Error {}

const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 250;
// Any other `success: false` code (e.g. invalid-input-response) is TURNSTILE_INVALID.
const CHALLENGE_EXPIRED = new Set(['timeout-or-duplicate']);
const SERVER_MISCONFIGURED = new Set(['missing-input-secret', 'invalid-input-secret', 'bad-request']);

/**
 * P3-BE03 Cloudflare Turnstile server-side verification (Siteverify).
 *
 * Fail closed: in `enforce` mode a request proceeds only after Cloudflare
 * confirmed the token AND the hostname/action match this deployment. Every
 * failure, including provider outages, rejects the request. Successful
 * results are never cached: each protected request needs a fresh token
 * (Turnstile tokens are single-use, valid 300 s).
 */
@Injectable()
export class TurnstileService {
  private readonly logger = new Logger(TurnstileService.name);
  readonly config: TurnstileConfig;
  private readonly fetchImpl: TurnstileFetch;

  constructor(
    configService: ConfigService,
    @Optional() @Inject(TURNSTILE_FETCH) fetchImpl?: TurnstileFetch,
  ) {
    this.config = loadTurnstileConfig(configService);
    this.fetchImpl = fetchImpl ?? ((url, init) => fetch(url, init));

    if (this.config.mode === 'disabled') {
      this.logger.warn(
        this.config.reason === 'unset'
          ? 'TURNSTILE_MODE is not set: bot verification is DISABLED (allowed only when NODE_ENV is not production)'
          : 'TURNSTILE_MODE=disabled: bot verification is DISABLED (development only)',
      );
    } else {
      this.logger.log(
        `Turnstile enforcement ON (hostnames: ${[...this.config.expectedHostnames].join(', ')}; action check: ${this.config.checkAction ? 'on' : 'off'}; timeout ${this.config.timeoutMs} ms${this.config.siteverifyUrl.startsWith('https://challenges.cloudflare.com/') ? '' : '; NON-OFFICIAL Siteverify URL (test only)'})`,
      );
    }
  }

  get enforced(): boolean {
    return this.config.mode === 'enforce';
  }

  /**
   * Verifies `token` for `action`. Resolves only when the request may
   * proceed; otherwise throws BotProtectionException (403 / 503).
   */
  async verify(token: unknown, action: TurnstileAction, remoteIp?: string | null): Promise<TurnstileVerification> {
    if (this.config.mode === 'disabled') {
      return { verified: false, skipped: true };
    }

    const config = this.config;

    if (typeof token !== 'string' || token.trim() === '') {
      this.reject(action, 'TURNSTILE_REQUIRED', 'missing token');
    }
    if (token.length > TURNSTILE_TOKEN_MAX_LENGTH) {
      this.reject(action, 'TURNSTILE_INVALID', 'token too long');
    }

    // One idempotency key per logical verification: a retried request after a
    // transport failure is recognised by Cloudflare instead of being
    // reported as a duplicate (timeout-or-duplicate).
    const idempotencyKey = randomUUID();
    let result: SiteverifyResponse | undefined;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !result; attempt++) {
      try {
        result = await this.siteverify(config, token, idempotencyKey, remoteIp);
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'unknown error';
        if (!(error instanceof TransientSiteverifyError) || attempt === MAX_ATTEMPTS) {
          this.logger.error(`Turnstile Siteverify unavailable (${action}, attempt ${attempt}/${MAX_ATTEMPTS}): ${reason}`);
          throw new BotProtectionException('TURNSTILE_UNAVAILABLE');
        }
        this.logger.warn(`Turnstile Siteverify transient failure (${action}, attempt ${attempt}/${MAX_ATTEMPTS}): ${reason}; retrying`);
        await delay(RETRY_DELAY_MS);
      }
    }

    if (!result) {
      throw new BotProtectionException('TURNSTILE_UNAVAILABLE');
    }

    if (!result.success) {
      const codes = result.errorCodes;
      if (codes.some((c) => SERVER_MISCONFIGURED.has(c))) {
        this.logger.error(`Turnstile Siteverify rejected the server configuration (${action}): ${codes.join(',')}`);
        throw new BotProtectionException('TURNSTILE_UNAVAILABLE');
      }
      if (codes.some((c) => c === 'internal-error')) {
        this.logger.error(`Turnstile Siteverify internal error (${action})`);
        throw new BotProtectionException('TURNSTILE_UNAVAILABLE');
      }
      if (codes.some((c) => CHALLENGE_EXPIRED.has(c))) {
        this.reject(action, 'TURNSTILE_EXPIRED', codes.join(','));
      }
      this.reject(action, 'TURNSTILE_INVALID', codes.join(',') || 'success=false');
    }

    if (config.rejectTestingKeyResults && result.testingKey) {
      this.reject(action, 'TURNSTILE_INVALID', 'result produced by a Cloudflare testing key');
    }

    const hostname = result.hostname?.toLowerCase() ?? null;
    if (!hostname || !config.expectedHostnames.has(hostname)) {
      this.reject(action, 'TURNSTILE_INVALID', `hostname mismatch (got ${hostname ?? 'none'})`);
    }

    if (config.checkAction && result.action !== action) {
      this.reject(action, 'TURNSTILE_INVALID', `action mismatch (got ${result.action ?? 'none'})`);
    }

    return { verified: true, skipped: false, hostname, action: result.action, challengeTs: result.challengeTs };
  }

  private reject(action: TurnstileAction, code: BotProtectionErrorCode, reason: string): never {
    // Never the token, the secret or the client's credentials.
    this.logger.warn(`Turnstile rejected ${action}: ${code} (${reason})`);
    throw new BotProtectionException(code);
  }

  private async siteverify(
    config: Extract<TurnstileConfig, { mode: 'enforce' }>,
    token: string,
    idempotencyKey: string,
    remoteIp?: string | null,
  ): Promise<SiteverifyResponse> {
    let response: Response;
    try {
      response = await this.fetchImpl(config.siteverifyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          secret: config.secret,
          response: token,
          idempotency_key: idempotencyKey,
          ...(remoteIp ? { remoteip: remoteIp } : {}),
        }),
        // The verifier is a fixed host: never follow redirects elsewhere.
        redirect: 'error',
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (error) {
      // fetch rejects timeouts with a DOMException, which is not always `instanceof Error`.
      const name = typeof error === 'object' && error !== null && typeof (error as { name?: unknown }).name === 'string' ? (error as { name: string }).name : 'Error';
      throw new TransientSiteverifyError(name === 'TimeoutError' || name === 'AbortError' ? `timeout after ${config.timeoutMs} ms` : `network error (${name})`);
    }

    if (response.status >= 500 || response.status === 429) {
      throw new TransientSiteverifyError(`HTTP ${response.status}`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new TransientSiteverifyError(`non-JSON response (HTTP ${response.status})`);
    }

    if (!response.ok && (typeof body !== 'object' || body === null || !('success' in body))) {
      throw new Error(`unexpected HTTP ${response.status}`);
    }

    return parseSiteverify(body);
  }
}

function parseSiteverify(body: unknown): SiteverifyResponse {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new TransientSiteverifyError('malformed response (not an object)');
  }
  const b = body as Record<string, unknown>;
  if (typeof b.success !== 'boolean') {
    throw new TransientSiteverifyError('malformed response (success is not boolean)');
  }
  const rawCodes = b['error-codes'] ?? [];
  if (!Array.isArray(rawCodes) || !rawCodes.every((c) => typeof c === 'string')) {
    throw new TransientSiteverifyError('malformed response (error-codes)');
  }
  const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null);
  const metadata = typeof b.metadata === 'object' && b.metadata !== null ? (b.metadata as Record<string, unknown>) : {};

  return {
    success: b.success,
    errorCodes: (rawCodes as string[]).map((c) => c.slice(0, 64)),
    hostname: str(b.hostname),
    action: str(b.action),
    challengeTs: str(b.challenge_ts),
    testingKey: metadata.result_with_testing_key === true,
  };
}
