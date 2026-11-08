import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  In,
  MoreThanOrEqual,
  Repository,
} from 'typeorm';

import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import {
  captureSchedulingClock,
  findOverlappingWorkingInterval,
  slotFitsWorkingHours,
} from '../availability/slot-eligibility';
import { Booking } from '../bookings/entities/booking.entity';
import {
  assertStartTimeBeforeEndTime,
  parseTimeOfDayToSeconds,
} from '../common/utils/time-of-day.util';
import {
  assertProviderCanManageResources,
  assertProviderCanUpdateProfile,
} from './provider-lifecycle.policy';
import { User } from '../users/entities/user.entity';
import { CreateProviderStaffDto } from './dto/create-provider-staff.dto';
import { CreateProviderDto } from './dto/create-provider.dto';
import { UpdateProviderStaffDto } from './dto/update-provider-staff.dto';
import { UpdateProviderDto } from './dto/update-provider.dto';
import { ProviderStaff } from './entities/provider-staff.entity';
import { Provider } from './entities/provider.entity';
import { CreateProviderWorkingHourDto } from './dto/create-provider-working-hour.dto';
import { UpdateProviderWorkingHourDto } from './dto/update-provider-working-hour.dto';
import { ProviderWorkingHour } from './entities/provider-working-hour.entity';

const ACTIVE_BOOKING_STATUSES: Booking['status'][] = [
  'PENDING_CONFIRMATION',
  'CONFIRMED',
];

@Injectable()
export class ProvidersService {
  constructor(
    @InjectRepository(Provider)
    private readonly providersRepository: Repository<Provider>,

    @InjectRepository(ProviderStaff)
    private readonly providerStaffRepository: Repository<ProviderStaff>,

    @InjectRepository(ProviderWorkingHour)
    private readonly providerWorkingHoursRepository: Repository<ProviderWorkingHour>,

    private readonly dataSource: DataSource,
  ) {}

  async createMyProvider(
    user: AuthenticatedUser,
    createProviderDto: CreateProviderDto,
  ) {
    const existingProvider =
      await this.providersRepository.findOne({
        where: {
          ownerId: user.id,
        },
      });

    if (existingProvider) {
      throw new ConflictException(
        'Provider profile already exists for this account',
      );
    }

    try {
      return await this.dataSource.transaction(
        async (manager) => {
          const usersRepository =
            manager.getRepository(User);

          const providersRepository =
            manager.getRepository(Provider);

          const currentUser =
            await usersRepository.findOne({
              where: {
                id: user.id,
              },
            });

          if (!currentUser) {
            throw new NotFoundException(
              'User account not found',
            );
          }

          const provider =
            providersRepository.create({
              ownerId: currentUser.id,
              businessName:
                createProviderDto.businessName,
              address: createProviderDto.address,
              phone:
                createProviderDto.phone ?? null,
              description:
                createProviderDto.description ?? null,
              approvalStatus: 'PENDING',
              ratingAvg: '0',
              ratingCount: 0,
            });

          const savedProvider =
            await providersRepository.save(provider);

          currentUser.role = 'PROVIDER_OWNER';

          await usersRepository.save(currentUser);

          return savedProvider;
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
          'Provider profile already exists for this account',
        );
      }

      throw error;
    }
  }

  async getMyProvider(userId: string) {
    const provider =
      await this.providersRepository.findOne({
        where: {
          ownerId: userId,
        },
      });

    if (!provider) {
      throw new NotFoundException(
        'Provider profile not found',
      );
    }

    return provider;
  }

  async updateMyProvider(
    userId: string,
    updateProviderDto: UpdateProviderDto,
  ) {
    const provider =
      await this.providersRepository.findOne({
        where: {
          ownerId: userId,
        },
      });

    if (!provider) {
      throw new NotFoundException(
        'Provider profile not found',
      );
    }

    assertProviderCanUpdateProfile(provider);

    if (
      updateProviderDto.businessName !== undefined
    ) {
      provider.businessName =
        updateProviderDto.businessName;
    }

    if (updateProviderDto.address !== undefined) {
      provider.address =
        updateProviderDto.address;
    }

    if (updateProviderDto.phone !== undefined) {
      provider.phone =
        updateProviderDto.phone ?? null;
    }

    if (
      updateProviderDto.description !== undefined
    ) {
      provider.description =
        updateProviderDto.description ?? null;
    }

    return this.providersRepository.save(provider);
  }

  async addMyStaff(
    ownerUserId: string,
    createProviderStaffDto: CreateProviderStaffDto,
  ) {
    try {
      return await this.dataSource.transaction(
        async (manager) => {
          const providersRepository =
            manager.getRepository(Provider);

          const staffRepository =
            manager.getRepository(ProviderStaff);

          const usersRepository =
            manager.getRepository(User);

          const provider =
            await providersRepository.findOne({
              where: {
                ownerId: ownerUserId,
              },
            });

          if (!provider) {
            throw new NotFoundException(
              'Provider profile not found',
            );
          }

          assertProviderCanManageResources(provider);

          if (
            createProviderStaffDto.userId ===
            ownerUserId
          ) {
            throw new BadRequestException(
              'Provider owner cannot be added as provider staff',
            );
          }

          const staffUser =
            await usersRepository.findOne({
              where: {
                id: createProviderStaffDto.userId,
              },
            });

          if (!staffUser) {
            throw new NotFoundException(
              'User account not found',
            );
          }

          if (staffUser.status !== 'ACTIVE') {
            throw new BadRequestException(
              'Only active user accounts can be assigned as provider staff',
            );
          }

          if (staffUser.role !== 'CUSTOMER') {
            throw new ConflictException(
              'Only customer accounts can be assigned as provider staff',
            );
          }

          const existingStaff =
            await staffRepository.findOne({
              where: {
                userId:
                  createProviderStaffDto.userId,
              },
            });

          if (existingStaff) {
            throw new ConflictException(
              'This user is already associated with a provider',
            );
          }

          const staff = staffRepository.create({
            providerId: provider.id,
            userId: staffUser.id,
            position:
              createProviderStaffDto.position ??
              null,
            status: 'ACTIVE',
          });

          const savedStaff =
            await staffRepository.save(staff);

          staffUser.role = 'PROVIDER_STAFF';

          await usersRepository.save(staffUser);

          return savedStaff;
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
          'This user is already associated with a provider',
        );
      }

      throw error;
    }
  }

  async getMyStaff(ownerUserId: string) {
    const provider =
      await this.getMyProvider(ownerUserId);

    return this.providerStaffRepository.find({
      where: {
        providerId: provider.id,
      },
      order: {
        createdAt: 'DESC',
      },
    });
  }

  async getMyStaffById(
    ownerUserId: string,
    staffId: string,
  ) {
    const provider =
      await this.getMyProvider(ownerUserId);

    // Scoped to the caller's provider: another provider's staff record is
    // indistinguishable from a missing one (C-01).
    const staff =
      await this.providerStaffRepository.findOne({
        where: {
          id: staffId,
          providerId: provider.id,
        },
      });

    if (!staff) {
      throw new NotFoundException(
        'Provider staff record not found',
      );
    }

    return staff;
  }

  async updateMyStaff(
    ownerUserId: string,
    staffId: string,
    updateProviderStaffDto: UpdateProviderStaffDto,
  ) {
    return this.dataSource.transaction(
      async (manager) => {
        const providersRepository =
          manager.getRepository(Provider);

        const staffRepository =
          manager.getRepository(ProviderStaff);

        const usersRepository =
          manager.getRepository(User);

        const provider =
          await providersRepository.findOne({
            where: {
              ownerId: ownerUserId,
            },
          });

        if (!provider) {
          throw new NotFoundException(
            'Provider profile not found',
          );
        }

        assertProviderCanManageResources(provider);

        const staff =
          await staffRepository.findOne({
            where: {
              id: staffId,
              providerId: provider.id,
            },
          });

        if (!staff) {
          throw new NotFoundException(
            'Provider staff record not found',
          );
        }

        const staffUser =
          await usersRepository.findOne({
            where: {
              id: staff.userId,
            },
          });

        if (!staffUser) {
          throw new NotFoundException(
            'Staff user account not found',
          );
        }

        if (
          updateProviderStaffDto.position !==
          undefined
        ) {
          staff.position =
            updateProviderStaffDto.position ??
            null;
        }

        if (
          updateProviderStaffDto.status !==
          undefined
        ) {
          if (
            updateProviderStaffDto.status ===
            'ACTIVE'
          ) {
            if (staffUser.status !== 'ACTIVE') {
              throw new BadRequestException(
                'Inactive user account cannot be activated as provider staff',
              );
            }

            if (
              staffUser.role !== 'CUSTOMER' &&
              staffUser.role !==
                'PROVIDER_STAFF'
            ) {
              throw new ConflictException(
                'User account has an incompatible role',
              );
            }

            staff.status = 'ACTIVE';
            staffUser.role = 'PROVIDER_STAFF';
          }

          if (
            updateProviderStaffDto.status ===
            'INACTIVE'
          ) {
            staff.status = 'INACTIVE';

            if (
              staffUser.role ===
              'PROVIDER_STAFF'
            ) {
              staffUser.role = 'CUSTOMER';
            }
          }
        }

        const savedStaff =
          await staffRepository.save(staff);

        await usersRepository.save(staffUser);

        return savedStaff;
      },
    );
  }

  async deactivateMyStaff(
    ownerUserId: string,
    staffId: string,
  ): Promise<void> {
    await this.dataSource.transaction(
      async (manager) => {
        const providersRepository =
          manager.getRepository(Provider);

        const staffRepository =
          manager.getRepository(ProviderStaff);

        const usersRepository =
          manager.getRepository(User);

        const provider =
          await providersRepository.findOne({
            where: {
              ownerId: ownerUserId,
            },
          });

        if (!provider) {
          throw new NotFoundException(
            'Provider profile not found',
          );
        }

        assertProviderCanManageResources(provider);

        const staff =
          await staffRepository.findOne({
            where: {
              id: staffId,
              providerId: provider.id,
            },
          });

        if (!staff) {
          throw new NotFoundException(
            'Provider staff record not found',
          );
        }

        const staffUser =
          await usersRepository.findOne({
            where: {
              id: staff.userId,
            },
          });

        if (!staffUser) {
          throw new NotFoundException(
            'Staff user account not found',
          );
        }

        staff.status = 'INACTIVE';

        if (
          staffUser.role === 'PROVIDER_STAFF'
        ) {
          staffUser.role = 'CUSTOMER';
        }

        await staffRepository.save(staff);
        await usersRepository.save(staffUser);
      },
    );
  }
  async createMyWorkingHour(
  ownerUserId: string,
  dto: CreateProviderWorkingHourDto,
) {
  const provider = await this.getMyProvider(ownerUserId);

  assertProviderCanManageResources(provider);

  this.assertValidWorkingHourRange(
    dto.startTime,
    dto.endTime,
  );

  try {
    return await this.dataSource.transaction(async (manager) => {
      const workingHoursRepository =
        manager.getRepository(ProviderWorkingHour);

      // P2-09B: the overlap check and the insert are serialized per
      // provider, like every other schedule change.
      await this.lockProviderSchedule(manager, provider.id);

      const workingHour = workingHoursRepository.create({
        providerId: provider.id,
        dayOfWeek: dto.dayOfWeek,
        startTime: dto.startTime,
        endTime: dto.endTime,
        isActive: dto.isActive ?? true,
      });

      if (workingHour.isActive) {
        await this.assertNoActiveOverlap(manager, provider.id, workingHour);
      }

      return workingHoursRepository.save(workingHour);
    });
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === '23505'
    ) {
      throw new ConflictException(
        'This working-hour entry already exists',
      );
    }

    throw error;
  }
}

async getMyWorkingHours(ownerUserId: string) {
  const provider = await this.getMyProvider(ownerUserId);

  return this.providerWorkingHoursRepository.find({
    where: {
      providerId: provider.id,
    },
    order: {
      dayOfWeek: 'ASC',
      startTime: 'ASC',
    },
  });
}

async updateMyWorkingHour(
  ownerUserId: string,
  workingHourId: string,
  dto: UpdateProviderWorkingHourDto,
) {
  const provider = await this.getMyProvider(ownerUserId);

  assertProviderCanManageResources(provider);

  try {
    return await this.dataSource.transaction(async (manager) => {
      const workingHoursRepository =
        manager.getRepository(ProviderWorkingHour);

      await this.lockProviderSchedule(manager, provider.id);

      // Another provider's entry is indistinguishable from a missing one (C-01).
      const workingHour = await workingHoursRepository.findOne({
        where: {
          id: workingHourId,
          providerId: provider.id,
        },
      });

      if (!workingHour) {
        throw new NotFoundException(
          'Provider working-hour record not found',
        );
      }

      const nextDayOfWeek =
        dto.dayOfWeek ?? workingHour.dayOfWeek;

      const nextStartTime =
        dto.startTime ?? workingHour.startTime;

      const nextEndTime =
        dto.endTime ?? workingHour.endTime;

      this.assertValidWorkingHourRange(
        nextStartTime,
        nextEndTime,
      );

      const nextWorkingHour = {
        ...workingHour,
        dayOfWeek: nextDayOfWeek,
        startTime: nextStartTime,
        endTime: nextEndTime,
        isActive: dto.isActive ?? workingHour.isActive,
      };

      // P2-09B: checked when the entry ends up active with a new day or
      // time, or is reactivated. Untouched historical overlaps do not block
      // other edits, and deactivation (the way to resolve them) never does.
      if (
        nextWorkingHour.isActive &&
        (!workingHour.isActive ||
          !this.isSameWorkingInterval(workingHour, nextWorkingHour))
      ) {
        await this.assertNoActiveOverlap(
          manager,
          provider.id,
          nextWorkingHour,
        );
      }

      await this.assertScheduleChangeKeepsActiveBookings(
        manager,
        provider.id,
        workingHour,
        nextWorkingHour,
      );

      return workingHoursRepository.save(
        Object.assign(workingHour, nextWorkingHour),
      );
    });
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === '23505'
    ) {
      throw new ConflictException(
        'This working-hour entry already exists',
      );
    }

    throw error;
  }
}

async deactivateMyWorkingHour(
  ownerUserId: string,
  workingHourId: string,
): Promise<void> {
  const provider = await this.getMyProvider(ownerUserId);

  assertProviderCanManageResources(provider);

  await this.dataSource.transaction(async (manager) => {
    const workingHoursRepository =
      manager.getRepository(ProviderWorkingHour);

    await this.lockProviderSchedule(manager, provider.id);

    const workingHour = await workingHoursRepository.findOne({
      where: {
        id: workingHourId,
        providerId: provider.id,
      },
    });

    if (!workingHour) {
      throw new NotFoundException(
        'Provider working-hour record not found',
      );
    }

    await this.assertScheduleChangeKeepsActiveBookings(
      manager,
      provider.id,
      workingHour,
      { ...workingHour, isActive: false },
    );

    workingHour.isActive = false;

    await workingHoursRepository.save(workingHour);
  });
}

/**
 * Serializes schedule changes with slot writes and booking creation, which
 * hold FOR SHARE on the same provider row while they check working hours.
 */
private async lockProviderSchedule(
  manager: EntityManager,
  providerId: string,
): Promise<void> {
  await manager.getRepository(Provider).findOne({
    where: { id: providerId },
    lock: { mode: 'pessimistic_write' },
  });
}

/**
 * P2-09B: rejects (409) an active entry overlapping another active entry
 * of the same provider and weekday. Must run under `lockProviderSchedule`,
 * so concurrent creates, updates and reactivations cannot both pass the
 * check (no check-then-insert race).
 */
private async assertNoActiveOverlap(
  manager: EntityManager,
  providerId: string,
  candidate: ProviderWorkingHour,
): Promise<void> {
  const others = (
    await manager.getRepository(ProviderWorkingHour).find({
      where: { providerId, dayOfWeek: candidate.dayOfWeek, isActive: true },
    })
  ).filter((interval) => interval.id !== candidate.id);
  const overlapping = findOverlappingWorkingInterval(candidate, others);

  if (overlapping) {
    throw new ConflictException(
      `This working-hour entry overlaps the active entry ${overlapping.startTime}-${overlapping.endTime} on the same day. Adjacent entries are allowed; deactivate or change the other entry first.`,
    );
  }
}

// Same weekday and the same instants (`09:00` equals `09:00:00`).
private isSameWorkingInterval(
  current: ProviderWorkingHour,
  next: ProviderWorkingHour,
): boolean {
  return (
    current.dayOfWeek === next.dayOfWeek &&
    parseTimeOfDayToSeconds(current.startTime) ===
      parseTimeOfDayToSeconds(next.startTime) &&
    parseTimeOfDayToSeconds(current.endTime) ===
      parseTimeOfDayToSeconds(next.endTime)
  );
}

/**
 * Rejects (409) a working-hour change that would leave an active booking
 * outside the provider's working hours. Active means PENDING_CONFIRMATION or
 * CONFIRMED on a slot dated today or later. Only bookings that fit the
 * current schedule but not the changed one count, so a pre-existing
 * out-of-hours booking does not block unrelated edits. Bookings and slots
 * are never modified here; slots without bookings that no longer fit simply
 * stop being bookable and publicly listed.
 */
private async assertScheduleChangeKeepsActiveBookings(
  manager: EntityManager,
  providerId: string,
  current: ProviderWorkingHour,
  next: ProviderWorkingHour,
): Promise<void> {
  if (!current.isActive) {
    // Editing or keeping an inactive entry can only add availability.
    return;
  }

  const activeIntervals = await manager
    .getRepository(ProviderWorkingHour)
    .find({ where: { providerId, isActive: true } });
  const nextIntervals = activeIntervals
    .filter((interval) => interval.id !== current.id)
    .concat(next.isActive ? [next] : []);

  const activeBookings = await manager.getRepository(Booking).find({
    where: {
      providerId,
      status: In(ACTIVE_BOOKING_STATUSES),
      slot: { slotDate: MoreThanOrEqual(captureSchedulingClock().today) },
    },
    relations: { slot: true },
  });

  const invalidated = activeBookings.filter(
    (booking) =>
      slotFitsWorkingHours(booking.slot, activeIntervals) &&
      !slotFitsWorkingHours(booking.slot, nextIntervals),
  );

  if (invalidated.length > 0) {
    throw new ConflictException(
      `This working-hour change would leave ${invalidated.length} active booking(s) outside working hours. Cancel or reschedule them first.`,
    );
  }
}

private assertValidWorkingHourRange(
  startTime: string,
  endTime: string,
): void {
  // Request values use HH:mm while persisted TIME values use HH:mm:ss,
  // so the range must be compared chronologically, not as strings.
  assertStartTimeBeforeEndTime(startTime, endTime);
}
}
