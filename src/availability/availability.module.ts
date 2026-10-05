import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AvailabilitySlot } from './entities/availability-slot.entity';

@Module({
  imports: [TypeOrmModule.forFeature([AvailabilitySlot])],
})
export class AvailabilityModule {}