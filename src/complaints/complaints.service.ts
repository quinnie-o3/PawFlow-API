import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';

import { Booking } from '../bookings/entities/booking.entity';
import { CreateComplaintDto } from './dto/create-complaint.dto';
import { Complaint } from './entities/complaint.entity';

@Injectable()
export class ComplaintsService {
  constructor(private readonly dataSource: DataSource) {}

  async createComplaint(
    customerId: string,
    bookingId: string,
    dto: CreateComplaintDto,
  ) {
    const bookingsRepository =
      this.dataSource.getRepository(Booking);

    const complaintsRepository =
      this.dataSource.getRepository(Complaint);

    const booking = await bookingsRepository.findOne({
      where: { id: bookingId },
    });

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    if (booking.customerId !== customerId) {
      throw new ForbiddenException(
        'You do not have permission to create a complaint for this booking',
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

    const complaint = await complaintsRepository.findOne({
      where: { id: complaintId },
    });

    if (!complaint) {
      throw new NotFoundException('Complaint not found');
    }

    if (complaint.createdBy !== customerId) {
      throw new ForbiddenException(
        'You do not have permission to access this complaint',
      );
    }

    return complaint;
  }
}