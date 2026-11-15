import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { PushDevice } from './entities/push-device.entity';
import { PushDevicesController } from './push-devices.controller';
import { PushDevicesService } from './push-devices.service';

/**
 * P3-BE05 FCM device lifecycle (registration storage only; no Firebase SDK).
 * Exports PushDevicesService for P3-BE06 (findSendTargets, markInvalid,
 * revokeStale).
 */
@Module({
  imports: [ConfigModule, TypeOrmModule.forFeature([PushDevice]), AuthModule],
  controllers: [PushDevicesController],
  providers: [PushDevicesService],
  exports: [PushDevicesService],
})
export class PushDevicesModule {}
