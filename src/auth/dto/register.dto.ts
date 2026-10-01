/**
 * Register DTO
 *
 * Defines and validates the data accepted by the public
 * user registration endpoint.
 *
 * Security note:
 * - Public registration does NOT accept a user role.
 * - Newly registered accounts will be assigned the CUSTOMER role
 *   by the backend.
 * - This prevents users from registering themselves as ADMIN,
 *   PROVIDER_OWNER, or PROVIDER_STAFF.
 */

import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class RegisterDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() || undefined : value,
  )
  @IsString()
  @MinLength(2)
  @MaxLength(150)
  fullName!: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password!: string;
}
