import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { AppModule } from './app.module';
import { IDEMPOTENT_REPLAYED_HEADER } from './bookings/booking-idempotency';
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
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  const configService = app.get(ConfigService);

  // P3-BE03: which reverse proxies may set X-Forwarded-For. Default: none,
  // so request.ip (sessions, rate limiting, Turnstile remoteip) is the TCP
  // peer and cannot be spoofed by clients. Invalid values stop the startup.
  const trustProxy = parseTrustProxy(configService.get<string>('TRUST_PROXY'));
  app.set('trust proxy', trustProxy);
  console.log(`Trust proxy: ${trustProxy === false ? 'off (X-Forwarded-For ignored)' : JSON.stringify(trustProxy)}`);

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
    // Lets the browser read the P2-07 booking replay marker.
    exposedHeaders: [IDEMPOTENT_REPLAYED_HEADER],
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

  console.log(`PawFlow API is running on http://localhost:${port}/api`);
  console.log(
    `Swagger documentation is available at http://localhost:${port}/api/docs`,
  );
}

void bootstrap();