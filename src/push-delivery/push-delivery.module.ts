import { Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { NotificationPreferencesModule } from '../notification-preferences/notification-preferences.module';
import { NotificationPreferencesService } from '../notification-preferences/notification-preferences.service';
import { PushDevicesModule } from '../push-devices/push-devices.module';
import { PushDevicesService } from '../push-devices/push-devices.service';
import { PushDispatchExecutor } from './dispatch/push-dispatch.executor';
import { NotificationDelivery } from './entities/notification-delivery.entity';
import { NotificationPushSend } from './entities/notification-push-send.entity';
import { PUSH_PROVIDER, type PushProvider } from './provider/push-provider.types';
import { createPushProvider } from './provider/push-providers';
import { loadPushDeliveryConfig } from './push-delivery.config';
import { PushOutboxService } from './push-outbox.service';
import { DELIVERY_JOB_EXECUTOR, type DeliveryJobExecutor } from './worker/delivery-job.types';
import { PushDeliveryWorker } from './worker/push-delivery.worker';
import { PushJobStore } from './worker/push-job.store';
import { loadPushWorkerConfig } from './worker/push-worker.config';

/**
 * P3-BE06 push delivery.
 * - BE06-02: transactional outbox (entity + internal enqueue API).
 * - BE06-04: PUSH_PROVIDER (disabled | mock | firebase).
 * - BE06-05: durable worker (claiming, leases, retries, deadlines). Disabled
 *   unless PUSH_WORKER_ENABLED=true.
 * - BE06-06: DELIVERY_JOB_EXECUTOR = PushDispatchExecutor (devices -> provider
 *   -> per-device outcomes). No controller.
 */
@Module({
  imports: [ConfigModule, TypeOrmModule.forFeature([NotificationDelivery, NotificationPushSend]), PushDevicesModule, NotificationPreferencesModule],
  providers: [
    PushOutboxService,
    {
      provide: PUSH_PROVIDER,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const config = loadPushDeliveryConfig(configService);
        const provider = createPushProvider(config);
        new Logger('PushDeliveryModule').log(`Push provider: ${provider.name}${config.mode === 'firebase' ? ` (project ${config.firebaseProjectId}, initialized on first send)` : ''}`);
        return provider;
      },
    },
    {
      provide: DELIVERY_JOB_EXECUTOR,
      inject: [DataSource, PushDevicesService, PUSH_PROVIDER, NotificationPreferencesService],
      useFactory: (dataSource: DataSource, devices: PushDevicesService, provider: PushProvider, consent: NotificationPreferencesService): DeliveryJobExecutor =>
        new PushDispatchExecutor(dataSource, devices, provider, consent),
    },
    {
      provide: PushDeliveryWorker,
      inject: [DataSource, ConfigService, { token: DELIVERY_JOB_EXECUTOR, optional: true }],
      useFactory: (dataSource: DataSource, configService: ConfigService, executor?: DeliveryJobExecutor) => {
        const workerConfig = loadPushWorkerConfig(configService, loadPushDeliveryConfig(configService));
        return new PushDeliveryWorker(new PushJobStore(dataSource), workerConfig, executor ?? null);
      },
    },
  ],
  exports: [PushOutboxService, PUSH_PROVIDER],
})
export class PushDeliveryModule {}
