import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

const COMPLAINT_STATUSES = [
  'OPEN',
  'IN_REVIEW',
  'RESOLVED',
  'REJECTED',
] as const;

export type ComplaintStatus = (typeof COMPLAINT_STATUSES)[number];

export class AdminComplaintQueryDto {
  @ApiPropertyOptional({
    enum: COMPLAINT_STATUSES,
    description: 'Optionally filter complaints by status.',
  })
  @IsOptional()
  @IsIn(COMPLAINT_STATUSES)
  status?: ComplaintStatus;
}
