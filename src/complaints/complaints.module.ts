import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Complaint } from './entities/complaint.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Complaint])],
})
export class ComplaintsModule {}