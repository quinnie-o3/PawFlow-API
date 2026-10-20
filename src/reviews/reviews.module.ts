import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { Review } from './entities/review.entity';
import { ReviewQueriesController } from './review-queries.controller';
import { ReviewsController } from './reviews.controller';
import { ReviewsService } from './reviews.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Review]),
    AuthModule,
  ],
  controllers: [ReviewsController, ReviewQueriesController],
  providers: [ReviewsService],
  exports: [ReviewsService],
})
export class ReviewsModule {}