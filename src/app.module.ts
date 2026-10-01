import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { AvailabilitySlot } from './providers/entities/availability-slot.entity';
import { BookingStatusLog } from './providers/entities/booking-status-log.entity';
import { Booking } from './providers/entities/booking.entity';
import { Complaint } from './providers/entities/complaint.entity';
import { Payment } from './providers/entities/payment.entity';
import { PetType } from './providers/entities/pet-type.entity';
import { Pet } from './providers/entities/pet.entity';
import { ProviderStaff } from './providers/entities/provider-staff.entity';
import { ProviderWorkingHour } from './providers/entities/provider-working-hour.entity';
import { Provider } from './providers/entities/provider.entity';
import { Review } from './providers/entities/review.entity';
import { ServiceCategory } from './providers/entities/service-category.entity';
import { Service } from './providers/entities/service.entity';
import { User } from './providers/entities/user.entity';
import { PetsModule } from './pets/pets.module';
import { ProvidersModule } from './providers/providers.module';
import { UsersModule } from './users/users.module';

/**
 * Root application module.
 *
 * Responsibilities:
 * - Loads environment configuration.
 * - Initializes the PostgreSQL connection through TypeORM.
 * - Registers all domain modules.
 *
 * Entity discovery is handled through `autoLoadEntities`.
 * Each domain module registers its own entities using
 * `TypeOrmModule.forFeature(...)`.
 */

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),

    TypeOrmModule.forRootAsync({
      inject: [ConfigService],

      useFactory: (configService: ConfigService) => ({
        type: 'postgres',

        host: configService.getOrThrow<string>('DB_HOST'),
        port: Number(configService.getOrThrow<string>('DB_PORT')),

        username: configService.getOrThrow<string>('DB_USERNAME'),
        password: configService.getOrThrow<string>('DB_PASSWORD'),
        database: configService.getOrThrow<string>('DB_DATABASE'),

        entities: [
          AvailabilitySlot,
          BookingStatusLog,
          Booking,
          Complaint,
          Payment,
          PetType,
          Pet,
          ProviderStaff,
          ProviderWorkingHour,
          Provider,
          Review,
          ServiceCategory,
          Service,
          User,
        ],
        autoLoadEntities: true,
        synchronize: false,
      }),
    }),

    UsersModule,
    AuthModule,
    PetsModule,
    ProvidersModule,
  ],

  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
