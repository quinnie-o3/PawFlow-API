import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';

import { Booking } from '../bookings/entities/booking.entity';
import { Payment } from '../payments/entities/payment.entity';
import { Provider } from '../providers/entities/provider.entity';
import { Review } from '../reviews/entities/review.entity';
import { DashboardQueryDto } from './dto/dashboard-query.dto';
import { DashboardDssService } from './dashboard-dss.service';

type BookingStatus =
  | 'PENDING_CONFIRMATION'
  | 'CONFIRMED'
  | 'REJECTED'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'NO_SHOW';

type BookingVolumeByStatus = Record<BookingStatus, number> & {
  total: number;
};

type DateRange = {
  start: string;
  endExclusive: string;
};

@Injectable()
export class DashboardService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly dashboardDssService: DashboardDssService,
  ) {}

  async getProviderDashboard(
    ownerUserId: string,
    query: DashboardQueryDto,
  ) {
    this.validateReportingPeriod(query);

    const provider = await this.getOwnedProvider(ownerUserId);

    const [
      bookingVolumeByStatus,
      popularServices,
      returningCustomers,
      recordedRevenue,
      averageRating,
      alerts,
    ] = await Promise.all([
      this.getBookingVolumeByStatus(
        provider.id,
        query.from,
        query.to,
      ),
      this.getPopularServices(provider.id, query.from, query.to),
      this.getReturningCustomers(provider.id, query.from, query.to),
      this.getRecordedRevenue(provider.id, query.from, query.to),
      this.getAverageRating(provider.id, query.from, query.to),
      this.dashboardDssService.getAlerts(provider.id, query),
    ]);

    const resolvedBookings =
      bookingVolumeByStatus.COMPLETED +
      bookingVolumeByStatus.CANCELLED +
      bookingVolumeByStatus.NO_SHOW;

    return {
      providerId: provider.id,
      period: {
        from: query.from,
        to: query.to,
      },
      bookingVolumeByStatus,
      cancellationRate: {
        cancelledBookings: bookingVolumeByStatus.CANCELLED,
        resolvedBookings,
        rate:
          resolvedBookings === 0
            ? null
            : this.roundToTwoDecimals(
                (bookingVolumeByStatus.CANCELLED / resolvedBookings) * 100,
              ),
      },
      popularServices,
      returningCustomers,
      recordedRevenue,
      averageRating,
      alerts,
    };
  }

  private async getOwnedProvider(
    ownerUserId: string,
  ): Promise<Provider> {
    const providersRepository =
      this.dataSource.getRepository(Provider);

    const provider = await providersRepository.findOne({
      where: {
        ownerId: ownerUserId,
      },
    });

    if (!provider) {
      throw new NotFoundException(
        'Provider profile not found',
      );
    }

    return provider;
  }

  private async getBookingVolumeByStatus(
    providerId: string,
    from: string,
    to: string,
  ): Promise<BookingVolumeByStatus> {
    const bookingsRepository =
      this.dataSource.getRepository(Booking);

    const rows = await bookingsRepository
      .createQueryBuilder('booking')
      .innerJoin('booking.slot', 'slot')
      .select('booking.status', 'status')
      .addSelect('COUNT(booking.id)', 'count')
      .where('booking.providerId = :providerId', {
        providerId,
      })
      .andWhere(
        'slot.slotDate BETWEEN :from AND :to',
        {
          from,
          to,
        },
      )
      .groupBy('booking.status')
      .getRawMany<{
        status: BookingStatus;
        count: string;
      }>();

    const result: BookingVolumeByStatus = {
      PENDING_CONFIRMATION: 0,
      CONFIRMED: 0,
      REJECTED: 0,
      COMPLETED: 0,
      CANCELLED: 0,
      NO_SHOW: 0,
      total: 0,
    };

    for (const row of rows) {
      const count = Number(row.count);

      result[row.status] = count;
      result.total += count;
    }

    return result;
  }

  private async getPopularServices(
    providerId: string,
    from: string,
    to: string,
  ) {
    const bookingsRepository = this.dataSource.getRepository(Booking);

    const rows = await bookingsRepository
      .createQueryBuilder('booking')
      .innerJoin('booking.slot', 'slot')
      .innerJoin('booking.service', 'service')
      .select('service.id', 'serviceId')
      .addSelect('service.name', 'serviceName')
      .addSelect('COUNT(booking.id)', 'completedBookings')
      .where('booking.providerId = :providerId', { providerId })
      .andWhere('booking.status = :completedStatus', {
        completedStatus: 'COMPLETED',
      })
      .andWhere('slot.slotDate BETWEEN :from AND :to', { from, to })
      .groupBy('service.id')
      .addGroupBy('service.name')
      .orderBy('COUNT(booking.id)', 'DESC')
      .addOrderBy('service.name', 'ASC')
      .addOrderBy('service.id', 'ASC')
      .getRawMany<{
        serviceId: string;
        serviceName: string;
        completedBookings: string;
      }>();

    return rows.map((row) => ({
      serviceId: row.serviceId,
      serviceName: row.serviceName,
      completedBookings: this.toSafeNumber(row.completedBookings),
    }));
  }

  private async getReturningCustomers(
    providerId: string,
    from: string,
    to: string,
  ) {
    const bookingsRepository = this.dataSource.getRepository(Booking);

    const row = await bookingsRepository
      .createQueryBuilder('booking')
      .innerJoin('booking.slot', 'slot')
      .select('COUNT(DISTINCT booking.customerId)', 'count')
      .where('booking.providerId = :providerId', { providerId })
      .andWhere('booking.status = :completedStatus', {
        completedStatus: 'COMPLETED',
      })
      .andWhere('slot.slotDate BETWEEN :from AND :to', { from, to })
      .andWhere((queryBuilder) => {
        const earlierBooking = queryBuilder
          .subQuery()
          .select('1')
          .from(Booking, 'earlierBooking')
          .innerJoin('earlierBooking.slot', 'earlierSlot')
          .where('earlierBooking.providerId = :providerId')
          .andWhere('earlierBooking.customerId = booking.customerId')
          .andWhere('earlierBooking.status = :completedStatus')
          .andWhere(
            '(earlierSlot.slotDate < slot.slotDate OR (earlierSlot.slotDate = slot.slotDate AND earlierSlot.startTime < slot.startTime))',
          )
          .getQuery();

        return `EXISTS ${earlierBooking}`;
      })
      .getRawOne<{ count: string }>();

    return { count: this.toSafeNumber(row?.count) };
  }

  private async getRecordedRevenue(
    providerId: string,
    from: string,
    to: string,
  ) {
    const paymentsRepository = this.dataSource.getRepository(Payment);
    const period = this.getHalfOpenPeriod(from, to);

    const row = await paymentsRepository
      .createQueryBuilder('payment')
      .innerJoin('payment.booking', 'booking')
      .select('COALESCE(SUM(payment.amount), 0)', 'amount')
      .where('booking.providerId = :providerId', { providerId })
      .andWhere('booking.status = :completedStatus', {
        completedStatus: 'COMPLETED',
      })
      .andWhere('payment.paymentStatus = :paidStatus', {
        paidStatus: 'PAID',
      })
      .andWhere('payment.paidAt >= :start', { start: period.start })
      .andWhere('payment.paidAt < :endExclusive', {
        endExclusive: period.endExclusive,
      })
      .getRawOne<{ amount: string }>();

    return { amount: this.formatAmount(row?.amount) };
  }

  private async getAverageRating(
    providerId: string,
    from: string,
    to: string,
  ) {
    const reviewsRepository = this.dataSource.getRepository(Review);
    const period = this.getHalfOpenPeriod(from, to);

    const row = await reviewsRepository
      .createQueryBuilder('review')
      .innerJoin('review.booking', 'booking')
      .select('COUNT(review.id)', 'count')
      .addSelect('AVG(review.rating)', 'average')
      .where('booking.providerId = :providerId', { providerId })
      .andWhere('review.isVisible = :isVisible', { isVisible: true })
      .andWhere('review.createdAt >= :start', { start: period.start })
      .andWhere('review.createdAt < :endExclusive', {
        endExclusive: period.endExclusive,
      })
      .getRawOne<{ count: string; average: string | null }>();

    const reviewCount = this.toSafeNumber(row?.count);

    return {
      reviewCount,
      average:
        reviewCount === 0 || row?.average === null || row?.average === undefined
          ? null
          : this.roundToTwoDecimals(this.toSafeNumber(row.average)),
    };
  }

  private validateReportingPeriod(
    query: DashboardQueryDto,
  ): void {
    if (query.from > query.to) {
      throw new BadRequestException(
        'The reporting period start date must not be after the end date',
      );
    }
  }

  private getHalfOpenPeriod(from: string, to: string): DateRange {
    return {
      start: `${from}T00:00:00.000Z`,
      endExclusive: `${this.addDays(to, 1)}T00:00:00.000Z`,
    };
  }

  private addDays(date: string, days: number): string {
    const value = new Date(`${date}T00:00:00.000Z`);
    value.setUTCDate(value.getUTCDate() + days);

    return value.toISOString().slice(0, 10);
  }

  private toSafeNumber(value: string | number | undefined): number {
    const numberValue = Number(value ?? 0);

    return Number.isFinite(numberValue) ? numberValue : 0;
  }

  private roundToTwoDecimals(value: number): number {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }

  private formatAmount(value: string | undefined): string {
    const amount = value ?? '0';
    const [whole, fractional = ''] = amount.split('.');

    return `${whole}.${`${fractional}00`.slice(0, 2)}`;
  }
}
