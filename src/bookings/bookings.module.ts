import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PushDeliveryModule } from '../push-delivery/push-delivery.module';
import { AvailabilitySlot } from '../availability/entities/availability-slot.entity';
import { Pet } from '../pets/entities/pet.entity';
import { Provider } from '../providers/entities/provider.entity';
import { ProviderStaff } from '../providers/entities/provider-staff.entity';
import { Service } from '../services/entities/service.entity';
import { BookingEventsService } from './booking-events.service';
import { BookingsController } from './bookings.controller';
import { BookingsService } from './bookings.service';
import { BookingIdempotencyKey } from './entities/booking-idempotency-key.entity';
import { BookingStatusLog } from './entities/booking-status-log.entity';
import { Booking } from './entities/booking.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Booking,
      BookingStatusLog,
      BookingIdempotencyKey,
      Pet,
      AvailabilitySlot,
      Service,
      Provider,
      ProviderStaff,
    ]),
    AuthModule,
    // P3-BE06-03: booking status events -> inbox notifications + push outbox.
    NotificationsModule,
    PushDeliveryModule,
  ],
  controllers: [BookingsController],
  providers: [BookingsService, BookingEventsService],
  exports: [BookingsService],
})
export class BookingsModule {}
