import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

const PROVIDER_APPROVAL_STATUSES = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'SUSPENDED',
] as const;

export type ProviderApprovalStatus =
  (typeof PROVIDER_APPROVAL_STATUSES)[number];

export class AdminProviderQueryDto {
  @ApiPropertyOptional({
    enum: PROVIDER_APPROVAL_STATUSES,
    description: 'Optionally filter providers by approval status.',
  })
  @IsOptional()
  @IsIn(PROVIDER_APPROVAL_STATUSES)
  status?: ProviderApprovalStatus;
}
