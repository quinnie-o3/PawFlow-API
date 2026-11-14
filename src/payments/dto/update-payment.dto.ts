import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

export class UpdatePaymentDto {
  @ApiProperty({
    enum: ['UNPAID', 'PAID', 'FAILED'],
    example: 'PAID',
    description: 'Simulated payment status.',
  })
  @IsIn(['UNPAID', 'PAID', 'FAILED'])
  paymentStatus!: 'UNPAID' | 'PAID' | 'FAILED';

  @ApiPropertyOptional({
    enum: ['CASH', 'QR', 'BANK_TRANSFER', 'OTHER'],
    example: 'QR',
    nullable: true,
    description: 'Optional simulated payment method.',
  })
  @IsOptional()
  @IsIn(['CASH', 'QR', 'BANK_TRANSFER', 'OTHER'])
  method?: 'CASH' | 'QR' | 'BANK_TRANSFER' | 'OTHER' | null;
}