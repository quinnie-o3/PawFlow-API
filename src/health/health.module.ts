import { Module } from '@nestjs/common';

import { HealthController } from './health.controller';
import { SchemaStatusService } from './schema-status.service';

/** P3-BE11 liveness / readiness endpoints and the startup schema check. */
@Module({
  controllers: [HealthController],
  providers: [SchemaStatusService],
})
export class HealthModule {}
