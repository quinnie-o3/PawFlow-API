import { applyDecorators } from '@nestjs/common';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

import { TURNSTILE_TOKEN_MAX_LENGTH } from '../bot-protection/turnstile.config';

/**
 * P3-BE03 `turnstileToken` request field. Optional at the DTO level so
 * clients keep working while TURNSTILE_MODE=disabled; when enforcement is
 * on, TurnstileService rejects a missing value (403 TURNSTILE_REQUIRED).
 * Type and length are validated in every mode.
 */
export function TurnstileTokenField(action: string) {
  return applyDecorators(
    ApiPropertyOptional({
      description:
        `Cloudflare Turnstile response token from a widget rendered with action \`${action}\`. ` +
        'Required when the server runs with TURNSTILE_MODE=enforce (403 TURNSTILE_REQUIRED otherwise). ' +
        'Single use, valid 300 s: obtain a fresh token for every submission.',
      maxLength: TURNSTILE_TOKEN_MAX_LENGTH,
      example: '0.zLR6ZQe-…',
    }),
    IsOptional(),
    IsString(),
    MaxLength(TURNSTILE_TOKEN_MAX_LENGTH),
  );
}
