import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { AppModule } from './app.module';

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
  const app = await NestFactory.create(AppModule);

  const configService = app.get(ConfigService);

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
  });

  // Global validation for incoming request DTOs.
  app.useGlobalPipes(
    new ValidationPipe({
      // Removes properties that are not declared in the DTO.
      whitelist: true,

      // Rejects the request instead of silently removing unknown properties.
      forbidNonWhitelisted: true,

      // Converts incoming values to their expected DTO types when possible.
      transform: true,

      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

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