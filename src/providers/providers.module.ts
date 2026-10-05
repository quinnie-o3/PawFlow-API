import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ProviderStaff } from './entities/provider-staff.entity';
import { ProviderWorkingHour } from './entities/provider-working-hour.entity';
import { Provider } from './entities/provider.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Provider,
      ProviderStaff,
      ProviderWorkingHour,
    ]),
  ],
})
export class ProvidersModule {}