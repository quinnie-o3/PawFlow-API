import type { ConfigService } from '@nestjs/config';

/**
 * P3-BE03 Cloudflare Turnstile configuration, validated once at startup.
 * Any inconsistency throws, so the application refuses to start instead of
 * silently running without protection.
 */
export const TURNSTILE_SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** Cloudflare's published dummy secrets (always pass / always fail / token already spent). */
export const TURNSTILE_DUMMY_SECRETS = [
  '1x0000000000000000000000000000000AA',
  '2x0000000000000000000000000000000AA',
  '3x0000000000000000000000000000000AA',
] as const;

/** Turnstile tokens are at most 2048 characters. */
export const TURNSTILE_TOKEN_MAX_LENGTH = 2048;

/** One Turnstile `action` per protected operation (the widget must render with the same value). */
export const TURNSTILE_ACTIONS = {
  login: 'login',
  register: 'register',
  forgotPassword: 'forgot_password',
  resetPassword: 'reset_password',
} as const;

export type TurnstileAction = (typeof TURNSTILE_ACTIONS)[keyof typeof TURNSTILE_ACTIONS];

export const DEFAULT_TURNSTILE_TIMEOUT_MS = 3000;

export type TurnstileConfig =
  | { mode: 'disabled'; reason: 'explicit' | 'unset' }
  | {
      mode: 'enforce';
      secret: string;
      expectedHostnames: ReadonlySet<string>;
      checkAction: boolean;
      siteverifyUrl: string;
      timeoutMs: number;
      /** Reject responses produced by Cloudflare test keys (always in production). */
      rejectTestingKeyResults: boolean;
    };

function flag(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  const v = value.trim().toLowerCase();
  if (['true', '1', 'yes'].includes(v)) return true;
  if (['false', '0', 'no'].includes(v)) return false;
  throw new Error(`${name} must be true or false`);
}

export function loadTurnstileConfig(config: ConfigService): TurnstileConfig {
  const production = config.get<string>('NODE_ENV') === 'production';
  const rawMode = config.get<string>('TURNSTILE_MODE')?.trim().toLowerCase();

  if (rawMode === undefined || rawMode === '') {
    if (production) {
      throw new Error('TURNSTILE_MODE must be set to "enforce" when NODE_ENV=production');
    }
    return { mode: 'disabled', reason: 'unset' };
  }

  if (rawMode === 'disabled') {
    if (production) {
      throw new Error('TURNSTILE_MODE=disabled is not allowed when NODE_ENV=production');
    }
    return { mode: 'disabled', reason: 'explicit' };
  }

  if (rawMode !== 'enforce') {
    throw new Error('TURNSTILE_MODE must be "disabled" or "enforce"');
  }

  const secret = config.get<string>('TURNSTILE_SECRET_KEY')?.trim();
  if (!secret) {
    throw new Error('TURNSTILE_SECRET_KEY is required when TURNSTILE_MODE=enforce');
  }
  if (production && (TURNSTILE_DUMMY_SECRETS as readonly string[]).includes(secret)) {
    throw new Error('TURNSTILE_SECRET_KEY is a Cloudflare test secret, which is not allowed when NODE_ENV=production');
  }

  const expectedHostnames = new Set(
    (config.get<string>('TURNSTILE_EXPECTED_HOSTNAMES') ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
  if (expectedHostnames.size === 0) {
    throw new Error('TURNSTILE_EXPECTED_HOSTNAMES (comma-separated frontend hostnames) is required when TURNSTILE_MODE=enforce');
  }
  for (const host of expectedHostnames) {
    if (!/^[a-z0-9.-]+$/.test(host)) {
      throw new Error('TURNSTILE_EXPECTED_HOSTNAMES must contain bare hostnames (no scheme, port or path)');
    }
  }

  const checkAction = flag(config.get<string>('TURNSTILE_CHECK_ACTION'), true, 'TURNSTILE_CHECK_ACTION');
  if (production && !checkAction) {
    throw new Error('TURNSTILE_CHECK_ACTION=false is not allowed when NODE_ENV=production');
  }

  const urlOverride = config.get<string>('TURNSTILE_SITEVERIFY_URL')?.trim();
  if (urlOverride && production) {
    throw new Error('TURNSTILE_SITEVERIFY_URL cannot be overridden when NODE_ENV=production');
  }
  if (urlOverride && !/^https?:\/\/[^/\s]+\/\S*$/.test(urlOverride)) {
    throw new Error('TURNSTILE_SITEVERIFY_URL must be an absolute http(s) URL');
  }

  const timeoutMs = Number(config.get<string>('TURNSTILE_TIMEOUT_MS') ?? DEFAULT_TURNSTILE_TIMEOUT_MS);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 10_000) {
    throw new Error('TURNSTILE_TIMEOUT_MS must be an integer between 500 and 10000');
  }

  return {
    mode: 'enforce',
    secret,
    expectedHostnames,
    checkAction,
    siteverifyUrl: urlOverride || TURNSTILE_SITEVERIFY_URL,
    timeoutMs,
    rejectTestingKeyResults: production,
  };
}
