import type { ValidationPipeOptions } from '@nestjs/common';

/**
 * Options for the global ValidationPipe registered in `main.ts`.
 *
 * Kept in one module so tests validate DTOs with exactly the production
 * configuration.
 */
export const GLOBAL_VALIDATION_PIPE_OPTIONS: ValidationPipeOptions = {
  // Removes properties that are not declared in the DTO.
  whitelist: true,

  // Rejects the request instead of silently removing unknown properties.
  forbidNonWhitelisted: true,

  // Instantiates DTO classes so `@Transform` and default values apply.
  transform: true,

  transformOptions: {
    // Implicit conversion coerced invalid JSON types before validation
    // (e.g. "false" -> true, true -> 1, "" -> 0, {} -> "[object Object]").
    // Numeric fields and IDs opt in to narrow conversion explicitly via
    // `toNumberIfNumericString` / `toBigIntIdStringIfSafeInteger`.
    enableImplicitConversion: false,
  },
};
