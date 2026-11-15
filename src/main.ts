import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { AppModule } from './app.module';
import { IDEMPOTENT_REPLAYED_HEADER } from './bookings/booking-idempotency';
import { applyHttpObservability } from './common/observability/http-observability';
import {
  REQUEST_ID_HEADER,
  REQUEST_ID_PATTERN,
} from './common/observability/request-id';
import { sanitizeLogText } from './common/observability/log-fields';
import {
  loadLoggingConfig,
  StructuredLogger,
} from './common/observability/structured-logger';
import { GLOBAL_VALIDATION_PIPE_OPTIONS } from './common/pipes/validation-pipe.options';
import { corsOptions, securityHeadersMiddleware } from './common/security/http-security';
import { parseTrustProxy } from './common/utils/trust-proxy';
import { loadReleaseConfig } from './config/deployment-environment';

/**
 * Application bootstrap
 *
 * Responsibilities:
 * - Validates the deployment configuration before anything connects (P3-BE11).
 * - Starts the NestJS application with structured logs (P3-BE09).
 * - Request correlation, security headers, trusted-proxy policy, CORS allowlist.
 * - Applies the global `/api` route prefix and request validation.
 * - Configures Swagger/OpenAPI documentation (off by default in staging/production).
 * - Reads the application port from environment variables.
 * - Enables graceful shutdown hooks.
 */
async function bootstrap() {
  // P3-BE11: refuse unsafe staging/production configuration before the
  // application is created (i.e. before any database connection). The .env
  // file is already in process.env here: ConfigModule.forRoot loads it
  // synchronously when AppModule is imported.
  const release = loadReleaseConfig(process.env);

  // P3-BE09: structured, PII-free logs from the first line on. Invalid
  // LOG_FORMAT / LOG_LEVEL values stop the startup.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: new StructuredLogger(loadLoggingConfig(process.env)),
  });
  const logger = new Logger('Bootstrap');

  // P3-BE11: no technology disclosure.
  app.disable('x-powered-by');

  // P3-BE09: X-Request-ID on every response, one completion event per
  // request, safe exception logging. Before any other middleware.
  applyHttpObservability(app);

  // P3-BE11: security headers on every response (HSTS only on requests that
  // are HTTPS according to the trusted-proxy policy below).
  app.use(securityHeadersMiddleware({ hstsMaxAgeSeconds: release.hstsMaxAgeSeconds }));

  const configService = app.get(ConfigService);

  // P3-BE03: which reverse proxies may set X-Forwarded-For / X-Forwarded-Proto.
  // Default: none, so request.ip (sessions, rate limiting, Turnstile remoteip)
  // is the TCP peer and request.secure reflects the actual connection; clients
  // cannot spoof either. Required explicitly in staging/production (P3-BE11).
  const trustProxy = parseTrustProxy(configService.get<string>('TRUST_PROXY'));
  app.set('trust proxy', trustProxy);
  logger.log(`Trust proxy: ${trustProxy === false ? 'off (X-Forwarded-For ignored)' : JSON.stringify(trustProxy)}`);
  logger.log(`Environment ${release.nodeEnv}: CORS origins ${release.corsOrigins.length}, Swagger ${release.swaggerEnabled ? 'on' : 'off'}, HSTS ${release.hstsMaxAgeSeconds > 0 ? 'on (HTTPS requests)' : 'off'}, DB TLS ${release.dbSsl}, schema check ${release.migrationsCheck}`);

  // All application endpoints will start with /api.
  // Example:
  // /auth/login -> /api/auth/login
  // /pets       -> /api/pets
  app.setGlobalPrefix('api');

  // P3-BE11: exact-origin CORS allowlist (CORS_ORIGINS; FRONTEND_URL or the
  // local defaults outside staging/production). Exposes the booking replay
  // marker, the correlation ID and Retry-After to the browser.
  app.enableCors(corsOptions(release.corsOrigins, [IDEMPOTENT_REPLAYED_HEADER, REQUEST_ID_HEADER, 'Retry-After']));

  // Global validation for incoming request DTOs.
  app.useGlobalPipes(new ValidationPipe(GLOBAL_VALIDATION_PIPE_OPTIONS));

  // Swagger / OpenAPI: on by default outside staging/production; there it
  // requires SWAGGER_ENABLED=true (internal documentation is not public by accident).
  if (release.swaggerEnabled) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('PawFlow API')
      .setDescription(
        'REST API documentation for the PawFlow pet care service booking and provider management platform.',
      )
      .setVersion('1.0')
      .addGlobalParameters({
        in: 'header',
        name: REQUEST_ID_HEADER,
        required: false,
        description:
          'Optional client correlation ID: 8-128 characters from [A-Za-z0-9._:-], starting with a letter or digit. ' +
          'Kept when valid, otherwise replaced by a server-generated UUID. Every response (including errors) ' +
          'returns the authoritative value in the X-Request-ID response header; quote it when reporting a problem.',
        schema: { type: 'string', pattern: REQUEST_ID_PATTERN.source, maxLength: 128 },
      })
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
        'access-token',
      )
      .build();

    const swaggerDocument = SwaggerModule.createDocument(
      app,
      swaggerConfig,
    );

    SwaggerModule.setup('docs', app, swaggerDocument, {
      useGlobalPrefix: true,
      swaggerOptions: {
        persistAuthorization: true,
      },
    });
  }

  // Allows NestJS to properly clean up resources such as
  // database connections when the application shuts down.
  app.enableShutdownHooks();

  const port = configService.get<number>('PORT') ?? 3000;

  await app.listen(port);

  logger.log(`PawFlow API is running on http://localhost:${port}/api`);
  if (release.swaggerEnabled) {
    logger.log(`Swagger documentation is available at http://localhost:${port}/api/docs`);
  }
}

bootstrap().catch((error: unknown) => {
  // Sanitized refusal: configuration errors name variables and rules, never values.
  const message = sanitizeLogText(error instanceof Error ? error.message : 'startup failed', 2000);
  process.stderr.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level: 'fatal', event: 'app.startup_refused', message })}\n`);
  process.exit(1);
});
