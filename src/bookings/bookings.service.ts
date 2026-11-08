import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager, type FindOptionsRelations } from 'typeorm';

import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { AvailabilitySlot } from '../availability/entities/availability-slot.entity';
import {
  captureSchedulingClock,
  getDayOfWeek,
  hasSlotStarted,
  type SchedulingClock,
  slotCoversServiceDuration,
  slotFitsWorkingHours,
} from '../availability/slot-eligibility';
import { Pet } from '../pets/entities/pet.entity';
import { ProviderWorkingHour } from '../providers/entities/provider-working-hour.entity';
import { Provider } from '../providers/entities/provider.entity';
import { ProviderStaff } from '../providers/entities/provider-staff.entity';
import { assertProviderCanConfirmBookings } from '../providers/provider-lifecycle.policy';
import { Service } from '../services/entities/service.entity';
import { fingerprintCreateBookingRequest } from './booking-idempotency';
import { CancelBookingDto } from './dto/cancel-booking.dto';
import { CreateBookingDto } from './dto/create-booking.dto';
import { NoShowBookingDto } from './dto/no-show-booking.dto';
import { RejectBookingDto } from './dto/reject-booking.dto';
import { BookingIdempotencyKey } from './entities/booking-idempotency-key.entity';
import { BookingStatusLog } from './entities/booking-status-log.entity';
import { Booking } from './entities/booking.entity';

/** Relations read by the customer booking view (P2-08B). */
const CUSTOMER_BOOKING_RELATIONS: FindOptionsRelations<Booking> = {
  pet: { petType: true },
  provider: true,
  service: true,
  slot: true,
};

export interface IdempotentBookingResult {
  booking: Booking;
  /** True when the booking was created by an earlier request with the key. */
  replayed: boolean;
}

@Injectable()
export class BookingsService {
  constructor(private readonly dataSource: DataSource) {}

  async createBooking(
    customerId: string,
    dto: CreateBookingDto,
    now: Date = new Date(),
  ) {
    // One time reference for every eligibility check in this booking.
    const clock = captureSchedulingClock(now);

    return this.dataSource.transaction((manager) =>
      this.insertBooking(manager, customerId, dto, clock),
    );
  }

  /**
   * P2-07: `POST /bookings` with an `Idempotency-Key` header.
   *
   * The key row is inserted first, in the same transaction as the booking.
   * `uq_booking_idempotency_customer_key` makes a concurrent request with the
   * same customer and key wait on that insert until this transaction ends:
   * - commit: the waiter's `ON CONFLICT DO NOTHING` inserts nothing and it
   *   replays the stored booking (or gets 409 for a different payload);
   * - rollback: the key row disappears with the booking, so the waiter
   *   acquires the key and runs the booking itself. Failures are never
   *   stored, and their errors are reproduced by re-running the request.
   *
   * Lock order is key -> slot -> provider. No other path locks a key, so
   * this cannot deadlock with the legacy slot -> provider order.
   */
  async createBookingIdempotently(
    customerId: string,
    dto: CreateBookingDto,
    idempotencyKey: string,
    now: Date = new Date(),
  ): Promise<IdempotentBookingResult> {
    const clock = captureSchedulingClock(now);
    const requestFingerprint = fingerprintCreateBookingRequest(dto);

    return this.dataSource.transaction(async (manager) => {
      const keysRepository = manager.getRepository(BookingIdempotencyKey);
      const acquired = await keysRepository
        .createQueryBuilder()
        .insert()
        .values({
          customerId,
          idempotencyKey,
          requestFingerprint,
          bookingId: null,
        })
        // booking_id is still NULL, so the only possible conflict is
        // (customer_id, idempotency_key).
        .orIgnore()
        .returning(['id'])
        .execute();
      const keyId = (acquired.raw as Array<{ id: string }>)[0]?.id;

      if (keyId === undefined) {
        return {
          booking: await this.findIdempotentBooking(
            manager,
            customerId,
            idempotencyKey,
            requestFingerprint,
          ),
          replayed: true,
        };
      }

      const booking = await this.insertBooking(
        manager,
        customerId,
        dto,
        clock,
      );
      await keysRepository.update({ id: keyId }, { bookingId: booking.id });

      return { booking, replayed: false };
    });
  }

  private async findIdempotentBooking(
    manager: EntityManager,
    customerId: string,
    idempotencyKey: string,
    requestFingerprint: string,
  ): Promise<Booking> {
    // READ COMMITTED: this statement sees the row whose commit made the
    // insert above a no-op.
    const storedKey = await manager
      .getRepository(BookingIdempotencyKey)
      .findOne({ where: { customerId, idempotencyKey } });

    if (!storedKey?.bookingId) {
      throw new ConflictException(
        'A booking request with this Idempotency-Key is still being processed; retry the same request',
      );
    }

    if (storedKey.requestFingerprint !== requestFingerprint) {
      throw new ConflictException(
        'This Idempotency-Key was already used for a different booking request',
      );
    }

    // Keys are customer-scoped, so this only ever returns the caller's own
    // booking, in its current state (no eligibility checks are repeated).
    const booking = await manager.getRepository(Booking).findOne({
      where: { id: storedKey.bookingId, customerId },
      relations: CUSTOMER_BOOKING_RELATIONS,
    });

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    return booking;
  }

  // Booking creation body; runs inside the caller's transaction.
  private async insertBooking(
    manager: EntityManager,
    customerId: string,
    dto: CreateBookingDto,
    clock: SchedulingClock,
  ): Promise<Booking> {
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
      relations: { petType: true },
    });

    if (!pet) {
      throw new NotFoundException(
        'Active pet belonging to the customer was not found',
      );
    }

    // FOR SHARE: the service duration cannot change until this booking
    // commits (service updates take FOR UPDATE on the row, P2-08A). Taken
    // before the read below so that read sees the post-wait row.
    await servicesRepository.findOne({
      where: {
        id: slot.serviceId,
        providerId: slot.providerId,
      },
      lock: { mode: 'pessimistic_read' },
    });

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

    // FOR SHARE: approval status and working hours cannot change until
    // this booking commits (suspension and working-hour edits take
    // FOR UPDATE on the provider row). Lock order is
    // slot -> service -> provider.
    const provider = await providersRepository.findOne({
      where: { id: slot.providerId },
      lock: { mode: 'pessimistic_read' },
    });

    if (!provider) {
      throw new NotFoundException('Provider not found');
    }

    if (provider.approvalStatus !== 'APPROVED') {
      throw new BadRequestException(
        'The selected provider is not approved for booking',
      );
    }

    this.assertSlotNotStarted(slot, clock);

    const workingIntervals = await manager
      .getRepository(ProviderWorkingHour)
      .find({
        where: {
          providerId: slot.providerId,
          dayOfWeek: getDayOfWeek(slot.slotDate),
          isActive: true,
        },
      });

    if (!slotFitsWorkingHours(slot, workingIntervals)) {
      throw new ConflictException(
        "The selected availability slot is outside the provider's working hours",
      );
    }

    if (!slotCoversServiceDuration(slot, service.durationMinutes)) {
      throw new ConflictException(
        'The selected availability slot is shorter than the service duration',
      );
    }

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

    // Relations of the customer booking view, all loaded above (P2-08B).
    savedBooking.pet = pet;
    savedBooking.provider = provider;
    savedBooking.service = service;
    savedBooking.slot = slot;

    return savedBooking;
  }

  async getMyBookings(customerId: string) {
    const bookingsRepository = this.dataSource.getRepository(Booking);

    return bookingsRepository.find({
      where: { customerId },
      relations: CUSTOMER_BOOKING_RELATIONS,
      order: { createdAt: 'DESC' },
    });
  }

  async getMyBookingById(customerId: string, bookingId: string) {
    const bookingsRepository = this.dataSource.getRepository(Booking);
    const booking = await bookingsRepository.findOne({
      where: { id: bookingId },
      relations: { ...CUSTOMER_BOOKING_RELATIONS, statusLogs: true },
    });

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    if (booking.customerId !== customerId) {
      throw new NotFoundException('Booking not found');
    }

    return booking;
  }

  async getProviderBookings(user: AuthenticatedUser) {
    const providerId = await this.resolveManagedProviderId(user);

    return this.createProviderBookingQuery()
      .where('booking.providerId = :providerId', { providerId })
      .orderBy('booking.createdAt', 'DESC')
      .getMany();
  }

  async getProviderBookingById(
    user: AuthenticatedUser,
    bookingId: string,
  ) {
    const providerId = await this.resolveManagedProviderId(user);
    const booking = await this.createProviderBookingQuery()
      .leftJoinAndSelect('booking.statusLogs', 'statusLog')
      .where('booking.id = :bookingId', { bookingId })
      .getOne();

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    this.assertProviderCanManageBooking(booking, providerId);

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
      await this.assertProviderCanConfirm(manager, providerId);
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

      return this.findProviderBookingView(manager, savedBooking.id);
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

      return this.findCustomerBookingView(manager, savedBooking.id);
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

      return this.findProviderBookingView(manager, savedBooking.id);
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

      return this.findProviderBookingView(manager, savedBooking.id);
    });
  }

  /**
   * Relations of the provider booking view (P2-08B). Only the customer's ID
   * and full name are selected, so account data (credentials, email, phone)
   * is never even read.
   */
  private createProviderBookingQuery(
    manager: EntityManager = this.dataSource.manager,
  ) {
    return manager
      .getRepository(Booking)
      .createQueryBuilder('booking')
      .innerJoin('booking.customer', 'customer')
      .addSelect(['customer.id', 'customer.fullName'])
      .innerJoinAndSelect('booking.pet', 'pet')
      .innerJoinAndSelect('pet.petType', 'petType')
      .innerJoinAndSelect('booking.service', 'service')
      .innerJoinAndSelect('booking.slot', 'slot');
  }

  // Re-read inside the action's transaction, so the response is the
  // state this action commits.
  private findProviderBookingView(
    manager: EntityManager,
    bookingId: string,
  ): Promise<Booking> {
    return this.createProviderBookingQuery(manager)
      .where('booking.id = :bookingId', { bookingId })
      .getOneOrFail();
  }

  private findCustomerBookingView(
    manager: EntityManager,
    bookingId: string,
  ): Promise<Booking> {
    return manager.getRepository(Booking).findOneOrFail({
      where: { id: bookingId },
      relations: CUSTOMER_BOOKING_RELATIONS,
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

  /**
   * P2-09A: only an APPROVED provider (owner or active staff) may confirm.
   *
   * FOR SHARE on the provider row serializes this with admin suspension,
   * which takes FOR UPDATE on it: a suspension committed first is seen here
   * (403), and a suspension started later waits until this confirmation
   * commits. Lock order is booking -> provider, the same as review creation;
   * no path locks a provider and then a booking.
   */
  private async assertProviderCanConfirm(
    manager: EntityManager,
    providerId: string,
  ): Promise<void> {
    const provider = await manager.getRepository(Provider).findOne({
      where: { id: providerId },
      lock: { mode: 'pessimistic_read' },
    });

    if (!provider) {
      throw new NotFoundException('Provider profile not found');
    }

    assertProviderCanConfirmBookings(provider);
  }

  // C-01: another provider's or customer's booking is indistinguishable
  // from a missing one. Role and staff-association failures remain 403.
  private assertProviderCanManageBooking(
    booking: Booking,
    providerId: string,
  ): void {
    if (booking.providerId !== providerId) {
      throw new NotFoundException('Booking not found');
    }
  }

  private assertCustomerOwnsBooking(
    booking: Booking,
    customerId: string,
  ): void {
    if (booking.customerId !== customerId) {
      throw new NotFoundException('Booking not found');
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

  /**
   * A slot is bookable only while its start instant is strictly after the
   * captured clock (chronological comparison with seconds and milliseconds,
   * not a string comparison). No minimum lead time applies.
   */
  private assertSlotNotStarted(
    slot: AvailabilitySlot,
    clock: SchedulingClock,
  ): void {
    if (slot.slotDate < clock.today) {
      throw new BadRequestException(
        'The selected availability slot is in the past',
      );
    }

    if (hasSlotStarted(slot, clock)) {
      throw new BadRequestException(
        'The selected availability slot has already started',
      );
    }
  }
}
