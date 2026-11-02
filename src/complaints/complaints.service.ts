import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, In } from 'typeorm';

import { Booking } from '../bookings/entities/booking.entity';
import { CreateComplaintDto } from './dto/create-complaint.dto';
import { Complaint } from './entities/complaint.entity';

/** Booking states in which a customer may raise a complaint (C-05 A). */
export const COMPLAINT_ELIGIBLE_BOOKING_STATUSES: ReadonlyArray<
  Booking['status']
> = ['CONFIRMED', 'COMPLETED', 'CANCELLED', 'REJECTED', 'NO_SHOW'];

/** Complaint states that count as "active" for a booking (C-05 B). */
export const ACTIVE_COMPLAINT_STATUSES: ReadonlyArray<Complaint['status']> = [
  'OPEN',
  'IN_REVIEW',
];

@Injectable()
export class ComplaintsService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Creates an OPEN complaint for the customer's own booking.
   *
   * Runs in one transaction holding a `pessimistic_write` lock on the
   * booking row, so concurrent submissions for the same booking serialize:
   * the second request sees the first complaint and receives 409 instead of
   * creating a duplicate active complaint (C-05 C). Any failure rolls back.
   */
  async createComplaint(
    customerId: string,
    bookingId: string,
    dto: CreateComplaintDto,
  ) {
    return this.dataSource.transaction(async (manager) => {
      const booking = await manager
        .getRepository(Booking)
        .createQueryBuilder('booking')
        .setLock('pessimistic_write')
        .where('booking.id = :bookingId', { bookingId })
        .getOne();

      // C-01: another customer's booking is indistinguishable from a
      // missing one.
      if (!booking || booking.customerId !== customerId) {
        throw new NotFoundException('Booking not found');
      }

      if (!COMPLAINT_ELIGIBLE_BOOKING_STATUSES.includes(booking.status)) {
        throw new ConflictException(
          `A complaint cannot be created for a booking in ${booking.status} status`,
        );
      }

      const complaintsRepository = manager.getRepository(Complaint);

      const activeComplaint = await complaintsRepository.findOne({
        where: {
          bookingId: booking.id,
          status: In([...ACTIVE_COMPLAINT_STATUSES]),
        },
      });

      if (activeComplaint) {
        throw new ConflictException(
          'An active complaint already exists for this booking',
        );
      }

      const complaint = complaintsRepository.create({
        bookingId: booking.id,
        createdBy: customerId,
        reason: dto.reason,
        status: 'OPEN',
        adminNote: null,
        resolvedBy: null,
        resolvedAt: null,
      });

      return complaintsRepository.save(complaint);
    });
  }

  async getMyComplaints(customerId: string) {
    const complaintsRepository =
      this.dataSource.getRepository(Complaint);

    return complaintsRepository.find({
      where: { createdBy: customerId },
      order: {
        createdAt: 'DESC',
      },
    });
  }

  async getMyComplaintById(
    customerId: string,
    complaintId: string,
  ) {
    const complaintsRepository =
      this.dataSource.getRepository(Complaint);

    // Scoped to the caller: another customer's complaint is
    // indistinguishable from a missing one (C-01).
    const complaint = await complaintsRepository.findOne({
      where: { id: complaintId, createdBy: customerId },
    });

    if (!complaint) {
      throw new NotFoundException('Complaint not found');
    }

    return complaint;
  }
}
