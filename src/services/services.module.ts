import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { Provider } from '../providers/entities/provider.entity';
import { ServiceCategory } from './entities/service-category.entity';
import { Service } from './entities/service.entity';
import { PublicServicesController } from './public-services.controller';
import { ServicesService } from './services.service';
import { ServiceCategoriesController } from './service-categories.controller';
import { ServicesController } from './services.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Service,
      ServiceCategory,
      Provider,
    ]),
    AuthModule,
  ],
  controllers: [
    ServicesController,
    PublicServicesController,
    ServiceCategoriesController,
  ],
  providers: [ServicesService],
  exports: [ServicesService],
})
export class ServicesModule {}