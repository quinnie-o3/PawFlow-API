import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { NotificationPreference } from './entities/notification-preference.entity';
import { NotificationPreferencesController } from './notification-preferences.controller';
import { NotificationPreferencesService } from './notification-preferences.service';

/**
 * P3-BE07 user push preference. Exports NotificationPreferencesService
 * (getPushConsentForDelivery) for the push dispatcher (BE07-03). Delivery is
 * not filtered by preferences yet.
 */
@Module({
  imports: [ConfigModule, TypeOrmModule.forFeature([NotificationPreference]), AuthModule],
  controllers: [NotificationPreferencesController],
  providers: [NotificationPreferencesService],
  exports: [NotificationPreferencesService],
})
export class NotificationPreferencesModule {}
