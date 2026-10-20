import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { AvailabilitySlot } from '../availability/entities/availability-slot.entity';
import { Pet } from '../pets/entities/pet.entity';
import { Provider } from '../providers/entities/provider.entity';
import { ProviderStaff } from '../providers/entities/provider-staff.entity';
import { Service } from '../services/entities/service.entity';
import { BookingsController } from './bookings.controller';
import { BookingsService } from './bookings.service';
import { BookingStatusLog } from './entities/booking-status-log.entity';
import { Booking } from './entities/booking.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Booking,
      BookingStatusLog,
      Pet,
      AvailabilitySlot,
      Service,
      Provider,
      ProviderStaff,
    ]),
    AuthModule,
  ],
  controllers: [BookingsController],
  providers: [BookingsService],
  exports: [BookingsService],
})
export class BookingsModule {}
