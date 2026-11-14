import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import type { RateLimitedRoute } from './auth-rate-limit.config';
import { AuthRateLimitService } from './auth-rate-limit.service';

const RATE_LIMIT_ROUTE = 'p3be03:rate-limit-route';

/** Marks a handler as rate limited under the given route's policies. */
export const RateLimit = (route: RateLimitedRoute) => SetMetadata(RATE_LIMIT_ROUTE, route);

/**
 * Runs before validation and bot verification, so abusive traffic is
 * refused at the cost of one database round trip. The client IP is
 * `request.ip`, which honours TRUST_PROXY (X-Forwarded-For is used only
 * from configured proxies). The e-mail key is read from the raw body.
 */
@Injectable()
export class AuthRateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly rateLimits: AuthRateLimitService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const route = this.reflector.get<RateLimitedRoute | undefined>(RATE_LIMIT_ROUTE, context.getHandler());
    if (!route) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const body = (request.body ?? {}) as Record<string, unknown>;

    await this.rateLimits.consume(route, { ip: request.ip, email: body.email });
    return true;
  }
}
