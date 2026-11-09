import type { JobExecutionOutcome } from './delivery-job.types';
import { CONFIGURATION_MIN_RETRY_MS, MIN_RETRY_MS, type PushWorkerConfig, QUOTA_MIN_RETRY_MS, RETRY_JITTER } from './push-worker.config';

export type RetryPolicy = Pick<PushWorkerConfig, 'maxAttempts' | 'retryBaseMs' | 'retryMaxMs'>;

/**
 * What the worker writes after one attempt. The delivery deadline is
 * applied atomically in SQL when persisting: a retry that would start at
 * or after `expires_at` becomes EXPIRED instead.
 */
export type JobTransition =
  | { to: 'DONE'; category: string | null; code: string | null }
  | { to: 'RETRY'; delayMs: number; category: string; code: string }
  | { to: 'FAILED'; category: string; code: string };

const SAFE_CODE = /^[A-Za-z0-9/._:-]{1,100}$/;
const SAFE_CATEGORY = /^[A-Z][A-Z_]{0,31}$/;

/** Executor-supplied codes are persisted and logged: only code tokens pass, anything else becomes pawflow/unknown-error. */
export const safeCode = (code: unknown): string => (typeof code === 'string' && SAFE_CODE.test(code) ? code : 'pawflow/unknown-error');
export const safeCategory = (category: unknown, fallback: string): string => (typeof category === 'string' && SAFE_CATEGORY.test(category) ? category : fallback);

/**
 * Exponential backoff: base * 2^(attempt-1), +/- 20 % jitter, capped at
 * retryMaxMs; then at least Retry-After (a larger Retry-After wins over the
 * cap), at least 60 s for quota and 5 min for configuration problems, and
 * never below 1 s.
 */
export function computeRetryDelayMs(
  attempt: number,
  category: 'TRANSIENT' | 'RATE_LIMITED' | 'CONFIGURATION',
  retryAfterMs: number | null | undefined,
  policy: RetryPolicy,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(policy.retryMaxMs, policy.retryBaseMs * 2 ** Math.max(0, Math.min(attempt - 1, 30)));
  const r = Math.min(1, Math.max(0, random()));
  let delay = Math.min(policy.retryMaxMs, Math.round(exponential * (1 - RETRY_JITTER + 2 * RETRY_JITTER * r)));
  if (typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0) delay = Math.max(delay, Math.round(retryAfterMs));
  if (category === 'RATE_LIMITED') delay = Math.max(delay, QUOTA_MIN_RETRY_MS);
  if (category === 'CONFIGURATION') delay = Math.max(delay, CONFIGURATION_MIN_RETRY_MS);
  return Math.max(delay, MIN_RETRY_MS);
}

/** Maps an executor outcome of attempt `attempt` to the job transition. */
export function decideTransition(outcome: JobExecutionOutcome, attempt: number, policy: RetryPolicy, random: () => number = Math.random): JobTransition {
  switch (outcome.kind) {
    case 'DELIVERED':
      return { to: 'DONE', category: null, code: null };
    case 'NO_DESTINATIONS':
      return { to: 'DONE', category: 'NO_DESTINATIONS', code: 'pawflow/no-destinations' };
    case 'TERMINAL':
      return { to: 'FAILED', category: safeCategory(outcome.category, 'TERMINAL'), code: safeCode(outcome.code) };
    case 'DISABLED':
      return { to: 'FAILED', category: 'PUSH_DISABLED', code: 'pawflow/push-disabled' };
    case 'RETRY':
    case 'CONFIGURATION': {
      const category = outcome.kind === 'CONFIGURATION' ? 'CONFIGURATION' : outcome.category === 'RATE_LIMITED' ? 'RATE_LIMITED' : 'TRANSIENT';
      const code = safeCode(outcome.code);
      if (attempt >= policy.maxAttempts) return { to: 'FAILED', category, code };
      const retryAfter = outcome.kind === 'RETRY' ? outcome.retryAfterMs : null;
      return { to: 'RETRY', delayMs: computeRetryDelayMs(attempt, category, retryAfter, policy, random), category, code };
    }
    default:
      // Unknown outcome shape from a buggy executor: retry conservatively.
      if (attempt >= policy.maxAttempts) return { to: 'FAILED', category: 'TRANSIENT', code: 'pawflow/invalid-executor-outcome' };
      return { to: 'RETRY', delayMs: computeRetryDelayMs(attempt, 'TRANSIENT', null, policy, random), category: 'TRANSIENT', code: 'pawflow/invalid-executor-outcome' };
  }
}
