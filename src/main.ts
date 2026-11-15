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
import {
  loadLoggingConfig,
  StructuredLogger,
} from './common/observability/structured-logger';
import { GLOBAL_VALIDATION_PIPE_OPTIONS } from './common/pipes/validation-pipe.options';
import { parseTrustProxy } from './common/utils/trust-proxy';

/**
 * Application bootstrap
 *
 * Responsibilities:
 * - Starts the NestJS application.
 * - Applies the global `/api` route prefix.
 * - Enables CORS for frontend-backend communication.
 * - Enables global request validation and transformation.
 * - Configures Swagger/OpenAPI documentation.
 * - Reads the application port from environment variables.
 * - Enables graceful shutdown hooks.
 */
async function bootstrap() {
  // P3-BE09: structured, PII-free logs from the first line on. The .env file
  // is already in process.env here: ConfigModule.forRoot loads it
  // synchronously when AppModule is imported. Invalid LOG_FORMAT / LOG_LEVEL
  // values stop the startup.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: new StructuredLogger(loadLoggingConfig(process.env)),
  });
  const logger = new Logger('Bootstrap');

  // P3-BE09: X-Request-ID on every response, one completion event per
  // request, safe exception logging. Before any other middleware.
  applyHttpObservability(app);

  const configService = app.get(ConfigService);

  // P3-BE03: which reverse proxies may set X-Forwarded-For. Default: none,
  // so request.ip (sessions, rate limiting, Turnstile remoteip) is the TCP
  // peer and cannot be spoofed by clients. Invalid values stop the startup.
  const trustProxy = parseTrustProxy(configService.get<string>('TRUST_PROXY'));
  app.set('trust proxy', trustProxy);
  logger.log(`Trust proxy: ${trustProxy === false ? 'off (X-Forwarded-For ignored)' : JSON.stringify(trustProxy)}`);

  // All application endpoints will start with /api.
  // Example:
  // /auth/login -> /api/auth/login
  // /pets       -> /api/pets
  app.setGlobalPrefix('api');

  // Allows the frontend application to communicate with this backend.
  //
  // For local development, FRONTEND_URL can be:
  // http://localhost:3001
  //
  // credentials: true allows authenticated requests that may use
  // cookies or authorization-related browser credentials later.
  app.enableCors({
    origin: configService.get<string>('FRONTEND_URL') ?? 'http://localhost:3001',
    credentials: true,
    // Lets the browser read the P2-07 booking replay marker and the
    // P3-BE09 correlation ID (to quote it in bug reports).
    exposedHeaders: [IDEMPOTENT_REPLAYED_HEADER, REQUEST_ID_HEADER],
  });

  // Global validation for incoming request DTOs.
  app.useGlobalPipes(new ValidationPipe(GLOBAL_VALIDATION_PIPE_OPTIONS));

  // Swagger / OpenAPI configuration.
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

  // Allows NestJS to properly clean up resources such as
  // database connections when the application shuts down.
  app.enableShutdownHooks();

  const port = configService.get<number>('PORT') ?? 3000;

  await app.listen(port);

  logger.log(`PawFlow API is running on http://localhost:${port}/api`);
  logger.log(
    `Swagger documentation is available at http://localhost:${port}/api/docs`,
  );
}

void bootstrap();