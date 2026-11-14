import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { ProviderStaff } from './entities/provider-staff.entity';
import { ProviderWorkingHour } from './entities/provider-working-hour.entity';
import { Provider } from './entities/provider.entity';
import { ProvidersController } from './providers.controller';
import { ProvidersService } from './providers.service';
import { PublicProvidersController } from './public-providers.controller';
import { PublicProvidersService } from './public-providers.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Provider,
      ProviderStaff,
      ProviderWorkingHour,
    ]),
    AuthModule,
  ],
  controllers: [ProvidersController, PublicProvidersController],
  providers: [ProvidersService, PublicProvidersService],
  exports: [ProvidersService],
})
export class ProvidersModule {}