import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { Review } from './entities/review.entity';
import { ProviderReviewsController } from './provider-reviews.controller';
import { ProviderReviewsService } from './provider-reviews.service';
import { ReviewQueriesController } from './review-queries.controller';
import { ReviewsController } from './reviews.controller';
import { ReviewsService } from './reviews.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Review]),
    AuthModule,
  ],
  controllers: [ReviewsController, ReviewQueriesController, ProviderReviewsController],
  providers: [ReviewsService, ProviderReviewsService],
  exports: [ReviewsService],
})
export class ReviewsModule {}