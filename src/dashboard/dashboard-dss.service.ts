import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { Booking } from '../bookings/entities/booking.entity';
import { Review } from '../reviews/entities/review.entity';
import { Service } from '../services/entities/service.entity';
import { DashboardQueryDto } from './dto/dashboard-query.dto';

const PEAK_HOUR_SHARE_THRESHOLD = 0.4;
const HIGH_CANCELLATION_THRESHOLD = 0.25;
const UNDERUSED_SERVICE_THRESHOLD = 0.3;
const FREQUENT_CUSTOMER_BOOKINGS = 3;
const LOW_RATING_THRESHOLD = 4;

type DashboardAlert = {
  code:
    | 'PEAK_HOUR_DEMAND'
    | 'HIGH_SERVICE_CANCELLATION'
    | 'UNDERUSED_SERVICE'
    | 'FREQUENT_RETURNING_CUSTOMER'
    | 'LOW_RATING';
  severity: 'INFO' | 'WARNING';
  message: string;
  recommendation: string;
  context: Record<string, string | number>;
};

@Injectable()
export class DashboardDssService {
  constructor(private readonly dataSource: DataSource) {}

  async getAlerts(
    providerId: string,
    query: DashboardQueryDto,
  ): Promise<DashboardAlert[]> {
    const [
      peakHourAlerts,
      cancellationAlerts,
      underusedServiceAlerts,
      frequentCustomerAlerts,
      lowRatingAlerts,
    ] = await Promise.all([
      this.getPeakHourAlerts(providerId, query.from, query.to),
      this.getHighCancellationAlerts(providerId, query.from, query.to),
      this.getUnderusedServiceAlerts(providerId, query.from, query.to),
      this.getFrequentCustomerAlerts(providerId, query.to),
      this.getLowRatingAlerts(providerId, query.to),
    ]);

    return [
      ...peakHourAlerts,
      ...cancellationAlerts,
      ...underusedServiceAlerts,
      ...frequentCustomerAlerts,
      ...lowRatingAlerts,
    ];
  }

  private async getPeakHourAlerts(
    providerId: string,
    from: string,
    to: string,
  ): Promise<DashboardAlert[]> {
    const bookingsRepository = this.dataSource.getRepository(Booking);
    const rows = await bookingsRepository
      .createQueryBuilder('booking')
      .innerJoin('booking.slot', 'slot')
      .select('slot.slotDate', 'date')
      .addSelect('COUNT(booking.id)', 'totalAcceptedBookings')
      .addSelect(
        "COUNT(booking.id) FILTER (WHERE slot.startTime >= :peakStart AND slot.startTime < :peakEnd)",
        'peakAcceptedBookings',
      )
      .where('booking.providerId = :providerId', { providerId })
      .andWhere('booking.status IN (:...acceptedStatuses)', {
        acceptedStatuses: ['CONFIRMED', 'COMPLETED', 'NO_SHOW'],
      })
      .andWhere('slot.slotDate BETWEEN :from AND :to', { from, to })
      .groupBy('slot.slotDate')
      .setParameters({ peakStart: '17:00:00', peakEnd: '20:00:00' })
      .orderBy('slot.slotDate', 'ASC')
      .getRawMany<{
        date: string;
        totalAcceptedBookings: string;
        peakAcceptedBookings: string;
      }>();

    return rows.flatMap((row) => {
      const totalAcceptedBookings = this.toSafeNumber(
        row.totalAcceptedBookings,
      );
      const peakAcceptedBookings = this.toSafeNumber(
        row.peakAcceptedBookings,
      );
      const share = peakAcceptedBookings / totalAcceptedBookings;

      if (totalAcceptedBookings === 0 || share <= PEAK_HOUR_SHARE_THRESHOLD) {
        return [];
      }

      return [
        {
          code: 'PEAK_HOUR_DEMAND',
          severity: 'WARNING',
          message: `${this.roundToTwoDecimals(share * 100)}% of accepted bookings on ${row.date} start between 17:00 and 20:00.`,
          recommendation:
            'Review staffing or slot availability during the identified peak period.',
          context: {
            date: row.date,
            peakAcceptedBookings,
            totalAcceptedBookings,
            percentage: this.roundToTwoDecimals(share * 100),
          },
        },
      ];
    });
  }

  private async getHighCancellationAlerts(
    providerId: string,
    from: string,
    to: string,
  ): Promise<DashboardAlert[]> {
    const bookingsRepository = this.dataSource.getRepository(Booking);
    const rows = await bookingsRepository
      .createQueryBuilder('booking')
      .innerJoin('booking.slot', 'slot')
      .innerJoin('booking.service', 'service')
      .select("TO_CHAR(slot.slotDate, 'YYYY-MM')", 'month')
      .addSelect('service.id', 'serviceId')
      .addSelect('service.name', 'serviceName')
      .addSelect('COUNT(booking.id)', 'resolvedBookings')
      .addSelect(
        "COUNT(booking.id) FILTER (WHERE booking.status = :cancelledStatus)",
        'cancelledBookings',
      )
      .where('booking.providerId = :providerId', { providerId })
      .andWhere('booking.status IN (:...resolvedStatuses)', {
        resolvedStatuses: ['COMPLETED', 'CANCELLED', 'NO_SHOW'],
      })
      .andWhere('slot.slotDate BETWEEN :from AND :to', { from, to })
      .groupBy("TO_CHAR(slot.slotDate, 'YYYY-MM')")
      .addGroupBy('service.id')
      .addGroupBy('service.name')
      .setParameter('cancelledStatus', 'CANCELLED')
      .orderBy("TO_CHAR(slot.slotDate, 'YYYY-MM')", 'ASC')
      .addOrderBy('service.name', 'ASC')
      .getRawMany<{
        month: string;
        serviceId: string;
        serviceName: string;
        resolvedBookings: string;
        cancelledBookings: string;
      }>();

    return rows.flatMap((row) => {
      const resolvedBookings = this.toSafeNumber(row.resolvedBookings);
      const cancelledBookings = this.toSafeNumber(row.cancelledBookings);
      const rate = cancelledBookings / resolvedBookings;

      if (resolvedBookings === 0 || rate <= HIGH_CANCELLATION_THRESHOLD) {
        return [];
      }

      return [
        {
          code: 'HIGH_SERVICE_CANCELLATION',
          severity: 'WARNING',
          message: `${row.serviceName} had a ${this.roundToTwoDecimals(rate * 100)}% cancellation rate in ${row.month}.`,
          recommendation:
            'Review pricing, duration, scheduling conditions, and recent feedback for this service.',
          context: {
            month: row.month,
            serviceId: row.serviceId,
            cancelledBookings,
            resolvedBookings,
            percentage: this.roundToTwoDecimals(rate * 100),
          },
        },
      ];
    });
  }

  private async getUnderusedServiceAlerts(
    providerId: string,
    from: string,
    to: string,
  ): Promise<DashboardAlert[]> {
    const servicesRepository = this.dataSource.getRepository(Service);
    const bookingsRepository = this.dataSource.getRepository(Booking);
    const [services, rows] = await Promise.all([
      servicesRepository.find({
        where: { providerId, status: 'ACTIVE' },
        select: { id: true, name: true, categoryId: true },
      }),
      bookingsRepository
        .createQueryBuilder('booking')
        .innerJoin('booking.slot', 'slot')
        .select("TO_CHAR(slot.slotDate, 'YYYY-MM')", 'month')
        .addSelect('booking.serviceId', 'serviceId')
        .addSelect('COUNT(booking.id)', 'completedBookings')
        .where('booking.providerId = :providerId', { providerId })
        .andWhere('booking.status = :completedStatus', {
          completedStatus: 'COMPLETED',
        })
        .andWhere('slot.slotDate BETWEEN :from AND :to', { from, to })
        .groupBy("TO_CHAR(slot.slotDate, 'YYYY-MM')")
        .addGroupBy('booking.serviceId')
        .getRawMany<{
          month: string;
          serviceId: string;
          completedBookings: string;
        }>(),
    ]);

    const countByMonthAndService = new Map(
      rows.map((row) => [
        `${row.month}:${row.serviceId}`,
        this.toSafeNumber(row.completedBookings),
      ]),
    );
    const alerts: DashboardAlert[] = [];

    for (const month of this.getCalendarMonths(from, to)) {
      const servicesByCategory = new Map<string, typeof services>();

      for (const service of services) {
        const categoryServices =
          servicesByCategory.get(service.categoryId) ?? [];
        categoryServices.push(service);
        servicesByCategory.set(service.categoryId, categoryServices);
      }

      for (const categoryServices of servicesByCategory.values()) {
        for (const service of categoryServices) {
          const otherServices = categoryServices.filter(
            (candidate) => candidate.id !== service.id,
          );

          if (otherServices.length === 0) {
            continue;
          }

          const completedBookings =
            countByMonthAndService.get(`${month}:${service.id}`) ?? 0;
          const otherAverage =
            otherServices.reduce(
              (sum, candidate) =>
                sum +
                (countByMonthAndService.get(
                  `${month}:${candidate.id}`,
                ) ?? 0),
              0,
            ) / otherServices.length;

          if (
            otherAverage === 0 ||
            completedBookings >=
              otherAverage * (1 - UNDERUSED_SERVICE_THRESHOLD)
          ) {
            continue;
          }

          alerts.push({
            code: 'UNDERUSED_SERVICE',
            severity: 'INFO',
            message: `${service.name} completed ${completedBookings} bookings in ${month}, more than 30% below comparable active services.`,
            recommendation:
              'Review promotion, bundling, pricing, or service presentation for this service.',
            context: {
              month,
              serviceId: service.id,
              completedBookings,
              comparisonAverage: this.roundToTwoDecimals(otherAverage),
            },
          });
        }
      }
    }

    return alerts;
  }

  private async getFrequentCustomerAlerts(
    providerId: string,
    to: string,
  ): Promise<DashboardAlert[]> {
    const bookingsRepository = this.dataSource.getRepository(Booking);
    const from = this.addCalendarMonths(to, -2);
    const rows = await bookingsRepository
      .createQueryBuilder('booking')
      .innerJoin('booking.slot', 'slot')
      .select('booking.customerId', 'customerId')
      .addSelect('COUNT(booking.id)', 'completedBookings')
      .where('booking.providerId = :providerId', { providerId })
      .andWhere('booking.status = :completedStatus', {
        completedStatus: 'COMPLETED',
      })
      .andWhere('slot.slotDate BETWEEN :from AND :to', { from, to })
      .groupBy('booking.customerId')
      .having('COUNT(booking.id) >= :minimumBookings', {
        minimumBookings: FREQUENT_CUSTOMER_BOOKINGS,
      })
      .orderBy('booking.customerId', 'ASC')
      .getRawMany<{ customerId: string; completedBookings: string }>();

    return rows.map((row) => ({
      code: 'FREQUENT_RETURNING_CUSTOMER' as const,
      severity: 'INFO' as const,
      message: `Customer ${row.customerId} completed at least ${FREQUENT_CUSTOMER_BOOKINGS} bookings in the previous two months.`,
      recommendation: 'Consider an appropriate retention action.',
      context: {
        customerId: row.customerId,
        completedBookings: this.toSafeNumber(row.completedBookings),
        from,
        to,
      },
    }));
  }

  private async getLowRatingAlerts(
    providerId: string,
    to: string,
  ): Promise<DashboardAlert[]> {
    const reviewsRepository = this.dataSource.getRepository(Review);
    const from = this.addDays(to, -29);
    const endExclusive = this.addDays(to, 1);
    const row = await reviewsRepository
      .createQueryBuilder('review')
      .innerJoin('review.booking', 'booking')
      .select('COUNT(review.id)', 'reviewCount')
      .addSelect('AVG(review.rating)', 'average')
      .where('booking.providerId = :providerId', { providerId })
      .andWhere('review.isVisible = :isVisible', { isVisible: true })
      .andWhere('review.createdAt >= :from', {
        from: `${from}T00:00:00.000Z`,
      })
      .andWhere('review.createdAt < :endExclusive', {
        endExclusive: `${endExclusive}T00:00:00.000Z`,
      })
      .getRawOne<{ reviewCount: string; average: string | null }>();

    const reviewCount = this.toSafeNumber(row?.reviewCount);
    const average = row?.average === null ? 0 : this.toSafeNumber(row?.average);

    if (reviewCount === 0 || average >= LOW_RATING_THRESHOLD) {
      return [];
    }

    return [
      {
        code: 'LOW_RATING',
        severity: 'WARNING',
        message: `Visible reviews averaged ${this.roundToTwoDecimals(average)} over the 30 days ending ${to}.`,
        recommendation: 'Review recent customer feedback.',
        context: {
          from,
          to,
          reviewCount,
          average: this.roundToTwoDecimals(average),
        },
      },
    ];
  }

  private getCalendarMonths(from: string, to: string): string[] {
    const months: string[] = [];
    const current = new Date(`${from.slice(0, 7)}-01T00:00:00.000Z`);
    const last = new Date(`${to.slice(0, 7)}-01T00:00:00.000Z`);

    while (current <= last) {
      months.push(current.toISOString().slice(0, 7));
      current.setUTCMonth(current.getUTCMonth() + 1);
    }

    return months;
  }

  private addCalendarMonths(date: string, months: number): string {
    const [year, month, day] = date.split('-').map(Number);
    const targetMonthIndex = month - 1 + months;
    const targetYear = year + Math.floor(targetMonthIndex / 12);
    const targetMonth = ((targetMonthIndex % 12) + 12) % 12;
    const lastDayOfTargetMonth = new Date(
      Date.UTC(targetYear, targetMonth + 1, 0),
    ).getUTCDate();
    const targetDay = Math.min(day, lastDayOfTargetMonth);

    return `${targetYear}-${String(targetMonth + 1).padStart(2, '0')}-${String(targetDay).padStart(2, '0')}`;
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
}
