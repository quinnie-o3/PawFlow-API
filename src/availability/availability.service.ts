import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Provider } from '../providers/entities/provider.entity';
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

    const slot =
      await this.availabilitySlotsRepository.findOne({
        where: {
          id: slotId,
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

    if (slot.providerId !== provider.id) {
      throw new ForbiddenException(
        'You do not have permission to access this availability slot',
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

    const slot =
      await this.availabilitySlotsRepository.findOne({
        where: {
          id: slotId,
        },
      });

    if (!slot) {
      throw new NotFoundException(
        'Availability slot not found',
      );
    }

    if (slot.providerId !== provider.id) {
      throw new ForbiddenException(
        'You do not have permission to update this availability slot',
      );
    }

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
        provider.id,
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
      throw new BadRequestException(
        'capacity cannot be lower than bookedCount',
      );
    }

    slot.serviceId = nextServiceId;
    slot.slotDate = nextSlotDate;
    slot.startTime = nextStartTime;
    slot.endTime = nextEndTime;
    slot.capacity = nextCapacity;

    if (dto.status !== undefined) {
      slot.status = dto.status;
    }

    try {
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

  async deactivateMySlot(
    ownerUserId: string,
    slotId: string,
  ): Promise<void> {
    const provider =
      await this.getProviderByOwner(ownerUserId);

    const slot =
      await this.availabilitySlotsRepository.findOne({
        where: {
          id: slotId,
        },
      });

    if (!slot) {
      throw new NotFoundException(
        'Availability slot not found',
      );
    }

    if (slot.providerId !== provider.id) {
      throw new ForbiddenException(
        'You do not have permission to deactivate this availability slot',
      );
    }

    // Soft deactivate. Never delete booking-related slot history.
    slot.status = 'CANCELLED';

    await this.availabilitySlotsRepository.save(
      slot,
    );
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
    const service =
      await this.servicesRepository.findOne({
        where: {
          id: serviceId,
        },
      });

    if (!service) {
      throw new NotFoundException(
        'Service not found',
      );
    }

    if (service.providerId !== providerId) {
      throw new ForbiddenException(
        'The service belongs to another provider',
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
    if (startTime >= endTime) {
      throw new BadRequestException(
        'startTime must be earlier than endTime',
      );
    }
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
    .getMany();
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

  return slot;
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