import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

const MASTER_DATA_STATUSES = ['ACTIVE', 'INACTIVE'] as const;

export type MasterDataStatus = (typeof MASTER_DATA_STATUSES)[number];

export class AdminMasterDataQueryDto {
  @ApiPropertyOptional({
    enum: MASTER_DATA_STATUSES,
    description: 'Optionally filter records by status.',
  })
  @IsOptional()
  @IsIn(MASTER_DATA_STATUSES)
  status?: MasterDataStatus;
}
