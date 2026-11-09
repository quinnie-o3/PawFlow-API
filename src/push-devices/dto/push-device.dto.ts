import { ApiProperty } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger';
import { IsIn, IsString, MaxLength, ValidateBy, type ValidationArguments } from 'class-validator';

import {
  PUSH_PLATFORMS,
  type PushPlatform,
  REGISTRATION_KINDS,
  REGISTRATION_VALUE_MAX_LENGTH,
  REGISTRATION_VALUE_PATTERNS,
  type RegistrationKind,
} from '../push-device-types';

/** The value must match the format of its declared kind (FIDs and tokens are never interchangeable). */
function MatchesRegistrationKind() {
  return ValidateBy({
    name: 'matchesRegistrationKind',
    validator: {
      validate: (value: unknown, args?: ValidationArguments) => {
        const kind = (args?.object as { registrationKind?: unknown })?.registrationKind;
        return typeof value === 'string' && (kind === 'FID' || kind === 'FCM_TOKEN') && REGISTRATION_VALUE_PATTERNS[kind].test(value);
      },
      defaultMessage: () => 'registrationValue is not a valid value for registrationKind',
    },
  });
}

export class RegisterPushDeviceDto {
  @ApiProperty({
    enum: REGISTRATION_KINDS,
    example: 'FID',
    description: '`FID` (Firebase Installation ID from `onRegistered()`; required for new clients) or `FCM_TOKEN` (legacy `getToken()`; compatibility only).',
  })
  @IsIn(REGISTRATION_KINDS)
  registrationKind!: RegistrationKind;

  @ApiProperty({
    maxLength: REGISTRATION_VALUE_MAX_LENGTH,
    example: 'cVxq3f8mT0uYhL2s9pQ1zA',
    description: 'The FID or legacy token. Stored encrypted; never returned by the API.',
  })
  @IsString()
  @MaxLength(REGISTRATION_VALUE_MAX_LENGTH)
  @MatchesRegistrationKind()
  registrationValue!: string;

  @ApiProperty({ enum: PUSH_PLATFORMS, example: 'WEB' })
  @IsIn(PUSH_PLATFORMS)
  platform!: PushPlatform;
}

export const PUSH_DEVICE_SCHEMA: SchemaObject = {
  type: 'object',
  required: ['id', 'platform', 'registrationKind', 'current', 'stale', 'registeredAt', 'lastSeenAt'],
  properties: {
    id: { type: 'string', example: '17' },
    platform: { type: 'string', enum: [...PUSH_PLATFORMS] },
    registrationKind: { type: 'string', enum: [...REGISTRATION_KINDS] },
    current: { type: 'boolean', description: 'Registered by the session of this request (this browser / app).' },
    stale: { type: 'boolean', description: 'Not re-registered within the stale threshold (default 30 days): not used for delivery until it registers again.' },
    registeredAt: { type: 'string', format: 'date-time' },
    lastSeenAt: { type: 'string', format: 'date-time', description: 'Last registration or refresh.' },
  },
};
