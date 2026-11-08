import { createHmac } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';

import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

import {
  type AuthRateLimitConfig,
  loadAuthRateLimitConfig,
  type RateLimitedRoute,
  type RateLimitPolicy,
} from './auth-rate-limit.config';

export class RateLimitedException extends HttpException {
  constructor(retryAfterSeconds: number) {
    super(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        error: 'Too Many Requests',
        message: 'Too many requests; please try again later',
        code: 'RATE_LIMITED',
        retryAfterSeconds,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

export class RateLimitUnavailableException extends HttpException {
  constructor() {
    super(
      {
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        error: 'Service Unavailable',
        message: 'Service temporarily unavailable; please try again shortly',
        code: 'RATE_LIMIT_UNAVAILABLE',
        retryAfterSeconds: 5,
      },
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}

/** IPv4-mapped IPv6 -> IPv4; IPv6 -> its /64 network (one client usually owns a /64). */
export function normalizeClientIp(ip: string | null | undefined): string {
  if (!ip) return 'unknown';
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped && isIPv4(mapped[1])) return mapped[1];
  if (isIPv4(ip)) return ip;
  if (isIPv6(ip)) {
    const [head, tail = ''] = ip.toLowerCase().split('::');
    const left = head ? head.split(':') : [];
    const right = tail ? tail.split(':') : [];
    const full = ip.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
    return `${full.slice(0, 4).map((h) => h.padStart(4, '0')).join(':')}::/64`;
  }
  return 'unknown';
}

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
  /** Per policy: hits in the current window after this request. */
  hits: Record<string, number>;
}

const CLEANUP_INTERVAL_MS = 5 * 60_000;

/**
 * P3-BE03 fixed-window rate limiting for public authentication endpoints.
 *
 * Counters live in PostgreSQL (`auth_rate_limits`) because it is the only
 * store shared by all backend instances; each request is one atomic
 * multi-row upsert, so concurrent requests on any instance are counted
 * exactly. The window is computed from the database clock. Nothing is kept
 * in process memory. Fail closed: if the counter cannot be written the
 * request is refused (503) rather than let through unmetered.
 */
@Injectable()
export class AuthRateLimitService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuthRateLimitService.name);
  readonly config: AuthRateLimitConfig;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(
    configService: ConfigService,
    private readonly dataSource: DataSource,
  ) {
    this.config = loadAuthRateLimitConfig(configService);

    if (this.config.mode === 'disabled') {
      this.logger.warn('AUTH_RATE_LIMIT=disabled: authentication endpoints are NOT rate limited (development/test only)');
    } else {
      const summary = Object.values(this.config.policies)
        .flat()
        .map((p) => `${p.name}=${p.limit}/${p.windowSeconds}s`)
        .join(', ');
      this.logger.log(`Auth rate limiting ON (${summary})`);
    }
  }

  onModuleInit(): void {
    if (this.config.mode === 'enabled') {
      this.cleanupTimer = setInterval(() => void this.purgeExpired(), CLEANUP_INTERVAL_MS);
      this.cleanupTimer.unref();
    }
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }

  /** Counts this request against every policy of the route. Throws 429 / 503. */
  async consume(route: RateLimitedRoute, client: { ip?: string | null; email?: unknown }): Promise<RateLimitDecision> {
    if (this.config.mode === 'disabled') {
      return { allowed: true, retryAfterSeconds: 0, hits: {} };
    }

    const { hashSecret } = this.config;
    const email = typeof client.email === 'string' ? client.email.trim().toLowerCase() : '';
    const rows: { policy: RateLimitPolicy; bucket: string }[] = [];

    for (const policy of this.config.policies[route]) {
      const value = policy.key === 'ip' ? normalizeClientIp(client.ip) : email;
      // A malformed body has no e-mail key; validation rejects it right after.
      if (policy.key === 'email' && (!value || value.length > 320)) continue;
      rows.push({ policy, bucket: createHmac('sha256', hashSecret).update(`${policy.name}\0${value}`).digest('hex') });
    }

    if (rows.length === 0) {
      return { allowed: true, retryAfterSeconds: 0, hits: {} };
    }

    const params: unknown[] = [];
    const values = rows.map(({ policy, bucket }, i) => {
      params.push(policy.name, bucket, policy.windowSeconds);
      const p = i * 3;
      return `($${p + 1}, $${p + 2}, to_timestamp(floor(extract(epoch from now()) / $${p + 3}) * $${p + 3}), 1, to_timestamp(floor(extract(epoch from now()) / $${p + 3}) * $${p + 3} + $${p + 3}))`;
    });

    let result: { policy: string; hits: number; retry_after: string }[];
    try {
      result = await this.dataSource.query(
        `INSERT INTO auth_rate_limits (policy, bucket, window_start, hits, expires_at)
         VALUES ${values.join(', ')}
         ON CONFLICT (policy, bucket, window_start) DO UPDATE SET hits = auth_rate_limits.hits + 1
         RETURNING policy, hits, ceil(extract(epoch from expires_at - now()))::int AS retry_after`,
        params,
      );
    } catch (error) {
      const reason = error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
      this.logger.error(`Rate-limit store unavailable (${route}): ${reason}`);
      throw new RateLimitUnavailableException();
    }

    const hits: Record<string, number> = {};
    let retryAfterSeconds = 0;
    let allowed = true;

    for (const row of result) {
      const policy = rows.find((r) => r.policy.name === row.policy)!.policy;
      hits[row.policy] = Number(row.hits);
      if (Number(row.hits) > policy.limit) {
        allowed = false;
        retryAfterSeconds = Math.max(retryAfterSeconds, Math.max(1, Number(row.retry_after)));
      }
    }

    if (!allowed) {
      const exceeded = Object.entries(hits)
        .filter(([name, n]) => n > rows.find((r) => r.policy.name === name)!.policy.limit)
        .map(([name]) => name)
        .join(',');
      // Policy names only: no IP, e-mail or bucket value.
      this.logger.warn(`Rate limit exceeded (${route}: ${exceeded}); retry after ${retryAfterSeconds}s`);
      throw new RateLimitedException(retryAfterSeconds);
    }

    return { allowed, retryAfterSeconds, hits };
  }

  /** Deletes windows that ended more than a minute ago. */
  async purgeExpired(): Promise<number> {
    try {
      const [, affected] = (await this.dataSource.query(
        `DELETE FROM auth_rate_limits WHERE expires_at < now() - interval '1 minute'`,
      )) as [unknown, number];
      return affected ?? 0;
    } catch (error) {
      this.logger.warn(`Rate-limit cleanup failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      return 0;
    }
  }
}
