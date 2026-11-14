import { ApiProperty } from '@nestjs/swagger';

import { IsCalendarDate } from '../../common/utils/calendar-date.util';

export class DashboardQueryDto {
  @ApiProperty({
    example: '2026-10-01',
    format: 'date',
    description:
      'Start date of the reporting period (YYYY-MM-DD). Must be a real calendar date.',
  })
  @IsCalendarDate()
  from!: string;

  @ApiProperty({
    example: '2026-10-31',
    format: 'date',
    description:
      'End date of the reporting period (YYYY-MM-DD). Must be a real calendar date.',
  })
  @IsCalendarDate()
  to!: string;
}