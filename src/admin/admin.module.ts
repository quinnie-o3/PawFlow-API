import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { AdminActivityLogsController } from './admin-activity-logs.controller';
import { AdminComplaintsController } from './admin-complaints.controller';
import { AdminPetTypesController } from './admin-pet-types.controller';
import { AdminServiceCategoriesController } from './admin-service-categories.controller';
import { AdminStatisticsController } from './admin-statistics.controller';
import { AdminUsersController } from './admin-users.controller';
import { Provider } from '../providers/entities/provider.entity';
import { AdminActivityLogService } from './admin-activity-log.service';
import { AdminController } from './admin.controller';
import { AdminMasterDataService } from './admin-master-data.service';
import { AdminReviewsController } from './admin-reviews.controller';
import { AdminService } from './admin.service';
import { AdminStatisticsService } from './admin-statistics.service';
import { AdminUsersService } from './admin-users.service';
import { AdminActivityLog } from './entities/admin-activity-log.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Provider, AdminActivityLog]), AuthModule],
  controllers: [
    AdminController,
    AdminActivityLogsController,
    AdminReviewsController,
    AdminComplaintsController,
    AdminServiceCategoriesController,
    AdminPetTypesController,
    AdminStatisticsController,
    AdminUsersController,
  ],
  providers: [
    AdminActivityLogService,
    AdminService,
    AdminMasterDataService,
    AdminStatisticsService,
    AdminUsersService,
  ],
})
export class AdminModule {}
