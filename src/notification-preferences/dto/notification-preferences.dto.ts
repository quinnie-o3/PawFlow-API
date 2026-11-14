import { ApiProperty } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger';
import { IsBoolean, IsDefined } from 'class-validator';

/**
 * PATCH body. `pushEnabled` is required and must be a JSON boolean: the
 * global pipe has implicit conversion disabled, so "true", 1 or null are
 * rejected (400). Unknown properties (userId, role, pushEnabledAt, ...) are
 * rejected by `forbidNonWhitelisted`. The account always comes from the
 * access token.
 */
export class UpdateNotificationPreferencesDto {
  @ApiProperty({ type: Boolean, example: true, description: 'true = opt in to push notifications, false = opt out. The inbox is unaffected either way.' })
  @IsDefined()
  @IsBoolean()
  pushEnabled!: boolean;
}

export const NOTIFICATION_PREFERENCES_SCHEMA: SchemaObject = {
  type: 'object',
  required: ['pushEnabled', 'pushEnabledAt', 'pushAvailable', 'updatedAt'],
  properties: {
    pushEnabled: { type: 'boolean', example: false, description: 'Stored consent. Default false (no stored preference = opted out).' },
    pushEnabledAt: {
      type: 'string',
      format: 'date-time',
      nullable: true,
      example: null,
      description: 'Start of the current continuous opt-in period (server time); null while opted out. Notifications created before it are never pushed.',
    },
    pushAvailable: {
      type: 'boolean',
      example: false,
      description: 'Whether this environment currently delivers real push notifications. Informational, independent of the stored preference.',
    },
    updatedAt: { type: 'string', format: 'date-time', nullable: true, example: null, description: 'Last actual change; null if never changed.' },
  },
};

/** Response body of GET and PATCH. */
export interface NotificationPreferencesView {
  pushEnabled: boolean;
  pushEnabledAt: string | null;
  pushAvailable: boolean;
  updatedAt: string | null;
}
