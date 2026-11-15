import {
  type CallHandler,
  type CanActivate,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { from, type Observable, switchMap } from 'rxjs';

import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import type { ApiRateLimitScope } from './auth-rate-limit.config';
import { AuthRateLimitService } from './auth-rate-limit.service';

const SKIP_API_RATE_LIMIT = 'p3be11:skip-api-rate-limit';

/**
 * Exempts a handler (or controller) from the API-wide limits. Used only for
 * health probes, which load balancers call continuously and which must keep
 * answering even when the rate-limit store (PostgreSQL) is unavailable.
 */
export const SkipApiRateLimit = () => SetMetadata(SKIP_API_RATE_LIMIT, true);

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * P3-BE11 global guard (APP_GUARD): runs before every controller guard, so
 * it bounds unauthenticated floods (including 401 token guessing) per
 * client IP. `request.ip` honours TRUST_PROXY only: X-Forwarded-For,
 * CF-Connecting-IP and similar headers from an untrusted peer are ignored.
 * Routes without JwtAuthGuard (the public catalogue and auth entry points)
 * additionally count against the `public` policy.
 */
@Injectable()
export class ApiRateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly rateLimits: AuthRateLimitService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(SKIP_API_RATE_LIMIT, targets)) return true;

    const guards = targets.flatMap((t) => (Reflect.getMetadata(GUARDS_METADATA, t) as unknown[] | undefined) ?? []);
    const scopes: ApiRateLimitScope[] = guards.includes(JwtAuthGuard) ? ['api'] : ['api', 'public'];
    const request = context.switchToHttp().getRequest<Request>();
    await this.rateLimits.consumeApi(scopes, { ip: request.ip });
    return true;
  }
}

/**
 * P3-BE11 global interceptor (APP_INTERCEPTOR): interceptors run after the
 * guards, so `request.user` is the user JwtAuthGuard verified (session,
 * status, role from the database). Reads and writes have separate budgets.
 */
@Injectable()
export class ApiUserRateLimitInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly rateLimits: AuthRateLimitService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    if (this.reflector.getAllAndOverride<boolean>(SKIP_API_RATE_LIMIT, [context.getHandler(), context.getClass()])) return next.handle();
    const request = context.switchToHttp().getRequest<Request & { user?: { id?: unknown } }>();
    const userId = typeof request.user?.id === 'string' ? request.user.id : null;
    if (!userId) return next.handle();
    const scope: ApiRateLimitScope = READ_METHODS.has(request.method) ? 'user-read' : 'user-write';
    return from(this.rateLimits.consumeApi([scope], { userId })).pipe(switchMap(() => next.handle()));
  }
}
