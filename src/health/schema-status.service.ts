import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

import { isDeployedEnvironment } from '../config/deployment-environment';

export type SchemaStatus = 'current' | 'pending' | 'ahead' | 'unknown';

/**
 * Migration names shipped with this build, derived from the migration file
 * names (`<timestamp>-<Name>.(js|ts)` -> `<Name><timestamp>`, the TypeORM
 * class-name convention used by every PawFlow migration).
 */
export function expectedMigrationNames(dir = join(__dirname, '..', 'database', 'migrations')): string[] {
  return readdirSync(dir)
    .map((file) => /^(\d+)-([A-Za-z0-9]+)\.(js|ts)$/.exec(file))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => `${m[2]}${m[1]}`)
    .sort();
}

/** Compares the applied migrations (migrations table) with the build's migrations. */
export function compareSchema(expected: readonly string[], applied: readonly string[]): { status: SchemaStatus; pending: number; unknown: number } {
  const appliedSet = new Set(applied);
  const expectedSet = new Set(expected);
  const pending = expected.filter((n) => !appliedSet.has(n)).length;
  const unknown = applied.filter((n) => !expectedSet.has(n)).length;
  return { status: pending > 0 ? 'pending' : unknown > 0 ? 'ahead' : 'current', pending, unknown };
}

/**
 * P3-BE11 schema readiness. At startup the database's migration level is
 * compared with the build. MIGRATIONS_CHECK=enforce (default in staging and
 * production) refuses to start on a pending, unknown or unreadable schema:
 * migrations are a deliberate release step, never run implicitly by the
 * application or by health checks. The result is reported by /health/ready.
 */
@Injectable()
export class SchemaStatusService implements OnApplicationBootstrap {
  private readonly logger = new Logger('SchemaStatus');
  private current: SchemaStatus = 'unknown';

  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {}

  get status(): SchemaStatus {
    return this.current;
  }

  get enforced(): boolean {
    const raw = this.config.get<string>('MIGRATIONS_CHECK')?.trim().toLowerCase();
    return (raw || (isDeployedEnvironment(this.config.get<string>('NODE_ENV')) ? 'enforce' : 'off')) === 'enforce';
  }

  async onApplicationBootstrap(): Promise<void> {
    let pending = 0;
    let unknown = 0;
    try {
      const applied = ((await this.dataSource.query('SELECT name FROM migrations')) as Array<{ name: string }>).map((r) => r.name);
      ({ status: this.current, pending, unknown } = compareSchema(expectedMigrationNames(), applied));
    } catch (error) {
      this.current = 'unknown';
      this.logger.error(`Schema status could not be read (${error instanceof Error ? error.name : 'error'})`);
    }

    if (this.current === 'current') {
      this.logger.log('Database schema matches this build');
      return;
    }
    const detail = this.current === 'unknown' ? 'migration state unreadable' : `${pending} pending, ${unknown} not in this build`;
    if (this.enforced) {
      throw new Error(`Database schema check failed (${detail}); apply this release's migrations before starting (MIGRATIONS_CHECK=enforce)`);
    }
    this.logger.warn(`Database schema is not at this build's level (${detail}); MIGRATIONS_CHECK=off`);
  }
}
