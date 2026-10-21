import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, Matches } from 'class-validator';

export class DashboardQueryDto {
  @ApiProperty({
    example: '2026-10-01',
    description: 'Start date of the reporting period (YYYY-MM-DD).',
  })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'from must be in YYYY-MM-DD format',
  })
  @IsDateString()
  from!: string;

  @ApiProperty({
    example: '2026-10-31',
    description: 'End date of the reporting period (YYYY-MM-DD).',
  })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'to must be in YYYY-MM-DD format',
  })
  @IsDateString()
  to!: string;
}