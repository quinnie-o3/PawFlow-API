import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, QueryFailedError } from 'typeorm';

import { Booking } from '../bookings/entities/booking.entity';
import { Provider } from '../providers/entities/provider.entity';
import { UpdatePaymentDto } from './dto/update-payment.dto';
import { Payment } from './entities/payment.entity';

@Injectable()
export class PaymentsService {
  constructor(private readonly dataSource: DataSource) {}

  async upsertProviderPayment(
    ownerUserId: string,
    bookingId: string,
    dto: UpdatePaymentDto,
  ) {
    try {
      return await this.dataSource.transaction(async (manager) => {
        const providersRepository = manager.getRepository(Provider);
        const bookingsRepository = manager.getRepository(Booking);
        const paymentsRepository = manager.getRepository(Payment);

        const provider = await providersRepository.findOne({
          where: { ownerId: ownerUserId },
        });

        if (!provider) {
          throw new NotFoundException('Provider profile not found');
        }

        const booking = await bookingsRepository
          .createQueryBuilder('booking')
          .setLock('pessimistic_write')
          .where('booking.id = :bookingId', { bookingId })
          .getOne();

        if (!booking) {
          throw new NotFoundException('Booking not found');
        }

        if (booking.providerId !== provider.id) {
          throw new ForbiddenException(
            'You do not have permission to manage payment for this booking',
          );
        }

        if (booking.status !== 'COMPLETED') {
          throw new ConflictException(
            'Payment status can only be managed for completed bookings',
          );
        }

        let payment = await paymentsRepository.findOne({
          where: { bookingId: booking.id },
        });

        const paidAt =
          dto.paymentStatus === 'PAID' ? new Date() : null;

        if (!payment) {
          payment = paymentsRepository.create({
            bookingId: booking.id,
            amount: booking.bookedPrice,
            method: dto.method ?? null,
            paymentStatus: dto.paymentStatus,
            paidAt,
          });

          return paymentsRepository.save(payment);
        }

        payment.amount = booking.bookedPrice;
        payment.paymentStatus = dto.paymentStatus;

        if (dto.method !== undefined) {
          payment.method = dto.method;
        }

        // A repeated PAID update must retain its original payment timestamp.
        payment.paidAt =
          dto.paymentStatus === 'PAID' ? payment.paidAt ?? paidAt : null;

        return paymentsRepository.save(payment);
      });
    } catch (error) {
      // The booking row lock prevents normal endpoint races, but the database
      // UNIQUE constraint remains the final guard against duplicate records.
      if (error instanceof QueryFailedError) {
        const driverError = error.driverError as { code?: string };

        if (driverError.code === '23505') {
          throw new ConflictException(
            'A payment record already exists for this booking',
          );
        }
      }

      throw error;
    }
  }

  async getProviderPaymentByBookingId(
    ownerUserId: string,
    bookingId: string,
  ) {
    const providersRepository =
      this.dataSource.getRepository(Provider);
    const bookingsRepository =
      this.dataSource.getRepository(Booking);
    const paymentsRepository =
      this.dataSource.getRepository(Payment);

    const provider = await providersRepository.findOne({
      where: { ownerId: ownerUserId },
    });

    if (!provider) {
      throw new NotFoundException('Provider profile not found');
    }

    const booking = await bookingsRepository.findOne({
      where: { id: bookingId },
    });

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    if (booking.providerId !== provider.id) {
      throw new ForbiddenException(
        'You do not have permission to access payment for this booking',
      );
    }

    const payment = await paymentsRepository.findOne({
      where: { bookingId: booking.id },
    });

    if (!payment) {
      throw new NotFoundException(
        'Payment record was not found for this booking',
      );
    }

    return payment;
  }

  async getProviderPayments(ownerUserId: string) {
    const providersRepository =
      this.dataSource.getRepository(Provider);
    const paymentsRepository =
      this.dataSource.getRepository(Payment);

    const provider = await providersRepository.findOne({
      where: { ownerId: ownerUserId },
    });

    if (!provider) {
      throw new NotFoundException('Provider profile not found');
    }

    return paymentsRepository
      .createQueryBuilder('payment')
      .innerJoin('payment.booking', 'booking')
      .where('booking.providerId = :providerId', {
        providerId: provider.id,
      })
      .orderBy('payment.createdAt', 'DESC')
      .getMany();
  }
}
