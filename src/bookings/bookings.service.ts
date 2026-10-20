import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { AvailabilitySlot } from '../availability/entities/availability-slot.entity';
import { Pet } from '../pets/entities/pet.entity';
import { Provider } from '../providers/entities/provider.entity';
import { ProviderStaff } from '../providers/entities/provider-staff.entity';
import { Service } from '../services/entities/service.entity';
import { CancelBookingDto } from './dto/cancel-booking.dto';
import { CreateBookingDto } from './dto/create-booking.dto';
import { NoShowBookingDto } from './dto/no-show-booking.dto';
import { RejectBookingDto } from './dto/reject-booking.dto';
import { BookingStatusLog } from './entities/booking-status-log.entity';
import { Booking } from './entities/booking.entity';

@Injectable()
export class BookingsService {
  constructor(private readonly dataSource: DataSource) {}

  async createBooking(customerId: string, dto: CreateBookingDto) {
    return this.dataSource.transaction(async (manager) => {
      const bookingsRepository = manager.getRepository(Booking);
      const bookingLogsRepository =
        manager.getRepository(BookingStatusLog);
      const petsRepository = manager.getRepository(Pet);
      const slotsRepository =
        manager.getRepository(AvailabilitySlot);
      const servicesRepository = manager.getRepository(Service);
      const providersRepository = manager.getRepository(Provider);

      // Lock the slot until the transaction finishes so concurrent bookings
      // cannot consume its last capacity at the same time.
      const slot = await slotsRepository
        .createQueryBuilder('slot')
        .setLock('pessimistic_write')
        .where('slot.id = :slotId', { slotId: dto.slotId })
        .getOne();

      if (!slot) {
        throw new NotFoundException('Availability slot not found');
      }

      if (slot.status !== 'OPEN') {
        throw new ConflictException(
          'Availability slot is not open for booking',
        );
      }

      if (slot.bookedCount >= slot.capacity) {
        throw new ConflictException('Availability slot is full');
      }

      const pet = await petsRepository.findOne({
        where: {
          id: dto.petId,
          ownerId: customerId,
          status: 'ACTIVE',
        },
      });

      if (!pet) {
        throw new NotFoundException(
          'Active pet belonging to the customer was not found',
        );
      }

      const service = await servicesRepository.findOne({
        where: {
          id: slot.serviceId,
          providerId: slot.providerId,
        },
        relations: {
          category: true,
        },
      });

      if (!service) {
        throw new NotFoundException(
          'Service for this availability slot was not found',
        );
      }

      if (service.status !== 'ACTIVE') {
        throw new BadRequestException(
          'The selected service is not active',
        );
      }

      if (service.category.status !== 'ACTIVE') {
        throw new BadRequestException(
          'The selected service category is not active',
        );
      }

      const provider = await providersRepository.findOne({
        where: { id: slot.providerId },
      });

      if (!provider) {
        throw new NotFoundException('Provider not found');
      }

      if (provider.approvalStatus !== 'APPROVED') {
        throw new BadRequestException(
          'The selected provider is not approved for booking',
        );
      }

      this.assertSlotNotInPast(slot);

      const booking = bookingsRepository.create({
        customerId,
        petId: pet.id,
        // Never trust these values from the client.
        providerId: slot.providerId,
        serviceId: slot.serviceId,
        slotId: slot.id,
        status: 'PENDING_CONFIRMATION',
        // Snapshot the service price at booking time.
        bookedPrice: service.price,
        customerNote: dto.customerNote ?? null,
      });
      const savedBooking = await bookingsRepository.save(booking);

      slot.bookedCount += 1;
      await slotsRepository.save(slot);

      await bookingLogsRepository.save(
        bookingLogsRepository.create({
          bookingId: savedBooking.id,
          oldStatus: null,
          newStatus: 'PENDING_CONFIRMATION',
          changedBy: customerId,
          reason: null,
        }),
      );

      return savedBooking;
    });
  }

  async getMyBookings(customerId: string) {
    const bookingsRepository = this.dataSource.getRepository(Booking);

    return bookingsRepository.find({
      where: { customerId },
      relations: {
        pet: true,
        provider: true,
        service: true,
        slot: true,
      },
      order: { createdAt: 'DESC' },
    });
  }

  async getMyBookingById(customerId: string, bookingId: string) {
    const bookingsRepository = this.dataSource.getRepository(Booking);
    const booking = await bookingsRepository.findOne({
      where: { id: bookingId },
      relations: {
        pet: true,
        provider: true,
        service: true,
        slot: true,
        statusLogs: true,
      },
    });

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    if (booking.customerId !== customerId) {
      throw new ForbiddenException(
        'You do not have permission to access this booking',
      );
    }

    booking.statusLogs.sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    );

    return booking;
  }

  async getProviderBookings(user: AuthenticatedUser) {
    const providerId = await this.resolveManagedProviderId(user);
    const bookingsRepository = this.dataSource.getRepository(Booking);

    return bookingsRepository.find({
      where: { providerId },
      relations: {
        pet: true,
        service: true,
        slot: true,
      },
      order: { createdAt: 'DESC' },
    });
  }

  async getProviderBookingById(
    user: AuthenticatedUser,
    bookingId: string,
  ) {
    const providerId = await this.resolveManagedProviderId(user);
    const bookingsRepository = this.dataSource.getRepository(Booking);
    const booking = await bookingsRepository.findOne({
      where: { id: bookingId },
      relations: {
        pet: true,
        service: true,
        slot: true,
        statusLogs: true,
      },
    });

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    this.assertProviderCanManageBooking(booking, providerId);

    booking.statusLogs.sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    );

    return booking;
  }

  async confirmProviderBooking(
    user: AuthenticatedUser,
    bookingId: string,
  ) {
    return this.dataSource.transaction(async (manager) => {
      const providerId = await this.resolveManagedProviderId(user, manager);
      const bookingsRepository = manager.getRepository(Booking);
      const bookingLogsRepository =
        manager.getRepository(BookingStatusLog);
      const booking = await this.findLockedBooking(
        manager,
        bookingId,
      );

      this.assertProviderCanManageBooking(booking, providerId);
      this.assertPendingConfirmation(booking);

      booking.status = 'CONFIRMED';
      const savedBooking = await bookingsRepository.save(booking);

      await bookingLogsRepository.save(
        bookingLogsRepository.create({
          bookingId: savedBooking.id,
          oldStatus: 'PENDING_CONFIRMATION',
          newStatus: 'CONFIRMED',
          changedBy: user.id,
          reason: null,
        }),
      );

      return savedBooking;
    });
  }

  async cancelMyBooking(
    customerId: string,
    bookingId: string,
    dto?: CancelBookingDto,
  ) {
    return this.dataSource.transaction(async (manager) => {
      const bookingsRepository = manager.getRepository(Booking);
      const bookingLogsRepository =
        manager.getRepository(BookingStatusLog);
      const slotsRepository = manager.getRepository(AvailabilitySlot);
      const booking = await this.findLockedBooking(manager, bookingId);

      this.assertCustomerOwnsBooking(booking, customerId);
      const oldStatus = this.getCancellableStatus(booking);
      const slot = await this.findLockedSlot(manager, booking.slotId);

      this.releaseReservedSlotCapacity(slot);
      booking.status = 'CANCELLED';

      const savedBooking = await bookingsRepository.save(booking);
      await slotsRepository.save(slot);
      await bookingLogsRepository.save(
        bookingLogsRepository.create({
          bookingId: savedBooking.id,
          oldStatus,
          newStatus: 'CANCELLED',
          changedBy: customerId,
          reason: dto?.reason ?? null,
        }),
      );

      return savedBooking;
    });
  }

  async rejectProviderBooking(
    user: AuthenticatedUser,
    bookingId: string,
    dto?: RejectBookingDto,
  ) {
    return this.dataSource.transaction(async (manager) => {
      const providerId = await this.resolveManagedProviderId(user, manager);
      const bookingsRepository = manager.getRepository(Booking);
      const bookingLogsRepository =
        manager.getRepository(BookingStatusLog);
      const slotsRepository = manager.getRepository(AvailabilitySlot);
      const booking = await this.findLockedBooking(
        manager,
        bookingId,
      );

      this.assertProviderCanManageBooking(booking, providerId);
      this.assertPendingConfirmation(booking);

      const slot = await this.findLockedSlot(manager, booking.slotId);

      booking.status = 'REJECTED';
      this.releaseReservedSlotCapacity(slot);

      const savedBooking = await bookingsRepository.save(booking);
      await slotsRepository.save(slot);
      await bookingLogsRepository.save(
        bookingLogsRepository.create({
          bookingId: savedBooking.id,
          oldStatus: 'PENDING_CONFIRMATION',
          newStatus: 'REJECTED',
          changedBy: user.id,
          reason: dto?.reason ?? null,
        }),
      );

      return savedBooking;
    });
  }

  async completeProviderBooking(
    user: AuthenticatedUser,
    bookingId: string,
  ) {
    return this.transitionConfirmedProviderBooking(
      user,
      bookingId,
      'COMPLETED',
      null,
    );
  }

  async noShowProviderBooking(
    user: AuthenticatedUser,
    bookingId: string,
    dto?: NoShowBookingDto,
  ) {
    return this.transitionConfirmedProviderBooking(
      user,
      bookingId,
      'NO_SHOW',
      dto?.reason ?? null,
    );
  }

  private async resolveManagedProviderId(
    user: AuthenticatedUser,
    manager: EntityManager = this.dataSource.manager,
  ): Promise<string> {
    const providersRepository = manager.getRepository(Provider);

    if (user.role === 'PROVIDER_OWNER') {
      const provider = await providersRepository.findOne({
        where: { ownerId: user.id },
      });

      if (!provider) {
        throw new NotFoundException('Provider profile not found');
      }

      return provider.id;
    }

    if (user.role === 'PROVIDER_STAFF') {
      const staffRepository = manager.getRepository(ProviderStaff);
      const staff = await staffRepository.findOne({
        where: { userId: user.id, status: 'ACTIVE' },
      });

      if (!staff) {
        throw new ForbiddenException(
          'Active provider staff association is required',
        );
      }

      return staff.providerId;
    }

    throw new ForbiddenException(
      'You do not have permission to manage provider bookings',
    );
  }

  private async transitionConfirmedProviderBooking(
    user: AuthenticatedUser,
    bookingId: string,
    newStatus: 'COMPLETED' | 'NO_SHOW',
    reason: string | null,
  ) {
    return this.dataSource.transaction(async (manager) => {
      const providerId = await this.resolveManagedProviderId(user, manager);
      const bookingsRepository = manager.getRepository(Booking);
      const bookingLogsRepository =
        manager.getRepository(BookingStatusLog);
      const booking = await this.findLockedBooking(manager, bookingId);

      this.assertProviderCanManageBooking(booking, providerId);
      this.assertConfirmedBooking(booking);

      booking.status = newStatus;
      const savedBooking = await bookingsRepository.save(booking);
      await bookingLogsRepository.save(
        bookingLogsRepository.create({
          bookingId: savedBooking.id,
          oldStatus: 'CONFIRMED',
          newStatus,
          changedBy: user.id,
          reason,
        }),
      );

      return savedBooking;
    });
  }

  private async findLockedBooking(
    manager: EntityManager,
    bookingId: string,
  ): Promise<Booking> {
    const booking = await manager
      .getRepository(Booking)
      .createQueryBuilder('booking')
      .setLock('pessimistic_write')
      .where('booking.id = :bookingId', { bookingId })
      .getOne();

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    return booking;
  }

  private assertProviderCanManageBooking(
    booking: Booking,
    providerId: string,
  ): void {
    if (booking.providerId !== providerId) {
      throw new ForbiddenException(
        'You do not have permission to access this booking',
      );
    }
  }

  private assertCustomerOwnsBooking(
    booking: Booking,
    customerId: string,
  ): void {
    if (booking.customerId !== customerId) {
      throw new ForbiddenException(
        'You do not have permission to access this booking',
      );
    }
  }

  private assertPendingConfirmation(booking: Booking): void {
    if (booking.status !== 'PENDING_CONFIRMATION') {
      throw new ConflictException(
        'Only a pending confirmation booking can be updated',
      );
    }
  }

  private assertConfirmedBooking(booking: Booking): void {
    if (booking.status !== 'CONFIRMED') {
      throw new ConflictException(
        'Only a confirmed booking can be updated',
      );
    }
  }

  private getCancellableStatus(
    booking: Booking,
  ): 'PENDING_CONFIRMATION' | 'CONFIRMED' {
    if (
      booking.status !== 'PENDING_CONFIRMATION' &&
      booking.status !== 'CONFIRMED'
    ) {
      throw new ConflictException(
        'Only pending confirmation or confirmed bookings can be cancelled',
      );
    }

    return booking.status;
  }

  private async findLockedSlot(
    manager: EntityManager,
    slotId: string,
  ): Promise<AvailabilitySlot> {
    const slot = await manager
      .getRepository(AvailabilitySlot)
      .createQueryBuilder('slot')
      .setLock('pessimistic_write')
      .where('slot.id = :slotId', { slotId })
      .getOne();

    if (!slot) {
      throw new NotFoundException('Availability slot not found');
    }

    return slot;
  }

  private releaseReservedSlotCapacity(slot: AvailabilitySlot): void {
    if (slot.bookedCount <= 0) {
      throw new ConflictException(
        'Availability slot has no reserved capacity to release',
      );
    }

    slot.bookedCount -= 1;
  }

  private assertSlotNotInPast(slot: AvailabilitySlot): void {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const today = `${year}-${month}-${day}`;

    if (slot.slotDate < today) {
      throw new BadRequestException(
        'The selected availability slot is in the past',
      );
    }

    if (slot.slotDate === today) {
      const hour = String(now.getHours()).padStart(2, '0');
      const minute = String(now.getMinutes()).padStart(2, '0');
      const currentTime = `${hour}:${minute}`;

      if (slot.startTime <= currentTime) {
        throw new BadRequestException(
          'The selected availability slot has already started',
        );
      }
    }
  }
}
