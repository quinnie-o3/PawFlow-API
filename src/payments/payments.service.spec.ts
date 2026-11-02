import { ConflictException, NotFoundException } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { Booking } from '../bookings/entities/booking.entity';
import { Provider } from '../providers/entities/provider.entity';
import { Payment } from './entities/payment.entity';
import { PaymentsService } from './payments.service';

describe('PaymentsService.upsertProviderPayment', () => {
  const ownerUserId = '10';
  const provider = { id: '1', ownerId: ownerUserId } as Provider;

  let booking: Partial<Booking>;
  let existingPayment: Payment | null;
  let paymentsRepository: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let service: PaymentsService;

  beforeEach(() => {
    booking = {
      id: '20',
      providerId: provider.id,
      status: 'COMPLETED',
      bookedPrice: '150000.00',
    };
    existingPayment = null;

    const bookingQueryBuilder = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn(() => Promise.resolve(booking)),
    };

    paymentsRepository = {
      findOne: jest.fn(() => Promise.resolve(existingPayment)),
      create: jest.fn((value: Partial<Payment>) => ({ ...value })),
      save: jest.fn((value: Payment) => Promise.resolve(value)),
    };

    const repositories = new Map<unknown, unknown>([
      [Provider, { findOne: jest.fn().mockResolvedValue(provider) }],
      [
        Booking,
        { createQueryBuilder: jest.fn().mockReturnValue(bookingQueryBuilder) },
      ],
      [Payment, paymentsRepository],
    ]);
    const manager = {
      getRepository: jest.fn((entity: unknown) => repositories.get(entity)),
    };
    const dataSource = {
      transaction: jest.fn((work: (m: typeof manager) => unknown) =>
        work(manager),
      ),
    };

    service = new PaymentsService(dataSource as unknown as DataSource);
  });

  describe('creating a payment', () => {
    it('persists a non-null paidAt for PAID', async () => {
      const payment = await service.upsertProviderPayment(ownerUserId, '20', {
        paymentStatus: 'PAID',
        method: 'CASH',
      });

      expect(payment.paidAt).toBeInstanceOf(Date);
      expect(paymentsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ paidAt: expect.any(Date) }),
      );
    });

    it.each(['UNPAID', 'FAILED'] as const)(
      'persists paidAt null for %s',
      async (paymentStatus) => {
        const payment = await service.upsertProviderPayment(
          ownerUserId,
          '20',
          { paymentStatus },
        );

        expect(payment.paidAt).toBeNull();
        expect(payment.method).toBeNull();
      },
    );

    it('derives amount from the booked price', async () => {
      const payment = await service.upsertProviderPayment(ownerUserId, '20', {
        paymentStatus: 'UNPAID',
      });

      expect(payment.amount).toBe('150000.00');
    });
  });

  describe('updating an existing payment', () => {
    const originalPaidAt = new Date('2026-10-01T10:00:00.000Z');

    const payment = (overrides: Partial<Payment>): Payment =>
      ({
        id: '30',
        bookingId: '20',
        amount: '150000.00',
        method: null,
        paymentStatus: 'UNPAID',
        paidAt: null,
        ...overrides,
      }) as Payment;

    it('sets paidAt on UNPAID -> PAID', async () => {
      existingPayment = payment({ paymentStatus: 'UNPAID' });

      const result = await service.upsertProviderPayment(ownerUserId, '20', {
        paymentStatus: 'PAID',
      });

      expect(result.paymentStatus).toBe('PAID');
      expect(result.paidAt).toBeInstanceOf(Date);
    });

    it('keeps the original paidAt on a repeated PAID update', async () => {
      existingPayment = payment({
        paymentStatus: 'PAID',
        paidAt: originalPaidAt,
      });

      const result = await service.upsertProviderPayment(ownerUserId, '20', {
        paymentStatus: 'PAID',
      });

      expect(result.paidAt).toBe(originalPaidAt);
    });

    it.each(['UNPAID', 'FAILED'] as const)(
      'clears paidAt on PAID -> %s',
      async (paymentStatus) => {
        existingPayment = payment({
          paymentStatus: 'PAID',
          paidAt: originalPaidAt,
        });

        const result = await service.upsertProviderPayment(
          ownerUserId,
          '20',
          { paymentStatus },
        );

        expect(result.paidAt).toBeNull();
      },
    );

    it('re-derives amount from the booked price', async () => {
      existingPayment = payment({ amount: '1.00' });

      const result = await service.upsertProviderPayment(ownerUserId, '20', {
        paymentStatus: 'UNPAID',
      });

      expect(result.amount).toBe('150000.00');
    });
  });

  describe('existing guards', () => {
    it('hides a booking owned by another provider with the same 404 as a missing one (C-01)', async () => {
      booking.providerId = '999';

      await expect(
        service.upsertProviderPayment(ownerUserId, '20', {
          paymentStatus: 'PAID',
        }),
      ).rejects.toThrow(new NotFoundException('Booking not found'));
      expect(paymentsRepository.save).not.toHaveBeenCalled();
    });

    it('rejects a booking that is not COMPLETED with 409', async () => {
      booking.status = 'CONFIRMED';

      await expect(
        service.upsertProviderPayment(ownerUserId, '20', {
          paymentStatus: 'PAID',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(paymentsRepository.save).not.toHaveBeenCalled();
    });
  });
});
