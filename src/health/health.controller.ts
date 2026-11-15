import { Controller, Get, HttpCode, HttpStatus, Logger, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOkResponse, ApiOperation, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { DataSource } from 'typeorm';

import { SkipApiRateLimit } from '../auth/rate-limit/api-rate-limit';
import { SchemaStatusService, type SchemaStatus } from './schema-status.service';

export type DatabaseProbe = 'up' | 'down' | 'timeout';

/**
 * P3-BE11 health endpoints (public, minimal, machine-readable).
 *
 * - GET /api/health/live: the process is serving HTTP. No dependency is
 *   touched, so a database outage never makes an orchestrator restart a
 *   healthy process.
 * - GET /api/health/ready: the instance can serve normal traffic: a bounded
 *   `SELECT 1` (HEALTH_DB_TIMEOUT_MS, default 2000 ms) and the schema status
 *   computed at startup. 200 when ready, 503 otherwise.
 *
 * Responses never contain hosts, credentials, versions, errors or stack
 * traces. Exempt from the API-wide rate limits (probes are continuous and
 * must answer even when the rate-limit store is down); they read no
 * business data, so the exemption grants no access to anything else.
 */
@ApiTags('Health')
@SkipApiRateLimit()
@Controller('health')
export class HealthController {
  private readonly logger = new Logger('Health');

  constructor(
    private readonly dataSource: DataSource,
    private readonly schema: SchemaStatusService,
    private readonly config: ConfigService,
  ) {}

  @Get('live')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Liveness: the API process is running' })
  @ApiOkResponse({ description: '`{ "status": "ok" }`' })
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Readiness: database reachable and schema at this build\'s migration level' })
  @ApiOkResponse({ description: '`{ "status": "ready", "checks": { "database": "up", "schema": "current" } }`' })
  @ApiServiceUnavailableResponse({ description: '`{ "status": "unavailable", "checks": { ... } }` (database down/timeout or schema not current).' })
  async ready(@Res({ passthrough: true }) res: Response): Promise<{ status: 'ready' | 'unavailable'; checks: { database: DatabaseProbe; schema: SchemaStatus } }> {
    const database = await this.probeDatabase();
    const schema = this.schema.status;
    const ready = database === 'up' && schema === 'current';
    if (!ready) {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
      this.logger.warn(`Readiness check failed (database ${database}, schema ${schema})`);
    }
    return { status: ready ? 'ready' : 'unavailable', checks: { database, schema } };
  }

  /** `SELECT 1` bounded by HEALTH_DB_TIMEOUT_MS; never throws. */
  async probeDatabase(): Promise<DatabaseProbe> {
    const raw = Number(this.config.get<string>('HEALTH_DB_TIMEOUT_MS') ?? 2000);
    const timeoutMs = Number.isInteger(raw) && raw >= 100 && raw <= 10_000 ? raw : 2000;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<DatabaseProbe>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    const query = this.dataSource.query('SELECT 1').then(
      () => 'up' as const,
      () => 'down' as const,
    );
    try {
      return await Promise.race([query, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
