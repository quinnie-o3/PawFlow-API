import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { DashboardController } from './dashboard.controller';
import { DashboardDssService } from './dashboard-dss.service';
import { DashboardService } from './dashboard.service';

@Module({
  imports: [AuthModule],
  controllers: [DashboardController],
  providers: [DashboardService, DashboardDssService],
  exports: [DashboardService],
})
export class DashboardModule {}
