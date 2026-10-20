import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, QueryFailedError } from 'typeorm';

import { Booking } from '../bookings/entities/booking.entity';
import { Provider } from '../providers/entities/provider.entity';
import { CreateReviewDto } from './dto/create-review.dto';
import { Review } from './entities/review.entity';

@Injectable()
export class ReviewsService {
  constructor(private readonly dataSource: DataSource) {}

  async createReview(
    customerId: string,
    bookingId: string,
    dto: CreateReviewDto,
  ) {
    try {
      return await this.dataSource.transaction(async (manager) => {
        const bookingsRepository = manager.getRepository(Booking);
        const reviewsRepository = manager.getRepository(Review);
        const providersRepository = manager.getRepository(Provider);

        // Lock the booking so two concurrent review requests for the same
        // booking cannot both pass the eligibility checks.
        const booking = await bookingsRepository
          .createQueryBuilder('booking')
          .setLock('pessimistic_write')
          .where('booking.id = :bookingId', { bookingId })
          .getOne();

        if (!booking) {
          throw new NotFoundException('Booking not found');
        }

        if (booking.customerId !== customerId) {
          throw new ForbiddenException(
            'You do not have permission to review this booking',
          );
        }

        if (booking.status !== 'COMPLETED') {
          throw new ConflictException(
            'Only completed bookings can be reviewed',
          );
        }

        const existingReview = await reviewsRepository.findOne({
          where: { bookingId: booking.id },
        });

        if (existingReview) {
          throw new ConflictException(
            'A review has already been submitted for this booking',
          );
        }

        // Lock the provider while updating aggregate rating values.
        // This prevents lost updates when different customers review
        // different bookings of the same provider concurrently.
        const provider = await providersRepository
          .createQueryBuilder('provider')
          .setLock('pessimistic_write')
          .where('provider.id = :providerId', {
            providerId: booking.providerId,
          })
          .getOne();

        if (!provider) {
          throw new NotFoundException('Provider not found');
        }

        const review = reviewsRepository.create({
          bookingId: booking.id,
          rating: dto.rating,
          comment: dto.comment ?? null,
          providerResponse: null,
          respondedBy: null,
          respondedAt: null,
          isVisible: true,
        });

        const savedReview = await reviewsRepository.save(review);

        // Recalculate from review rows rather than from the rounded value
        // stored in Provider.ratingAvg, which would otherwise accumulate
        // rounding drift over time.
        const ratingStats = await reviewsRepository
          .createQueryBuilder('review')
          .select('COUNT(review.id)', 'count')
          .addSelect('COALESCE(AVG(review.rating), 0)', 'average')
          .innerJoin('review.booking', 'booking')
          .where('booking.providerId = :providerId', {
            providerId: provider.id,
          })
          .andWhere('review.isVisible = :isVisible', {
            isVisible: true,
          })
          .getRawOne<{ count: string; average: string }>();

        provider.ratingCount = Number(ratingStats?.count ?? 0);
        provider.ratingAvg = Number(ratingStats?.average ?? 0).toFixed(2);

        await providersRepository.save(provider);

        return savedReview;
      });
    } catch (error) {
      // Database UNIQUE(booking_id) is the final protection against
      // duplicate reviews.
      if (error instanceof QueryFailedError) {
        const driverError = error.driverError as {
          code?: string;
        };

        if (driverError.code === '23505') {
          throw new ConflictException(
            'A review has already been submitted for this booking',
          );
        }
      }

      throw error;
    }
  }

  async getMyReviews(customerId: string) {
    const reviewsRepository = this.dataSource.getRepository(Review);

    return reviewsRepository
      .createQueryBuilder('review')
      .innerJoin('review.booking', 'booking')
      .where('booking.customerId = :customerId', { customerId })
      .orderBy('review.createdAt', 'DESC')
      .getMany();
  }

  async getPublicProviderReviews(providerId: string) {
    const providersRepository = this.dataSource.getRepository(Provider);
    const reviewsRepository = this.dataSource.getRepository(Review);

    const provider = await providersRepository.findOne({
      where: { id: providerId },
    });

    if (!provider) {
      throw new NotFoundException('Provider not found');
    }

    return reviewsRepository
      .createQueryBuilder('review')
      .select([
        'review.id',
        'review.rating',
        'review.comment',
        'review.providerResponse',
        'review.respondedAt',
        'review.createdAt',
      ])
      .innerJoin('review.booking', 'booking')
      .where('booking.providerId = :providerId', { providerId })
      .andWhere('review.isVisible = :isVisible', {
        isVisible: true,
      })
      .orderBy('review.createdAt', 'DESC')
      .getMany();
  }
}
