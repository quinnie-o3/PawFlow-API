import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';

import {
  buildPaginationMeta,
  toPageOffset,
} from '../common/utils/public-search.util';
import { assertStartTimeBeforeEndTime } from '../common/utils/time-of-day.util';
import { ProviderWorkingHour } from '../providers/entities/provider-working-hour.entity';
import { Provider } from '../providers/entities/provider.entity';
import { assertProviderCanManageResources } from '../providers/provider-lifecycle.policy';
import { Service } from '../services/entities/service.entity';
import { CreateAvailabilitySlotDto } from './dto/create-availability-slot.dto';
import type {
  PublicAvailabilitySearchEcho,
  PublicAvailabilitySearchQueryDto,
} from './dto/public-availability-search-query.dto';
import { UpdateAvailabilitySlotDto } from './dto/update-availability-slot.dto';
import { AvailabilitySlot } from './entities/availability-slot.entity';
import {
  captureSchedulingClock,
  getDayOfWeek,
  hasSlotStarted,
  type SchedulingClock,
  SLOT_COVERS_SERVICE_DURATION_SQL,
  SLOT_NOT_STARTED_SQL,
  SLOT_OUTSIDE_WORKING_HOURS_MESSAGE,
  SLOT_STARTED_MESSAGE,
  SLOT_WITHIN_WORKING_HOURS_SQL,
  type SlotSchedule,
  slotCoversServiceDuration,
  slotFitsWorkingHours,
} from './slot-eligibility';

@Injectable()
export class AvailabilityService {
  constructor(
    @InjectRepository(AvailabilitySlot)
    private readonly availabilitySlotsRepository: Repository<AvailabilitySlot>,

    @InjectRepository(Provider)
    private readonly providersRepository: Repository<Provider>,

    @InjectRepository(Service)
    private readonly servicesRepository: Repository<Service>,
  ) {}

  async createMySlot(
    ownerUserId: string,
    dto: CreateAvailabilitySlotDto,
    now: Date = new Date(),
  ) {
    const clock = captureSchedulingClock(now);
    const provider =
      await this.getProviderByOwner(ownerUserId);

    assertProviderCanManageResources(provider);

    await this.assertOwnedActiveService(
      provider.id,
      dto.serviceId,
    );

    this.assertValidTimeRange(
      dto.startTime,
      dto.endTime,
    );

    this.assertSlotNotStarted(dto, clock);

    try {
      return await this.availabilitySlotsRepository.manager.transaction(
        async (manager) => {
          await this.assertSlotCoversServiceDuration(
            manager,
            provider.id,
            dto.serviceId,
            dto,
          );
          await this.assertSlotWithinWorkingHours(manager, provider.id, dto);

          const slotsRepository =
            manager.getRepository(AvailabilitySlot);
          const slot = slotsRepository.create({
            providerId: provider.id,
            serviceId: dto.serviceId,
            slotDate: dto.slotDate,
            startTime: dto.startTime,
            endTime: dto.endTime,
            capacity: dto.capacity,
            bookedCount: 0,
            status: 'OPEN',
          });

          return slotsRepository.save(slot);
        },
      );
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === '23505'
      ) {
        throw new ConflictException(
          'An identical availability slot already exists',
        );
      }

      throw error;
    }
  }

  async getMySlots(ownerUserId: string) {
    const provider =
      await this.getProviderByOwner(ownerUserId);

    return this.availabilitySlotsRepository.find({
      where: {
        providerId: provider.id,
      },
      relations: {
        service: true,
      },
      order: {
        slotDate: 'ASC',
        startTime: 'ASC',
      },
    });
  }

  async getMySlotById(
    ownerUserId: string,
    slotId: string,
  ) {
    const provider =
      await this.getProviderByOwner(ownerUserId);

    // Scoped to the caller's provider: another provider's slot is
    // indistinguishable from a missing one (C-01).
    const slot =
      await this.availabilitySlotsRepository.findOne({
        where: {
          id: slotId,
          providerId: provider.id,
        },
        relations: {
          service: true,
        },
      });

    if (!slot) {
      throw new NotFoundException(
        'Availability slot not found',
      );
    }

    return slot;
  }

  async updateMySlot(
    ownerUserId: string,
    slotId: string,
    dto: UpdateAvailabilitySlotDto,
    now: Date = new Date(),
  ) {
    const clock = captureSchedulingClock(now);
    const provider =
      await this.getProviderByOwner(ownerUserId);

    assertProviderCanManageResources(provider);

    try {
      return await this.availabilitySlotsRepository.manager.transaction(
        async (manager) => {
          const slotsRepository =
            manager.getRepository(AvailabilitySlot);

          // Same row lock as booking reservation/cancellation, so capacity
          // checks see the latest bookedCount and cannot interleave with
          // a concurrent booking.
          const slot = await this.findLockedSlot(
            slotsRepository,
            slotId,
            provider.id,
          );

          const changes = await this.buildSlotUpdate(
            provider.id,
            slot,
            dto,
            clock,
          );

          // A new service/date/time, or reopening a closed slot, must fit
          // the service duration (P2-08A) and the provider's current
          // working hours (P2-06B). Lock order: slot -> service -> provider,
          // as in booking creation.
          const reopening =
            changes.status === 'OPEN' && slot.status !== 'OPEN';
          const scheduleChanged =
            changes.serviceId !== slot.serviceId ||
            changes.slotDate !== slot.slotDate ||
            changes.startTime !== slot.startTime ||
            changes.endTime !== slot.endTime;

          if (scheduleChanged || reopening) {
            await this.assertSlotCoversServiceDuration(
              manager,
              provider.id,
              changes.serviceId,
              changes,
            );
            await this.assertSlotWithinWorkingHours(
              manager,
              provider.id,
              changes,
            );
          }

          // Partial UPDATE: bookedCount is owned by booking flows and is
          // never written from here.
          await slotsRepository.update({ id: slot.id }, changes);

          return slotsRepository.findOneOrFail({
            where: { id: slot.id },
          });
        },
      );
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === '23505'
      ) {
        throw new ConflictException(
          'An identical availability slot already exists',
        );
      }

      throw error;
    }
  }

  /**
   * Validates a slot update against the locked slot row and returns only
   * the provider-editable columns to persist.
   */
  private async buildSlotUpdate(
    providerId: string,
    slot: AvailabilitySlot,
    dto: UpdateAvailabilitySlotDto,
    clock: SchedulingClock,
  ): Promise<
    Pick<
      AvailabilitySlot,
      | 'serviceId'
      | 'slotDate'
      | 'startTime'
      | 'endTime'
      | 'capacity'
      | 'status'
    >
  > {
    const scheduleChanged =
      dto.serviceId !== undefined ||
      dto.slotDate !== undefined ||
      dto.startTime !== undefined ||
      dto.endTime !== undefined;

    /*
     * Once bookings exist, changing the service/date/time would
     * alter the meaning of an already-booked appointment.
     */
    if (
      slot.bookedCount > 0 &&
      scheduleChanged
    ) {
      throw new ConflictException(
        'Cannot change service, date, or time of a slot that already has bookings',
      );
    }

    const nextServiceId =
      dto.serviceId ?? slot.serviceId;

    const nextSlotDate =
      dto.slotDate ?? slot.slotDate;

    const nextStartTime =
      dto.startTime ?? slot.startTime;

    const nextEndTime =
      dto.endTime ?? slot.endTime;

    const nextCapacity =
      dto.capacity ?? slot.capacity;

    if (dto.serviceId !== undefined) {
      await this.assertOwnedActiveService(
        providerId,
        nextServiceId,
      );
    }

    this.assertValidTimeRange(
      nextStartTime,
      nextEndTime,
    );

    const nextStatus = dto.status ?? slot.status;

    // Moving a slot, or reopening one, must produce a slot that has not
    // started (P2-08A). Closing or cancelling a past slot stays allowed.
    if (
      scheduleChanged ||
      (nextStatus === 'OPEN' && slot.status !== 'OPEN')
    ) {
      this.assertSlotNotStarted(
        {
          slotDate: nextSlotDate,
          startTime: nextStartTime,
        },
        clock,
      );
    }

    if (nextCapacity < slot.bookedCount) {
      throw new ConflictException(
        'capacity cannot be lower than bookedCount',
      );
    }

    return {
      serviceId: nextServiceId,
      slotDate: nextSlotDate,
      startTime: nextStartTime,
      endTime: nextEndTime,
      capacity: nextCapacity,
      status: nextStatus,
    };
  }

  async deactivateMySlot(
    ownerUserId: string,
    slotId: string,
  ): Promise<void> {
    const provider =
      await this.getProviderByOwner(ownerUserId);

    assertProviderCanManageResources(provider);

    await this.availabilitySlotsRepository.manager.transaction(
      async (manager) => {
        const slotsRepository =
          manager.getRepository(AvailabilitySlot);
        const slot = await this.findLockedSlot(
          slotsRepository,
          slotId,
          provider.id,
        );

        // Soft deactivate. Never delete booking-related slot history.
        // Only status is written so a concurrent bookedCount is preserved.
        await slotsRepository.update(
          { id: slot.id },
          { status: 'CANCELLED' },
        );
      },
    );
  }

  /**
   * Rejects with 409 unless the slot is at least as long as its service
   * (P2-08A).
   *
   * Holds a FOR SHARE lock on the service row until the transaction ends.
   * Service updates lock the same row FOR UPDATE before checking booked
   * slots, so a duration change cannot interleave with this check and the
   * slot write.
   */
  private async assertSlotCoversServiceDuration(
    manager: EntityManager,
    providerId: string,
    serviceId: string,
    schedule: Pick<SlotSchedule, 'startTime' | 'endTime'>,
  ): Promise<void> {
    const service = await manager.getRepository(Service).findOne({
      where: { id: serviceId, providerId },
      lock: { mode: 'pessimistic_read' },
    });

    if (!service) {
      throw new NotFoundException(
        'Service not found',
      );
    }

    if (!slotCoversServiceDuration(schedule, service.durationMinutes)) {
      throw new ConflictException(
        `The slot must last at least ${service.durationMinutes} minutes, the duration of its service`,
      );
    }
  }

  /**
   * Rejects with 409 unless the slot fits entirely inside one active
   * working interval of its weekday.
   *
   * Holds a FOR SHARE lock on the provider row until the transaction ends.
   * Working-hour changes take FOR UPDATE on the same row, so a schedule
   * change cannot interleave with this check and the slot write.
   */
  private async assertSlotWithinWorkingHours(
    manager: EntityManager,
    providerId: string,
    schedule: SlotSchedule,
  ): Promise<void> {
    await manager.getRepository(Provider).findOne({
      where: { id: providerId },
      lock: { mode: 'pessimistic_read' },
    });

    const intervals = await manager.getRepository(ProviderWorkingHour).find({
      where: {
        providerId,
        dayOfWeek: getDayOfWeek(schedule.slotDate),
        isActive: true,
      },
    });

    if (!slotFitsWorkingHours(schedule, intervals)) {
      throw new ConflictException(SLOT_OUTSIDE_WORKING_HOURS_MESSAGE);
    }
  }

  /**
   * Locks the caller's own slot. Scoping by provider means another
   * provider's slot is never locked and yields the same 404 as a missing
   * slot (C-01).
   */
  private async findLockedSlot(
    slotsRepository: Repository<AvailabilitySlot>,
    slotId: string,
    providerId: string,
  ): Promise<AvailabilitySlot> {
    const slot = await slotsRepository
      .createQueryBuilder('slot')
      .setLock('pessimistic_write')
      .where('slot.id = :slotId', { slotId })
      .andWhere('slot.providerId = :providerId', { providerId })
      .getOne();

    if (!slot) {
      throw new NotFoundException(
        'Availability slot not found',
      );
    }

    return slot;
  }

  private async getProviderByOwner(
    ownerUserId: string,
  ): Promise<Provider> {
    const provider =
      await this.providersRepository.findOne({
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

  private async assertOwnedActiveService(
    providerId: string,
    serviceId: string,
  ): Promise<Service> {
    // Another provider's service is indistinguishable from a missing one.
    const service =
      await this.servicesRepository.findOne({
        where: {
          id: serviceId,
          providerId,
        },
      });

    if (!service) {
      throw new NotFoundException(
        'Service not found',
      );
    }

    if (service.status !== 'ACTIVE') {
      throw new BadRequestException(
        'Availability slots can only use active services',
      );
    }

    return service;
  }

  private assertValidTimeRange(
    startTime: string,
    endTime: string,
  ): void {
    // Request values use HH:mm while persisted TIME values use HH:mm:ss,
    // so the range must be compared chronologically, not as strings.
    assertStartTimeBeforeEndTime(startTime, endTime);
  }

  /**
   * A slot may only be created, moved or reopened while its start instant
   * is strictly after the captured clock (P2-08A), the same rule booking
   * applies (`hasSlotStarted`). A slot that began earlier in the current
   * minute has started.
   */
  private assertSlotNotStarted(
    schedule: Pick<SlotSchedule, 'slotDate' | 'startTime'>,
    clock: SchedulingClock,
  ): void {
    if (schedule.slotDate < clock.today) {
      throw new BadRequestException(
        'slotDate cannot be in the past',
      );
    }

    if (hasSlotStarted(schedule, clock)) {
      throw new BadRequestException(SLOT_STARTED_MESSAGE);
    }
  }
  async getPublicSlots(now: Date = new Date()) {
  return this.createBookableSlotQuery(now)
    .orderBy('slot.slotDate', 'ASC')
    .addOrderBy('slot.startTime', 'ASC')
    .addOrderBy('slot.id', 'ASC')
    .getMany()
    .then((slots) => slots.map((slot) => this.toPublicSlotResponse(slot)));
}

async getPublicSlotById(slotId: string, now: Date = new Date()) {
  const slot = await this.createBookableSlotQuery(now)
    .andWhere('slot.id = :slotId', {
      slotId,
    })
    .getOne();

  if (!slot) {
    throw new NotFoundException(
      'Available public slot not found',
    );
  }

  return this.toPublicSlotResponse(slot);
}

  /**
   * Public, paginated slot search (`GET /availability/public/search`).
   *
   * Uses the same bookable-slot rules as the public list and detail
   * (`createBookableSlotQuery`). Scope filters only narrow that set, so a
   * hidden or foreign provider/service yields an empty page rather than
   * revealing its existence.
   *
   * Filtering, counting, ordering and pagination run in PostgreSQL. Every
   * join is many-to-one, so LIMIT/OFFSET apply to slot rows directly.
   */
  async searchPublicSlots(
    query: PublicAvailabilitySearchQueryDto,
    now: Date = new Date(),
  ) {
    const builder = this.createBookableSlotQuery(now);

    if (query.providerId !== undefined) {
      builder.andWhere('slot.providerId = :providerId', {
        providerId: query.providerId,
      });
    }

    if (query.serviceId !== undefined) {
      builder.andWhere('slot.serviceId = :serviceId', {
        serviceId: query.serviceId,
      });
    }

    if (query.date !== undefined) {
      builder.andWhere('slot.slotDate = :date', { date: query.date });
    }

    if (query.fromDate !== undefined) {
      builder.andWhere('slot.slotDate >= :fromDate', {
        fromDate: query.fromDate,
      });
    }

    if (query.toDate !== undefined) {
      builder.andWhere('slot.slotDate <= :toDate', { toDate: query.toDate });
    }

    const pageBuilder = builder
      .clone()
      .orderBy('slot.slotDate', 'ASC')
      .addOrderBy('slot.startTime', 'ASC')
      .addOrderBy('slot.id', 'ASC')
      .offset(toPageOffset(query.page, query.limit))
      .limit(query.limit);

    const [totalItems, slots] = await Promise.all([
      builder.getCount(),
      pageBuilder.getMany(),
    ]);

    const echo: PublicAvailabilitySearchEcho = {
      providerId: query.providerId ?? null,
      serviceId: query.serviceId ?? null,
      date: query.date ?? null,
      fromDate: query.fromDate ?? null,
      toDate: query.toDate ?? null,
    };

    return {
      items: slots.map((slot) => this.toPublicSlotResponse(slot)),
      meta: buildPaginationMeta(query.page, query.limit, totalItems),
      query: echo,
    };
  }

/**
 * Slots that booking creation would currently accept (P2-06B), shared by the
 * public list, detail and search:
 * - OPEN with remaining capacity;
 * - APPROVED provider, ACTIVE service and ACTIVE category;
 * - start instant strictly after `now` (server local time, millisecond
 *   precision), the same rule as `hasSlotStarted`;
 * - entirely inside one active working interval of the slot's weekday,
 *   the same rule as `slotFitsWorkingHours`;
 * - at least as long as its service, the same rule as
 *   `slotCoversServiceDuration` (P2-08A).
 */
private createBookableSlotQuery(now: Date) {
  const clock = captureSchedulingClock(now);

  return this.availabilitySlotsRepository
    .createQueryBuilder('slot')
    .innerJoinAndSelect('slot.provider', 'provider')
    .innerJoinAndSelect('slot.service', 'service')
    .innerJoinAndSelect('service.category', 'category')
    .where('slot.status = :slotStatus', {
      slotStatus: 'OPEN',
    })
    .andWhere('slot.bookedCount < slot.capacity')
    .andWhere(SLOT_NOT_STARTED_SQL, {
      today: clock.today,
      currentTime: clock.timeOfDay,
    })
    .andWhere('provider.approvalStatus = :approvalStatus', {
      approvalStatus: 'APPROVED',
    })
    .andWhere('service.status = :serviceStatus', {
      serviceStatus: 'ACTIVE',
    })
    .andWhere('category.status = :categoryStatus', {
      categoryStatus: 'ACTIVE',
    })
    .andWhere(SLOT_WITHIN_WORKING_HOURS_SQL)
    .andWhere(SLOT_COVERS_SERVICE_DURATION_SQL);
}

/**
 * Explicit public projection for slot discovery, shared by list and detail.
 *
 * Exposes scheduling, capacity, catalogue data and the provider's public
 * business profile. Internal fields such as `provider.ownerId`,
 * `provider.approvalStatus`, foreign keys, statuses and audit timestamps are
 * omitted, as is `provider.phone` pending a public contact-data policy.
 */
private toPublicSlotResponse(slot: AvailabilitySlot) {
  return {
    id: slot.id,
    slotDate: slot.slotDate,
    startTime: slot.startTime,
    endTime: slot.endTime,
    capacity: slot.capacity,
    bookedCount: slot.bookedCount,
    service: {
      id: slot.service.id,
      name: slot.service.name,
      description: slot.service.description,
      price: slot.service.price,
      durationMinutes: slot.service.durationMinutes,
      category: {
        id: slot.service.category.id,
        name: slot.service.category.name,
        description: slot.service.category.description,
      },
    },
    provider: {
      id: slot.provider.id,
      businessName: slot.provider.businessName,
      address: slot.provider.address,
      description: slot.provider.description,
      ratingAvg: slot.provider.ratingAvg,
      ratingCount: slot.provider.ratingCount,
    },
  };
}
}