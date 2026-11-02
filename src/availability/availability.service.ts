import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { assertStartTimeBeforeEndTime } from '../common/utils/time-of-day.util';
import { Provider } from '../providers/entities/provider.entity';
import { assertProviderCanManageResources } from '../providers/provider-lifecycle.policy';
import { Service } from '../services/entities/service.entity';
import { CreateAvailabilitySlotDto } from './dto/create-availability-slot.dto';
import { UpdateAvailabilitySlotDto } from './dto/update-availability-slot.dto';
import { AvailabilitySlot } from './entities/availability-slot.entity';

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
  ) {
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

    this.assertDateNotInPast(dto.slotDate);

    try {
      const slot =
        this.availabilitySlotsRepository.create({
          providerId: provider.id,
          serviceId: dto.serviceId,
          slotDate: dto.slotDate,
          startTime: dto.startTime,
          endTime: dto.endTime,
          capacity: dto.capacity,
          bookedCount: 0,
          status: 'OPEN',
        });

      return await this.availabilitySlotsRepository.save(
        slot,
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
  ) {
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
          );

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

    if (scheduleChanged) {
      this.assertDateNotInPast(nextSlotDate);
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
      status: dto.status ?? slot.status,
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

  private assertDateNotInPast(
    slotDate: string,
  ): void {
    const now = new Date();

    const year = now.getFullYear();
    const month = String(
      now.getMonth() + 1,
    ).padStart(2, '0');
    const day = String(
      now.getDate(),
    ).padStart(2, '0');

    const today = `${year}-${month}-${day}`;

    if (slotDate < today) {
      throw new BadRequestException(
        'slotDate cannot be in the past',
      );
    }
  }
  async getPublicSlots() {
  const today = this.getTodayDateString();

  return this.availabilitySlotsRepository
    .createQueryBuilder('slot')
    .innerJoinAndSelect('slot.provider', 'provider')
    .innerJoinAndSelect('slot.service', 'service')
    .innerJoinAndSelect('service.category', 'category')
    .where('slot.status = :slotStatus', {
      slotStatus: 'OPEN',
    })
    .andWhere('slot.bookedCount < slot.capacity')
    .andWhere('slot.slotDate >= :today', {
      today,
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
    .orderBy('slot.slotDate', 'ASC')
    .addOrderBy('slot.startTime', 'ASC')
    .addOrderBy('slot.id', 'ASC')
    .getMany()
    .then((slots) => slots.map((slot) => this.toPublicSlotResponse(slot)));
}

async getPublicSlotById(slotId: string) {
  const today = this.getTodayDateString();

  const slot = await this.availabilitySlotsRepository
    .createQueryBuilder('slot')
    .innerJoinAndSelect('slot.provider', 'provider')
    .innerJoinAndSelect('slot.service', 'service')
    .innerJoinAndSelect('service.category', 'category')
    .where('slot.id = :slotId', {
      slotId,
    })
    .andWhere('slot.status = :slotStatus', {
      slotStatus: 'OPEN',
    })
    .andWhere('slot.bookedCount < slot.capacity')
    .andWhere('slot.slotDate >= :today', {
      today,
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
    .getOne();

  if (!slot) {
    throw new NotFoundException(
      'Available public slot not found',
    );
  }

  return this.toPublicSlotResponse(slot);
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

private getTodayDateString(): string {
  const now = new Date();

  const year = now.getFullYear();
  const month = String(
    now.getMonth() + 1,
  ).padStart(2, '0');
  const day = String(
    now.getDate(),
  ).padStart(2, '0');

  return `${year}-${month}-${day}`;
}
}