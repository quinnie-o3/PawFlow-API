import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

export const ADMIN_USER_ROLES = [
  'CUSTOMER',
  'PROVIDER_OWNER',
  'PROVIDER_STAFF',
  'ADMIN',
] as const;

export const ADMIN_USER_STATUSES = [
  'ACTIVE',
  'INACTIVE',
  'SUSPENDED',
] as const;

export type AdminUserRole = (typeof ADMIN_USER_ROLES)[number];
export type AdminUserStatus = (typeof ADMIN_USER_STATUSES)[number];

export class AdminUserQueryDto {
  @ApiPropertyOptional({
    enum: ADMIN_USER_ROLES,
    description: 'Optional read-only filter by account role.',
  })
  @IsOptional()
  @IsIn(ADMIN_USER_ROLES)
  role?: AdminUserRole;

  @ApiPropertyOptional({
    enum: ADMIN_USER_STATUSES,
    description: 'Optional read-only filter by account status.',
  })
  @IsOptional()
  @IsIn(ADMIN_USER_STATUSES)
  status?: AdminUserStatus;
}
